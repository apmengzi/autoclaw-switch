#!/usr/bin/env node
/**
 * Responses API ⇄ Chat Completions 变换层（Codex 接入用）。
 *
 * 背景：Codex CLI 的 wire_api 只认 "responses"（官方文档：responses is the only
 * supported value），而 WorkBuddy(:7863) 与 Comate(:18774) 的上游只讲 chat
 * completions。本模块把入站 Responses 请求翻译成 chat 请求，再把 chat 结果
 * （流式/非流式）翻译回 Responses 事件流。
 *
 * 谁在用：
 *   - bridge/codex_front.mjs   WorkBuddy 前门：/wb/v1/responses → 上游 /v1/chat/completions
 *   - comate/relay.mjs         原生 /v1/responses 路由（复用 relay 自己的 turnEvents 流水线）
 * AutoClaw(:18766, server_2x.mjs) 与 Qoder(:8791, qoder_proxy.py) 各自已有
 * Responses 实现且真机跑过 Codex，不经本模块。
 *
 * 对标来源（两边都已在真机跑过 Codex，字段逐项对拍）：
 *   - bridge/server_2x.mjs 的 Responses 兼容层（缓冲式回放）
 *   - CC Switch 的 streaming_codex_chat.rs + codex_responses_sse.rs（增量状态机
 *     与事件信封）；本文件里与该参考的每一处精简都有注释说明。
 *
 * 设计不变量：
 *   - 只做格式翻译，不持久化 previous_response_id：Codex 每轮带全量 input
 *   - 每个 SSE 事件同时写 `event: <type>` 与 data 里的 `"type"`（两条路都喂到）
 *   - 输出条目的 id 形状：rs_… / msg_… / fc_… / ctc_… / cmp_…（Codex 按形状识别）
 *   - 上游只给 chat completions，三件事必须由翻译层补齐：推理、工具调用、用量
 *   - 压缩回合（input 末尾 type=compaction_trigger）必须回**恰好一个** compaction
 *     条目，否则 codex-rs 的 collect_compaction_output 直接 Fatal
 */
import { randomUUID, createHash } from "node:crypto";

// ============================================================ 常量与 id

export const RESPONSES_PATHS = ["/v1/responses", "/responses"];
export function isResponsesPath(p) {
  return RESPONSES_PATHS.includes(p);
}

export function newResponseId() {
  return "resp_" + randomUUID().replace(/-/g, "");
}

// 自定义（freeform）工具在 chat 侧的降级形态：参数收口成 {"input": "<原始串>"}
const CUSTOM_TOOL_INPUT_FIELD = "input";
const CUSTOM_TOOL_HEADING = "Original tool definition:";
const CUSTOM_TOOL_INPUT_DESC =
  "Raw string input for the original custom tool. Preserve formatting exactly " +
  "and follow the original tool definition embedded in the description.";
const TOOL_SEARCH_PROXY_NAME = "tool_search";
const CHAT_TOOL_NAME_MAX_LEN = 64;

// 工具参数必须能被 chat 上游解析成对象；上游常见的 400 就是 parameters.type 缺失
const EMPTY_SCHEMA = { type: "object", properties: {} };

export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}
function sortValue(v) {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortValue(v[k]);
    return out;
  }
  return v;
}

/** Codex 的工具名上限对 chat 上游同样有效（>64 的上游直接 400） */
function shortHash(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 8);
}
export function flattenNamespaceToolName(namespace, name) {
  const full = `${namespace}__${name}`;
  if (full.length <= CHAT_TOOL_NAME_MAX_LEN) return full;
  const suffix = `__${shortHash(full)}`;
  return full.slice(0, CHAT_TOOL_NAME_MAX_LEN - suffix.length) + suffix;
}

// ============================================================ 工具上下文
/**
 * Responses 的 tools[] 有四类：function / custom（freeform，如 apply_patch）/
 * namespace（如 multi_agent_v1）/ tool_search。chat 上游只认 function，所以：
 *   function  → 原名直传
 *   namespace → `<ns>__<name>` 扁平化（>64 截断加哈希），回传时带 namespace 字段
 *   custom    → 降级成 {input:string} 的 function，描述里嵌回原始定义
 *   tool_search → 代理成同名 tool_search function
 * 返回的 ctx 既供请求翻译用，也供响应翻译把 chat 名字还原成 Responses 语义。
 */
export function buildToolContext(tools) {
  const ctx = { chatTools: [], byChat: new Map(), customNames: new Set() };
  const add = (chatName, spec, chatTool) => {
    if (!chatName || ctx.byChat.has(chatName)) return;
    ctx.byChat.set(chatName, spec);
    if (spec.kind === "custom") ctx.customNames.add(chatName);
    ctx.chatTools.push(chatTool);
  };
  for (const tool of Array.isArray(tools) ? tools : []) addResponseTool(tool, ctx, add);
  return ctx;
}

function addResponseTool(tool, ctx, add) {
  if (typeof tool === "string") {   // Responses 允许 tools: ["shell"] 这种裸名字
    return addCustomTool({ type: "custom", name: tool }, add);
  }
  if (!tool || typeof tool !== "object") return;
  switch (tool.type) {
    case "function": return addFunctionTool(tool, null, add);
    case "custom": return addCustomTool(tool, add);
    case "tool_search": return addToolSearchTool(add);
    case "namespace": return addNamespaceTool(tool, add);
    default: return;
  }
}

function toolOriginalName(tool) {
  const name = tool.function?.name ?? tool.name;
  return typeof name === "string" && name.trim() ? name.trim() : "";
}

function addFunctionTool(tool, namespace, add) {
  const original = toolOriginalName(tool);
  if (!original) return;
  const chatName = namespace ? flattenNamespaceToolName(namespace, original) : original;
  const source = tool.function || tool;
  const fn = { name: chatName };
  if (typeof source.description === "string" && source.description) fn.description = source.description;
  fn.parameters = normalizeParameters(source.parameters);
  if (tool.strict !== undefined) fn.strict = tool.strict;
  else if (source.strict !== undefined) fn.strict = source.strict;
  add(chatName, { kind: namespace ? "namespace" : "function", name: original, namespace: namespace || undefined },
    { type: "function", function: fn });
}

function addCustomTool(tool, add) {
  const name = toolOriginalName(tool);
  if (!name) return;
  add(name, { kind: "custom", name }, {
    type: "function",
    function: {
      name,
      description: `${CUSTOM_TOOL_HEADING}\n\`\`\`json\n${canonicalJson(tool)}\n\`\`\``,
      parameters: {
        type: "object",
        properties: { [CUSTOM_TOOL_INPUT_FIELD]: { type: "string", description: CUSTOM_TOOL_INPUT_DESC } },
        required: [CUSTOM_TOOL_INPUT_FIELD],
      },
    },
  });
}

function addToolSearchTool(add) {
  add(TOOL_SEARCH_PROXY_NAME, { kind: "tool_search", name: TOOL_SEARCH_PROXY_NAME }, {
    type: "function",
    function: {
      name: TOOL_SEARCH_PROXY_NAME,
      description: "Search and load Codex tools, plugins, connectors, and MCP namespaces for the current task.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query for tools or connectors to load." },
          limit: { type: "integer", description: "Maximum number of tool groups to return." },
        },
        required: ["query"],
      },
    },
  });
}

function addNamespaceTool(tool, add) {
  const namespace = typeof tool.name === "string" ? tool.name : "";
  const children = Array.isArray(tool.tools) ? tool.tools : Array.isArray(tool.children) ? tool.children : [];
  if (!namespace) return;
  for (const child of children) {
    if (child?.type === "function") addFunctionTool(child, namespace, add);
  }
}

function normalizeParameters(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return { ...EMPTY_SCHEMA };
  const copy = { ...params };
  if (copy.type !== "object") copy.type = "object";
  if (!copy.properties || typeof copy.properties !== "object") copy.properties = {};
  return copy;
}

/** 历史里的 function_call 条目在 chat 侧用哪个名字（含 namespace 还原） */
export function chatNameForCall(ctx, name, namespace) {
  if (namespace) {
    for (const [chatName, spec] of ctx.byChat) {
      if (spec.kind === "namespace" && spec.name === name && spec.namespace === namespace) return chatName;
    }
    return flattenNamespaceToolName(namespace, name);
  }
  return name || "";
}

// ============================================================ 请求翻译

function instructionText(instructions) {
  if (typeof instructions === "string") return instructions;
  if (Array.isArray(instructions))
    return instructions.map((p) => (typeof p === "string" ? p : p?.text || "")).filter(Boolean).join("\n\n");
  return "";
}

function responsesRoleToChat(role) {
  if (role === "developer") return "system";
  return role === "assistant" ? "assistant" : role === "system" ? "system" : "user";
}

function contentPartsToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts = [];
  for (const p of content) {
    if (!p || typeof p !== "object") continue;
    if (p.type === "input_text" || p.type === "output_text" || p.type === "text") texts.push(p.text || "");
    else if (p.type === "input_image") texts.push("[image omitted: upstream is text-only]");
    else if (p.type === "input_file") texts.push(`[file omitted: ${p.filename || "file"}]`);
    else if (p.type === "refusal") texts.push(p.refusal || "");
  }
  return texts.join("\n");
}

function callOutputText(output) {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return output.map((p) => (typeof p === "string" ? p : p?.text || "")).join("\n");
  if (output == null) return "";
  return JSON.stringify(output);
}

/** 压缩条目（历史回放）：自家信封解得开→摘要正文；别家密文→一句话占位 */
export const COMPACTION_PREFIX = "aswitch-compaction-v1:";
export const OPAQUE_COMPACTION_NOTE =
  "[earlier conversation was compacted; the summary is stored in a format this model cannot read]";
export function decodeCompactionItem(item) {
  const enc = typeof item?.encrypted_content === "string" ? item.encrypted_content : "";
  if (!enc) return "";
  if (enc.startsWith(COMPACTION_PREFIX)) {
    try { return Buffer.from(enc.slice(COMPACTION_PREFIX.length), "base64url").toString("utf8"); }
    catch { return ""; }
  }
  return OPAQUE_COMPACTION_NOTE;
}

// 与 codex-rs prompts/templates/compact/prompt.md 一致（Codex 本地压缩的提示词）
export const COMPACT_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.
`;

// 与 codex-rs summary_prefix.md 一致；Codex 把摘要当带前缀的用户消息回放
export const SUMMARY_PREFIX =
  "Another language model started to solve this problem and produced a summary of its thinking process. " +
  "You also have access to the state of the tools that were used by that language model. Use this to build " +
  "on the work that has already been done and avoid duplicating work. Here is the summary produced by the " +
  "other language model, use the information in this summary to assist with your own analysis:";

export function isCompactionTrigger(item) {
  return item?.type === "compaction_trigger";
}
export function isCompactionRequest(body) {
  const input = body?.input;
  return Array.isArray(input) && input.some(isCompactionTrigger);
}

/**
 * Responses 请求 → chat 请求。
 * opts: { maxOutputTokens: 钳制上限(0=不钳), defaultMaxTokens, includeUsage }
 * 返回 { chat, meta: { toolContext, compaction } }。
 */
export function responsesToChatRequest(body, opts = {}) {
  const toolContext = buildToolContext(body.tools);
  const compaction = isCompactionRequest(body);
  const messages = [];
  const instructions = instructionText(body.instructions);
  if (instructions) messages.push({ role: "system", content: instructions });

  const input = typeof body.input === "string"
    ? [{ type: "message", role: "user", content: [{ type: "input_text", text: body.input }] }]
    : Array.isArray(body.input) ? body.input : [];
  appendInputAsChatMessages(input, messages, toolContext);
  const collapsed = collapseSystemToHead(messages);
  if (!collapsed.some((m) => m.role !== "system")) collapsed.push({ role: "user", content: "." });

  const chat = { model: body.model, messages: collapsed };
  if (toolContext.chatTools.length && !compaction) chat.tools = toolContext.chatTools;
  if (chat.tools && body.tool_choice != null) {
    const tc = responsesToolChoiceToChat(body.tool_choice, toolContext);
    if (tc !== undefined) chat.tool_choice = tc;
  }
  if (chat.tools && typeof body.parallel_tool_calls === "boolean") chat.parallel_tool_calls = body.parallel_tool_calls;
  if (typeof body.temperature === "number") chat.temperature = body.temperature;
  if (typeof body.top_p === "number") chat.top_p = body.top_p;

  let maxTokens = Number(body.max_output_tokens ?? body.max_tokens);
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) maxTokens = opts.defaultMaxTokens || 4096;
  if (opts.maxOutputTokens > 0 && maxTokens > opts.maxOutputTokens) maxTokens = opts.maxOutputTokens;
  chat.max_tokens = maxTokens;

  if (body.stream) {
    chat.stream = true;
    // 流式下 chat 上游默认不回 usage，显式索要（末位 usage chunk）；不支持的上游
    // 忽略未知字段，个别严格上游可在调用方关掉本注入。
    if (opts.includeUsage !== false) chat.stream_options = { include_usage: true };
  }
  return { chat, meta: { toolContext, compaction } };
}

function collapseSystemToHead(messages) {
  const systems = messages.filter((m) => m?.role === "system" && String(m.content || "").trim());
  if (systems.length <= 1) return messages;
  const rest = messages.filter((m) => !(m?.role === "system" && String(m.content || "").trim()));
  return [{ role: "system", content: systems.map((m) => m.content).join("\n\n") }, ...rest];
}

function appendInputAsChatMessages(input, messages, ctx) {
  let pendingReasoning = "";
  let pendingCalls = [];
  const flushCalls = () => {
    if (!pendingCalls.length) return;
    messages.push({ role: "assistant", content: null, tool_calls: pendingCalls });
    pendingCalls = [];
  };
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const type = item.type || (item.role ? "message" : "");
    if (type === "message") {
      const role = responsesRoleToChat(item.role);
      const text = contentPartsToText(item.content);
      if (role === "assistant") {
        flushCalls();
        const msg = { role: "assistant", content: text };
        if (pendingReasoning) { msg.reasoning_content = pendingReasoning; pendingReasoning = ""; }
        if (text.trim() || msg.reasoning_content) messages.push(msg);   // 空壳 assistant 上游会 400
      } else {
        flushCalls();
        pendingReasoning = "";
        if (text.trim()) messages.push({ role, content: text });
      }
    } else if (type === "function_call") {
      pendingCalls.push({
        id: item.call_id || item.id || "",
        type: "function",
        function: {
          name: chatNameForCall(ctx, item.name, item.namespace),
          arguments: canonicalArguments(item.arguments),
        },
      });
    } else if (type === "function_call_output") {
      flushCalls();
      messages.push({ role: "tool", tool_call_id: item.call_id || item.id || "", content: callOutputText(item.output) });
    } else if (type === "custom_tool_call") {
      pendingCalls.push({
        id: item.call_id || item.id || "",
        type: "function",
        function: {
          name: item.name || "",
          arguments: JSON.stringify({ [CUSTOM_TOOL_INPUT_FIELD]: item.input ?? "" }),
        },
      });
    } else if (type === "custom_tool_call_output") {
      flushCalls();
      messages.push({ role: "tool", tool_call_id: item.call_id || item.id || "", content: callOutputText(item.output) });
    } else if (type === "reasoning") {
      const text = (Array.isArray(item.summary) ? item.summary : [])
        .map((s) => (typeof s === "string" ? s : s?.text || "")).filter(Boolean).join("\n");
      if (text) pendingReasoning = pendingReasoning ? pendingReasoning + "\n" + text : text;
    } else if (type === "compaction" || type === "compaction_summary" || type === "context_compaction") {
      flushCalls();
      const summary = decodeCompactionItem(item);
      messages.push({ role: "user", content: `${SUMMARY_PREFIX}\n${summary}` });
    } else if (type === "compaction_trigger") {
      flushCalls();
      messages.push({ role: "user", content: COMPACT_PROMPT });
    }
    // 其余（item_reference / web_search_call / 本地 shell 条目）翻译层无处安放，跳过
  }
  flushCalls();
}

function canonicalArguments(args) {
  if (typeof args === "string" && args.trim()) return args;
  if (args && typeof args === "object") return JSON.stringify(args);
  return "{}";
}

function responsesToolChoiceToChat(toolChoice, ctx) {
  if (typeof toolChoice === "string") {
    return ["auto", "none", "required"].includes(toolChoice) ? toolChoice : undefined;
  }
  if (!toolChoice || typeof toolChoice !== "object") return undefined;
  if (toolChoice.type === "function" || toolChoice.type === "custom" || toolChoice.type === "tool_search") {
    const name = toolChoice.name || toolChoice.function?.name;
    if (toolChoice.type === "tool_search") return { type: "function", function: { name: TOOL_SEARCH_PROXY_NAME } };
    const chatName = name ? chatNameForCall(ctx, name, toolChoice.namespace) : "";
    return chatName ? { type: "function", function: { name: chatName } } : "auto";
  }
  // 新版 Codex 的 allowed_tools 形态：只保留模式语义，工具白名单翻译层无法表达
  if (typeof toolChoice.mode === "string" && ["auto", "none", "required"].includes(toolChoice.mode)) {
    return toolChoice.mode;
  }
  return undefined;
}

// ============================================================ 用量 / 推理提取

/** chat 的 reasoning 字段穷举：reasoning_content > reasoning(str/obj) > reasoning_details */
export function extractReasoningText(value) {
  if (!value || typeof value !== "object") return "";
  for (const key of ["reasoning_content", "reasoning"]) {
    const v = value[key];
    if (typeof v === "string" && v) return v;
    if (v && typeof v === "object" && typeof v.text === "string" && v.text) return v.text;
  }
  const details = value.reasoning_details;
  if (typeof details === "string" && details) return details;
  if (Array.isArray(details)) {
    return details.map((p) => (typeof p === "string" ? p : p?.text || p?.content || "")).filter(Boolean).join("\n\n");
  }
  if (details && typeof details === "object") return details.text || details.content || "";
  return "";
}

/** chat usage（或已归一化的 {input_tokens,output_tokens}）→ Responses usage */
export function responsesUsage(usage) {
  const u = usage && typeof usage === "object" ? usage : {};
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const input = num(u.input_tokens ?? u.prompt_tokens);
  const output = num(u.output_tokens ?? u.completion_tokens);
  const total = num(u.total_tokens) || input + output;
  const ptd = u.prompt_tokens_details || u.input_tokens_details || {};
  const nonzero = (...vals) => vals.map(num).find((v) => v > 0) ?? 0;
  const cached = nonzero(ptd.cached_tokens, u.cache_read_input_tokens, u.prompt_cache_hit_tokens);
  const cacheWrite = nonzero(ptd.cache_write_tokens, u.cache_creation_input_tokens);
  const result = {
    input_tokens: input,
    output_tokens: output,
    total_tokens: total,
    output_tokens_details: {
      reasoning_tokens: num((u.completion_tokens_details || {}).reasoning_tokens),
    },
  };
  result.input_tokens_details = cacheWrite > 0
    ? { cached_tokens: cached, cache_write_tokens: cacheWrite }
    : { cached_tokens: cached };
  if (cached > 0) result.cache_read_input_tokens = cached;
  if (cacheWrite > 0) result.cache_creation_input_tokens = cacheWrite;
  return result;
}

// ============================================================ Responses 响应骨架

export function responseSkeleton(id, model, status, extra = {}) {
  return {
    id, object: "response", created_at: Math.floor(Date.now() / 1000),
    status, model, output: [], parallel_tool_calls: true,
    tool_choice: "auto", tools: [], error: null, incomplete_details: null,
    instructions: null, metadata: {}, temperature: 1, top_p: 1, max_output_tokens: null,
    previous_response_id: null, reasoning: null, usage: null, user: null,
    ...extra,
  };
}

function reasoningItemDone(state) {
  // 已完成 reasoning 条目不带 status 字段（与 CC Switch 的 reasoning_item 一致）
  return { id: state.id, type: "reasoning", summary: [{ type: "summary_text", text: state.text }] };
}
function messageItemDone(state) {
  return {
    id: state.id, type: "message", status: "completed", role: "assistant",
    content: [{ type: "output_text", text: state.text, annotations: [] }],
  };
}
function toolItemDone(state, ctx) {
  const spec = ctx.byChat.get(state.name) || {};
  if (spec.kind === "custom") {
    return {
      id: state.itemId, type: "custom_tool_call", status: "completed", call_id: state.callId,
      name: spec.name || state.name, input: customInputFromArguments(state.arguments),
    };
  }
  if (spec.kind === "tool_search") {
    let args = {};
    try { args = JSON.parse(state.arguments || "{}") || {}; } catch { args = { query: state.arguments }; }
    return { id: state.itemId, type: "tool_search_call", status: "completed", call_id: state.callId, execution: "client", arguments: args };
  }
  const item = {
    id: state.itemId, type: "function_call", status: "completed",
    call_id: state.callId, name: spec.name || state.name, arguments: state.arguments || "{}",
  };
  if (spec.namespace) item.namespace = spec.namespace;
  return item;
}
function customInputFromArguments(argumentsStr) {
  const s = String(argumentsStr || "");
  if (!s.trim()) return "";
  try {
    const obj = JSON.parse(s);
    if (obj && typeof obj === "object" && typeof obj[CUSTOM_TOOL_INPUT_FIELD] === "string") return obj[CUSTOM_TOOL_INPUT_FIELD];
  } catch { /* 不是 JSON 就当原始串 */ }
  return s;
}

// ============================================================ SSE 写出状态机
/**
 * 增量把「归一化事件」写成 Responses SSE：
 *   {type:"reasoning", text}                      推理增量
 *   {type:"text", text}                           正文增量
 *   {type:"tool_calls", calls:[{id,name,params|arguments}]}   完整一批（Comate 上游形状）
 *   {type:"tool_call_delta", index,id?,name?,arguments}       逐片（chat SSE 形状）
 *   {type:"done", usage?, finishReason?}          收尾（自动 close 所有打开条目）
 * 事件顺序照 CC Switch 的 prove 状态机：条目在首个增量时才 output_item.added（懒开），
 * 收尾按 推理→正文→工具 顺序 done；response.completed 的 output 按 output_index 排序。
 */
export class ResponsesSseWriter {
  constructor(res, { model, responseId, toolContext } = {}) {
    this.res = res;
    this.model = model || "";
    this.responseId = responseId || newResponseId();
    this.toolContext = toolContext || buildToolContext(null);
    this.seq = 0;
    this.nextIndex = 0;
    this.reasoning = { index: null, id: "rs_" + this.responseId.slice(5), text: "" };
    this.message = { index: null, id: "msg_" + this.responseId.slice(5), text: "" };
    this.tools = [];
    this.toolByKey = new Map();
    this.output = [];
    this.usage = null;
    this.finishReason = null;
    this.started = false;
    this.settled = false;
    this.droppedToolCalls = 0;
  }

  _write(obj) {
    if (this.res.writableEnded || this.res.destroyed) return;
    try { this.res.write(`event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`); } catch { /* client gone */ }
  }
  _skeleton(status, output = []) {
    return responseSkeleton(this.responseId, this.model, status, { output });
  }
  ensureStarted() {
    if (this.started) return;
    this.started = true;
    const skel = this._skeleton("in_progress");
    this._write({ type: "response.created", sequence_number: this.seq++, response: skel });
    this._write({ type: "response.in_progress", sequence_number: this.seq++, response: skel });
  }
  _takeIndex() { return this.nextIndex++; }

  reasoningDelta(text) {
    if (!text) return;
    this.ensureStarted();
    if (this.reasoning.index === null) {
      this.reasoning.index = this._takeIndex();
      this._write({
        type: "response.output_item.added", sequence_number: this.seq++, output_index: this.reasoning.index,
        item: { id: this.reasoning.id, type: "reasoning", status: "in_progress", summary: [] },
      });
      this._write({
        type: "response.reasoning_summary_part.added", sequence_number: this.seq++,
        item_id: this.reasoning.id, output_index: this.reasoning.index, summary_index: 0,
        part: { type: "summary_text", text: "" },
      });
    }
    this.reasoning.text += text;
    this._write({
      type: "response.reasoning_summary_text.delta", sequence_number: this.seq++,
      item_id: this.reasoning.id, output_index: this.reasoning.index, summary_index: 0, delta: text,
    });
  }

  textDelta(text) {
    if (!text) return;
    this.ensureStarted();
    if (this.message.index === null) {
      this.message.index = this._takeIndex();
      this._write({
        type: "response.output_item.added", sequence_number: this.seq++, output_index: this.message.index,
        item: { id: this.message.id, type: "message", status: "in_progress", role: "assistant", content: [] },
      });
      this._write({
        type: "response.content_part.added", sequence_number: this.seq++,
        item_id: this.message.id, output_index: this.message.index, content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
    }
    this.message.text += text;
    this._write({
      type: "response.output_text.delta", sequence_number: this.seq++,
      item_id: this.message.id, output_index: this.message.index, content_index: 0, delta: text,
    });
  }

  /** 逐片工具调用（chat SSE）：identity 齐了才开条目，之后参数增量即时透传 */
  toolCallDelta({ index, id, name, arguments: argsDelta }) {
    const key = index ?? this.tools.length;
    let st = this.toolByKey.get(key);
    if (!st) {
      st = { key, index: null, itemId: "", callId: "", name: "", arguments: "", opened: false, done: false };
      this.toolByKey.set(key, st);
      this.tools.push(st);
    }
    if (id) st.callId = id;
    if (name) st.name = name;
    if (argsDelta) st.arguments += argsDelta;
    const openedBefore = st.opened;
    this._openToolIfReady(st);   // 开条目那一刻会把已累积参数一次性补发
    if (openedBefore && argsDelta && !this.toolContext.customNames.has(st.name)) {
      this._write({
        type: "response.function_call_arguments.delta", sequence_number: this.seq++,
        item_id: st.itemId, output_index: st.index, delta: argsDelta,
      });
    }
  }

  /** 完整一批工具调用（Comate 上游形状）：立即开→参数增量→收口（条目在 finalize 前先关） */
  toolCalls(calls) {
    calls.forEach((c, i) => {
      const argsStr = typeof c.arguments === "string"
        ? c.arguments
        : JSON.stringify(c.params && typeof c.params === "object" ? c.params : c.arguments ?? {});
      this.toolCallDelta({ index: c.index ?? i, id: c.id, name: c.name, arguments: argsStr });
    });
  }

  _openToolIfReady(st) {
    if (st.opened || !st.name) return;
    this.ensureStarted();
    st.opened = true;
    st.index = this._takeIndex();
    const spec = this.toolContext.byChat.get(st.name) || {};
    if (spec.kind === "custom") st.itemId = "ctc_" + (st.callId || st.index);
    else if (spec.kind === "tool_search") st.itemId = "tsc_" + (st.callId || st.index);
    else st.itemId = "fc_" + (st.callId || st.index);
    const base = { id: st.itemId, status: "in_progress", call_id: st.callId || String(st.index), name: spec.name || st.name };
    if (spec.kind === "custom") {
      this._write({ type: "response.output_item.added", sequence_number: this.seq++, output_index: st.index, item: { ...base, type: "custom_tool_call", input: "" } });
    } else if (spec.kind === "tool_search") {
      this._write({ type: "response.output_item.added", sequence_number: this.seq++, output_index: st.index, item: { ...base, type: "tool_search_call", execution: "client", arguments: {} } });
    } else {
      const item = { ...base, type: "function_call", arguments: "" };
      if (spec.namespace) item.namespace = spec.namespace;
      this._write({ type: "response.output_item.added", sequence_number: this.seq++, output_index: st.index, item });
    }
    // 开条目时如已有累积参数（identity 迟到），一次性补发
    if (st.arguments && spec.kind !== "custom") {
      this._write({
        type: "response.function_call_arguments.delta", sequence_number: this.seq++,
        item_id: st.itemId, output_index: st.index, delta: st.arguments,
      });
    }
  }

  /** 归一化事件入口（comate 的 turnEvents / chatSseToNormalized 共用） */
  emit(ev) {
    if (!ev) return;
    switch (ev.type) {
      case "reasoning": return this.reasoningDelta(ev.text);
      case "text": return this.textDelta(ev.text);
      case "tool_calls": return this.toolCalls(ev.calls || []);
      case "tool_call_delta": return this.toolCallDelta(ev);
      case "done":
        if (ev.usage) this.usage = ev.usage;
        if (ev.finishReason) this.finishReason = ev.finishReason;
        return;
      default: return;
    }
  }

  _closeReasoning() {
    const r = this.reasoning;
    if (r.index === null) return;
    this._write({ type: "response.reasoning_summary_text.done", sequence_number: this.seq++, item_id: r.id, output_index: r.index, summary_index: 0, text: r.text });
    this._write({ type: "response.reasoning_summary_part.done", sequence_number: this.seq++, item_id: r.id, output_index: r.index, summary_index: 0, part: { type: "summary_text", text: r.text } });
    const item = reasoningItemDone(r);
    this._write({ type: "response.output_item.done", sequence_number: this.seq++, output_index: r.index, item });
    this.output.push({ index: r.index, item });
  }
  _closeMessage() {
    const m = this.message;
    if (m.index === null) return;
    this._write({ type: "response.output_text.done", sequence_number: this.seq++, item_id: m.id, output_index: m.index, content_index: 0, text: m.text });
    this._write({ type: "response.content_part.done", sequence_number: this.seq++, item_id: m.id, output_index: m.index, content_index: 0, part: { type: "output_text", text: m.text, annotations: [] } });
    const item = messageItemDone(m);
    this._write({ type: "response.output_item.done", sequence_number: this.seq++, output_index: m.index, item });
    this.output.push({ index: m.index, item });
  }
  _closeTools() {
    for (const st of this.tools) {
      if (st.done) continue;
      if (!st.name.trim()) { st.done = true; this.droppedToolCalls++; continue; }   // 无名调用：Codex 认不出，丢
      if (!st.opened) this._openToolIfReady(st);
      if (!st.opened) { st.done = true; continue; }
      const spec = this.toolContext.byChat.get(st.name) || {};
      if (spec.kind === "custom") {
        const input = customInputFromArguments(st.arguments);
        if (input) this._write({ type: "response.custom_tool_call_input.delta", sequence_number: this.seq++, item_id: st.itemId, output_index: st.index, delta: input });
        this._write({ type: "response.custom_tool_call_input.done", sequence_number: this.seq++, item_id: st.itemId, output_index: st.index, input });
      } else {
        this._write({ type: "response.function_call_arguments.done", sequence_number: this.seq++, item_id: st.itemId, output_index: st.index, arguments: st.arguments || "{}" });
      }
      const item = toolItemDone(st, this.toolContext);
      st.done = true;
      this._write({ type: "response.output_item.done", sequence_number: this.seq++, output_index: st.index, item });
      this.output.push({ index: st.index, item });
    }
  }
  _completedResponse(status) {
    const output = [...this.output].sort((a, b) => a.index - b.index).map((o) => o.item);
    const extra = { output, usage: this.usage ? responsesUsage(this.usage) : responsesUsage(null) };
    if (status === "incomplete") extra.incomplete_details = { reason: "max_output_tokens" };
    return responseSkeleton(this.responseId, this.model, status, extra);
  }

  /** 收尾：close 所有条目 + response.completed（或 incomplete） */
  finalize({ status, usage, finishReason } = {}) {
    if (usage) this.usage = usage;
    if (finishReason) this.finishReason = finishReason;
    if (this.settled) return this._completedResponse(status || "completed");
    this.settled = true;
    this.ensureStarted();
    this._closeReasoning();
    this._closeMessage();
    this._closeTools();
    const st = status || (this.finishReason === "length" ? "incomplete" : "completed");
    const response = this._completedResponse(st);
    this._write({ type: st === "incomplete" ? "response.incomplete" : "response.completed", sequence_number: this.seq++, response });
    return response;
  }

  fail(message, type) {
    if (this.settled) return;
    this.settled = true;
    this.ensureStarted();
    const output = [...this.output].sort((a, b) => a.index - b.index).map((o) => o.item);
    const response = responseSkeleton(this.responseId, this.model, "failed", { output });
    response.error = { message, ...(type ? { type } : {}) };
    this._write({ type: "response.failed", sequence_number: this.seq++, response });
  }
}

// ============================================================ 上游 chat SSE 解析

/** 逐块解析 chat completions SSE（含跨块拼行、[DONE]、错误帧） */
export async function* parseChatSse(stream) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const raw of stream) {
    buf += typeof raw === "string" ? raw : decoder.decode(raw, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      const t = line.trim();
      if (!t || !t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const obj = JSON.parse(payload);
        if (obj?.error) { const e = new Error(obj.error.message || "upstream error"); e.upstream = obj.error; throw e; }
        yield obj;
      } catch (e) {
        if (e instanceof SyntaxError) continue;   // 心跳/注释/半截行
        throw e;
      }
    }
  }
}

/**
 * chat SSE → 归一化事件流（喂 ResponsesSseWriter）。
 * 逐片透传：推理增量、正文增量、工具参数增量；收尾补一批 tool_call_final 再 done。
 */
export async function* chatSseToNormalized(stream, { includeUsage = true } = {}) {
  let finishReason = null;
  let usage = null;
  const tools = new Map();
  for await (const chunk of parseChatSse(stream)) {
    const choice = chunk.choices?.[0] || {};
    const delta = choice.delta || choice.message || {};
    if (includeUsage && chunk.usage) usage = chunk.usage;
    const reasoning = extractReasoningText(delta);
    if (reasoning) yield { type: "reasoning", text: reasoning };
    if (typeof delta.content === "string" && delta.content) yield { type: "text", text: delta.content };
    for (const tc of delta.tool_calls || []) {
      const key = tc.index ?? 0;
      const st = tools.get(key) || { id: "", name: "", arguments: "" };
      if (tc.id) st.id = tc.id;
      if (tc.function?.name) st.name = tc.function.name;
      else if (tc.name) st.name = tc.name;
      const argsDelta = typeof tc.function?.arguments === "string" ? tc.function.arguments
        : typeof tc.arguments === "string" ? tc.arguments : "";
      st.arguments += argsDelta;
      tools.set(key, st);
      yield { type: "tool_call_delta", index: key, id: tc.id, name: tc.function?.name || tc.name, arguments: argsDelta };
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }
  yield { type: "done", usage, finishReason };
}

/** 把 chat SSE 聚合为完整 message（非流式回放/测试用） */
export async function accumulateChatSse(stream) {
  const acc = { content: "", reasoning_content: "", tool_calls: new Map(), usage: null, finish_reason: null };
  for await (const ev of chatSseToNormalized(stream)) {
    if (ev.type === "reasoning") acc.reasoning_content += ev.text;
    else if (ev.type === "text") acc.content += ev.text;
    else if (ev.type === "tool_call_delta") {
      const st = acc.tool_calls.get(ev.index) || { id: "", name: "", arguments: "" };
      if (ev.id) st.id = ev.id;
      if (ev.name) st.name = ev.name;
      st.arguments += ev.arguments || "";
      acc.tool_calls.set(ev.index, st);
    } else if (ev.type === "done") {
      acc.usage = ev.usage;
      acc.finish_reason = ev.finishReason;
    }
  }
  acc.tool_calls = [...acc.tool_calls.entries()].filter(([, st]) => st.name.trim())
    .sort((a, b) => a[0] - b[0]).map(([, st]) => st);
  return acc;
}

// ============================================================ 非流式翻译

/** chat completion（或聚合结果）→ Responses 响应体 */
export function chatCompletionToResponses(chat, { model, responseId, toolContext } = {}) {
  const ctx = toolContext || buildToolContext(null);
  const id = responseId || newResponseId();
  const choice = chat?.choices?.[0] || {};
  const msg = choice.message || {};
  const out = [];
  const reasoning = extractReasoningText(msg);
  if (reasoning) out.push({ id: "rs_" + id.slice(5), type: "reasoning", summary: [{ type: "summary_text", text: reasoning }] });
  if (typeof msg.content === "string" && msg.content) {
    out.push({ id: "msg_" + id.slice(5), type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: msg.content, annotations: [] }] });
  }
  for (const tc of msg.tool_calls || []) {
    const name = tc?.function?.name || tc?.name || "";
    const callId = tc?.id || "";
    const args = canonicalArguments(tc?.function?.arguments ?? tc?.arguments);
    const spec = ctx.byChat.get(name) || {};
    const key = callId || String(out.length);
    if (spec.kind === "custom") {
      out.push({ id: "ctc_" + key, type: "custom_tool_call", status: "completed", call_id: callId || key, name: spec.name || name, input: customInputFromArguments(args) });
    } else if (spec.kind === "tool_search") {
      let parsed = {};
      try { parsed = JSON.parse(args) || {}; } catch { parsed = { query: args }; }
      out.push({ id: "tsc_" + key, type: "tool_search_call", status: "completed", call_id: callId || key, execution: "client", arguments: parsed });
    } else {
      const item = { id: "fc_" + key, type: "function_call", status: "completed", call_id: callId || key, name: spec.name || name, arguments: args };
      if (spec.namespace) item.namespace = spec.namespace;
      out.push(item);
    }
  }
  const status = choice.finish_reason === "length" ? "incomplete" : "completed";
  const extra = { output: out, usage: responsesUsage(chat?.usage) };
  if (status === "incomplete") extra.incomplete_details = { reason: "max_output_tokens" };
  return responseSkeleton(id, model, status, extra);
}

// ============================================================ 压缩回合（防御）

/** 摘要正文包成自家信封，塞进 encrypted_content（Codex 原样存、回放时不解析） */
export function encodeCompactionSummary(summary) {
  return COMPACTION_PREFIX + Buffer.from(String(summary || ""), "utf8").toString("base64url");
}
export function compactionOutputItem(summary) {
  return { id: "cmp_" + randomUUID().replace(/-/g, "").slice(0, 24), type: "compaction", encrypted_content: encodeCompactionSummary(summary) };
}
/** 压缩回合的 finish_reason 是否干净（截断/内容过滤时不能装上半截摘要） */
export function compactionIncompleteReason(finishReason) {
  if (!finishReason) return null;
  if (finishReason === "length") return "max_output_tokens";
  if (finishReason === "content_filter") return "content_filter";
  return null;
}

/**
 * 非流式压缩响应：恰好一个 compaction 条目；不干净或没正文时如实回 failed/incomplete。
 */
export function compactionToResponses({ text, usage, model, responseId, finishReason } = {}) {
  const id = responseId || newResponseId();
  const reason = compactionIncompleteReason(finishReason);
  if (reason) {
    return responseSkeleton(id, model, "incomplete", { usage: responsesUsage(usage), incomplete_details: { reason } });
  }
  const summary = String(text || "").trim();
  if (!summary) {
    const r = responseSkeleton(id, model, "failed", { usage: responsesUsage(usage) });
    r.error = { message: "Upstream returned no summary text for the compaction turn", type: "compaction_summary_empty" };
    return r;
  }
  return responseSkeleton(id, model, "completed", { output: [compactionOutputItem(summary)], usage: responsesUsage(usage) });
}

/**
 * 流式压缩：created → output_item.done(compaction) → completed/incomplete/failed。
 * （compaction 条目只发 done，与 CC Switch 的 finish_compaction 一致。）
 */
export function streamCompactionAsResponses(res, { text, usage, model, responseId, finishReason } = {}) {
  const id = responseId || newResponseId();
  let seq = 0;
  const write = (obj) => {
    if (res.writableEnded || res.destroyed) return;
    try { res.write(`event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`); } catch { /* client gone */ }
  };
  write({ type: "response.created", sequence_number: seq++, response: responseSkeleton(id, model, "in_progress") });

  const reason = compactionIncompleteReason(finishReason);
  if (reason) {
    write({ type: "response.incomplete", sequence_number: seq++, response: responseSkeleton(id, model, "incomplete", { usage: responsesUsage(usage), incomplete_details: { reason } }) });
    return;
  }
  const summary = String(text || "").trim();
  if (!summary) {
    const r = responseSkeleton(id, model, "failed", { usage: responsesUsage(usage) });
    r.error = { message: "Upstream returned no summary text for the compaction turn", type: "compaction_summary_empty" };
    write({ type: "response.failed", sequence_number: seq++, response: r });
    return;
  }
  const item = compactionOutputItem(summary);
  write({ type: "response.output_item.done", sequence_number: seq++, output_index: 0, item });
  write({ type: "response.completed", sequence_number: seq++, response: responseSkeleton(id, model, "completed", { output: [item], usage: responsesUsage(usage) }) });
}
