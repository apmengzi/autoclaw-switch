#!/usr/bin/env node
/**
 * 变换层（bridge/responses_transform.mjs）离线单测。
 *
 * 覆盖 Codex 真机请求里出现过的每一种形状：
 *   请求侧：instructions / developer 消息 / function_call(+output) 历史 / reasoning
 *           回放 / custom(freeform) 工具降级 / namespace 扁平化 / tool_choice 各形态 /
 *           max_output_tokens 钳制 / 存量压缩条目解码
 *   响应侧：SSE 事件序列与字段（逐帧断言）、工具调用/推理/用量、finish_reason=length
 *           → incomplete、无名工具丢弃、压缩回合恰好一个 compaction 条目
 *   上游侧：chat SSE 解析（跨块、[DONE]、错误帧）、推理字段穷举、用量字段穷举
 *
 *   node bridge/test_responses_transform.mjs    （退出码 0 = 全过）
 */
import {
  isResponsesPath, newResponseId, buildToolContext, responsesToChatRequest, isCompactionRequest,
  ResponsesSseWriter, chatSseToNormalized, accumulateChatSse, chatCompletionToResponses,
  responsesUsage, extractReasoningText, decodeCompactionItem, encodeCompactionSummary,
  compactionToResponses, streamCompactionAsResponses, COMPACTION_PREFIX, COMPACT_PROMPT,
} from "./responses_transform.mjs";

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; }
  else { fail++; console.log(`  ✗ ${label}${extra !== undefined ? " — " + JSON.stringify(extra) : ""}`); }
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  ok(a === b, label, { actual, expected });
}

// 记录 SSE 帧的假 res
function fakeRes() {
  const frames = [];
  return {
    frames,
    writableEnded: false, destroyed: false,
    write(s) {
      for (const block of String(s).split("\n\n")) {
        if (!block.trim()) continue;
        const ev = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (ev && data) frames.push({ event: ev, data: JSON.parse(data) });
      }
      return true;
    },
    end() { this.writableEnded = true; },
  };
}
const types = (res) => res.frames.map((f) => f.event);
const byType = (res, t) => res.frames.filter((f) => f.event === t).map((f) => f.data);

async function* fromChunks(chunks) { for (const c of chunks) yield Buffer.from(c, "utf8"); }

console.log("== 请求翻译 ==");
ok(isResponsesPath("/v1/responses") && isResponsesPath("/responses") && !isResponsesPath("/v1/chat"), "路径识别");

const codexTools = [
  { type: "function", name: "exec_command", description: "Run a command", parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } },
  { type: "custom", name: "apply_patch", description: "Apply a patch", format: { type: "grammar", syntax: "lark", definition: "start: /.*/" } },
  { type: "namespace", name: "multi_agent_v1", description: "agents", tools: [
    { type: "function", name: "spawn_agent", parameters: null },
  ] },
  { type: "web_search" },
];
const body = {
  model: "glm-5.2", stream: true, store: false, parallel_tool_calls: true,
  instructions: "You are Codex.",
  max_output_tokens: 307200,
  tools: codexTools,
  tool_choice: "auto",
  reasoning: { summary: "auto" },
  input: [
    { type: "message", role: "developer", content: [{ type: "input_text", text: "dev note" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    { type: "reasoning", summary: [{ type: "summary_text", text: "thinking..." }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
    { type: "function_call", name: "exec_command", arguments: "{\"cmd\":\"ls\"}", call_id: "call_1" },
    { type: "function_call_output", call_id: "call_1", output: "a.txt\nb.txt" },
    { type: "message", role: "user", content: [{ type: "input_text", text: "now patch" }] },
  ],
};
const { chat, meta } = responsesToChatRequest(body, { maxOutputTokens: 65536 });
eq(chat.model, "glm-5.2", "model 透传");
eq(chat.max_tokens, 65536, "max_output_tokens 钳到安全值");
eq(chat.stream, true, "stream 透传");
eq(chat.stream_options, { include_usage: true }, "stream_options.include_usage 注入");
eq(chat.messages[0], { role: "system", content: "You are Codex.\n\ndev note" }, "instructions+developer 折叠到头部");
eq(chat.messages[1], { role: "user", content: "hi" }, "user 消息");
eq(chat.messages[2], { role: "assistant", content: "hello", reasoning_content: "thinking..." }, "reasoning 回填到下一条 assistant");
eq(chat.messages[3], { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "exec_command", arguments: "{\"cmd\":\"ls\"}" } }] }, "function_call 合并为 assistant.tool_calls");
eq(chat.messages[4], { role: "tool", tool_call_id: "call_1", content: "a.txt\nb.txt" }, "function_call_output → tool");
eq(chat.messages[5], { role: "user", content: "now patch" }, "后续 user 消息");
const toolNames = chat.tools.map((t) => t.function.name);
eq(toolNames, ["exec_command", "apply_patch", "multi_agent_v1__spawn_agent"], "工具降级与 namespace 扁平化");
ok(chat.tools[1].function.description.startsWith("Original tool definition:"), "custom 工具描述嵌回原始定义");
eq(chat.tools[1].function.parameters.required, ["input"], "custom 工具参数收口成 input");
eq(chat.tools[2].function.parameters, { type: "object", properties: {} }, "parameters:null → 空 object schema");
ok(meta.toolContext.customNames.has("apply_patch"), "toolContext 记住 custom");
ok(!chat.tools.some((t) => t.function.name === "web_search"), "web_search 等内置工具不降级");

// 无工具时 tool_choice/parallel 字段必须消失（严格上游会 400）
const bare = responsesToChatRequest({ model: "m", input: "hi", tool_choice: "auto", parallel_tool_calls: true, stream: false });
ok(bare.chat.tool_choice === undefined && bare.chat.parallel_tool_calls === undefined, "无工具时丢弃 tool_choice/parallel_tool_calls");
eq(bare.chat.messages, [{ role: "user", content: "hi" }], "input 为裸字符串");

// tool_choice 形态
const named = responsesToChatRequest({ model: "m", input: "x", tools: [{ type: "function", name: "exec_command", parameters: {} }], tool_choice: { type: "function", name: "exec_command" } });
eq(named.chat.tool_choice, { type: "function", function: { name: "exec_command" } }, "tool_choice 指定函数");
const allowed = responsesToChatRequest({ model: "m", input: "x", tools: [{ type: "custom", name: "apply_patch" }], tool_choice: { type: "allowed_tools", mode: "required", tools: [] } });
eq(allowed.chat.tool_choice, "required", "allowed_tools 只保留模式");

// custom_tool_call 历史回放
const back = responsesToChatRequest({ model: "m", input: [
  { type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch\n", call_id: "call_9" },
  { type: "custom_tool_call_output", call_id: "call_9", output: "ok" },
] });
eq(back.chat.messages[0].tool_calls[0].function.arguments, "{\"input\":\"*** Begin Patch\\n\"}", "custom_tool_call 回放");
eq(back.chat.messages[1], { role: "tool", tool_call_id: "call_9", content: "ok" }, "custom_tool_call_output 回放");

// 空 input 兜底
eq(responsesToChatRequest({ model: "m" }).chat.messages, [{ role: "user", content: "." }], "空 input 兜底占位");

// 压缩
ok(isCompactionRequest({ input: [{ type: "message", role: "user", content: [] }, { type: "compaction_trigger" }] }), "压缩触发识别");
const comp = responsesToChatRequest({ model: "m", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "go" }] }, { type: "compaction_trigger" }], tools: codexTools });
ok(comp.meta.compaction && comp.chat.tools === undefined, "压缩回合不带工具");
ok(comp.chat.messages.some((m) => m.content === COMPACT_PROMPT), "compaction_trigger → COMPACT_PROMPT");

// 存量压缩条目
const env = encodeCompactionSummary("prior work done");
eq(decodeCompactionItem({ type: "compaction", encrypted_content: env }), "prior work done", "自家压缩信封解码");
ok(decodeCompactionItem({ type: "compaction", encrypted_content: "gAAAA-openai" }).includes("cannot read"), "别家密文 → 占位说明");

console.log("== SSE 写出（推理 + 正文 + 工具 + 用量）==");
{
  const res = fakeRes();
  const { meta: m2 } = responsesToChatRequest(body);   // 用同一批工具上下文
  const w = new ResponsesSseWriter(res, { model: "glm-5.2", responseId: "resp_test0000", toolContext: m2.toolContext });
  w.ensureStarted();
  w.reasoningDelta("想");
  w.reasoningDelta("一下");
  w.textDelta("hello ");
  w.textDelta("world");
  w.toolCallDelta({ index: 0, id: "call_a", name: "exec_command", arguments: "{\"cmd\":" });
  w.toolCallDelta({ index: 0, arguments: "\"ls\"}" });
  w.toolCallDelta({ index: 1, id: "call_b", name: "apply_patch", arguments: "" });
  w.toolCallDelta({ index: 1, arguments: "{\"input\":\"*** Begin Patch\\n+1\\n\"}" });
  const final = w.finalize({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 4 } } });

  eq(types(res).slice(0, 2), ["response.created", "response.in_progress"], "开头 created/in_progress");
  eq(types(res).slice(-1), ["response.completed"], "结尾 completed");
  const reasoningAdded = byType(res, "response.output_item.added").find((d) => d.item.type === "reasoning");
  ok(reasoningAdded && reasoningAdded.item.status === "in_progress" && reasoningAdded.item.summary.length === 0, "reasoning 条目懒开");
  eq(byType(res, "response.reasoning_summary_text.delta").map((d) => d.delta), ["想", "一下"], "推理增量逐片");
  eq(byType(res, "response.reasoning_summary_text.done")[0].text, "想一下", "推理收口文本");
  eq(byType(res, "response.output_text.delta").map((d) => d.delta), ["hello ", "world"], "正文增量逐片");
  const fcDeltas = byType(res, "response.function_call_arguments.delta");
  eq(fcDeltas.map((d) => d.delta), ["{\"cmd\":", "\"ls\"}"], "函数参数增量（不重不漏）");
  eq(byType(res, "response.function_call_arguments.done")[0].arguments, "{\"cmd\":\"ls\"}", "参数收口");
  const ctcDeltas = byType(res, "response.custom_tool_call_input.delta");
  eq(ctcDeltas.map((d) => d.delta), ["*** Begin Patch\n+1\n"], "custom 工具 input 增量");
  const ctcDone = byType(res, "response.output_item.done").find((d) => d.item.type === "custom_tool_call");
  eq(ctcDone.item.input, "*** Begin Patch\n+1\n", "custom 工具 done 条目 input 取原始串");
  ok(ctcDone.item.id.startsWith("ctc_"), "custom 条目 id 形状 ctc_");
  const itemDoneTypes = byType(res, "response.output_item.done").map((d) => d.item.type);
  eq(itemDoneTypes, ["reasoning", "message", "function_call", "custom_tool_call"], "条目按 output_index 次序收口");
  ok(byType(res, "response.output_item.done").find((d) => d.item.type === "reasoning").item.status === undefined, "完成的 reasoning 条目不写 status");
  const completed = byType(res, "response.completed")[0].response;
  eq(completed.status, "completed", "completed 状态");
  eq(completed.output.map((o) => o.type), ["reasoning", "message", "function_call", "custom_tool_call"], "completed.output 完整");
  eq(completed.usage, { input_tokens: 10, output_tokens: 5, total_tokens: 15, output_tokens_details: { reasoning_tokens: 0 }, input_tokens_details: { cached_tokens: 4 }, cache_read_input_tokens: 4 }, "用量翻译");
  ok(res.frames.every((f) => typeof f.data.sequence_number === "number"), "每帧带 sequence_number");
  // 条目开场时各自分配到唯一 output_index；收口帧与开场帧的 index 必须一致
  // （收口次序 = 推理→正文→工具，与 CC Switch 的 finalize 次序相同，不与开场次序交叉约束）
  const opened = new Map(byType(res, "response.output_item.added").map((d) => [d.item.id, d.output_index]));
  for (const d of byType(res, "response.output_item.done")) {
    if (opened.has(d.item.id)) ok(d.output_index === opened.get(d.item.id), `${d.item.type} 收口 index 与开场一致`);
  }
  const indices = new Set([...opened.values(), ...byType(res, "response.output_item.done").map((d) => d.output_index)]);
  eq([...indices].sort((a, b) => a - b), [0, 1, 2, 3], "四个条目四个 index");
}

console.log("== SSE 写出（length → incomplete、无名工具丢弃、失败帧）==");
{
  const res = fakeRes();
  const w = new ResponsesSseWriter(res, { model: "m" });
  w.textDelta("partial");
  w.toolCallDelta({ index: 0, id: "call_x", arguments: "{}" });   // 永远没有名字
  const final = w.finalize({ usage: null, finishReason: "length" });
  eq(types(res).slice(-1), ["response.incomplete"], "length → response.incomplete");
  eq(final.status, "incomplete");
  eq(final.incomplete_details, { reason: "max_output_tokens" });
  eq(final.output.map((o) => o.type), ["message"], "无名工具不产出条目");
  eq(w.droppedToolCalls, 1, "丢弃计数");
}
{
  const res = fakeRes();
  const w = new ResponsesSseWriter(res, { model: "m" });
  w.fail("upstream exploded", "upstream_error");
  const f = byType(res, "response.failed")[0];
  eq(f.response.error, { message: "upstream exploded", type: "upstream_error" }, "response.failed 错误体");
  eq(types(res), ["response.created", "response.in_progress", "response.failed"], "失败帧次序");
}

console.log("== 压缩回合（流式）==");
{
  const res = fakeRes();
  streamCompactionAsResponses(res, { text: "handoff summary", model: "m", usage: { input_tokens: 1, output_tokens: 2 } });
  eq(types(res), ["response.created", "response.output_item.done", "response.completed"], "压缩帧序（无 added）");
  const item = byType(res, "response.output_item.done")[0].item;
  eq(item.type, "compaction", "唯一 compaction 条目");
  ok(item.encrypted_content.startsWith(COMPACTION_PREFIX), "信封前缀");
  eq(byType(res, "response.completed")[0].response.output.length, 1, "completed.output 恰一条");
}
{
  const r = compactionToResponses({ text: "s", model: "m", finishReason: "length" });
  eq(r.status, "incomplete", "截断的压缩回合 → incomplete");
  const empty = compactionToResponses({ text: "   ", model: "m" });
  eq(empty.status, "failed", "空摘要 → failed");
}
ok(compactionToResponses({ text: "ok", model: "m" }).output[0].type === "compaction", "非流式压缩条目");

console.log("== 上游 chat SSE 解析 ==");
{
  const sse = [
    'data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"reasoning_content":"深"}}]}\n\ndata: {"choices":[{"index":0,"delta":{"reasoning_content":"思"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":"你"}}]}\n\ndata: {"choices":[{"index":0,"delta":{"content":"好"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"exec_command","arguments":""}}]}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"cmd\\":"}}]}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"ls\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}\n\n',
    "data: [DONE]\n\n",
  ].join("");
  // 故意按 1 字符切块，验证跨块拼行
  const chunks = [...sse].map((c) => c);
  const evs = [];
  for await (const ev of chatSseToNormalized(fromChunks(chunks))) evs.push(ev);
  eq(evs.filter((e) => e.type === "reasoning").map((e) => e.text).join(""), "深思", "推理增量");
  eq(evs.filter((e) => e.type === "text").map((e) => e.text).join(""), "你好", "正文本");
  const tcds = evs.filter((e) => e.type === "tool_call_delta");
  eq(tcds.map((e) => e.arguments).join(""), "{\"cmd\":\"ls\"}", "工具参数拼接");
  const done = evs.at(-1);
  eq(done.type, "done", "以 done 收尾");
  eq(done.finishReason, "tool_calls", "finish_reason 捕获");
  eq(done.usage.prompt_tokens, 7, "usage 捕获（末尾 chunk）");

  // 聚合形状
  const acc = await accumulateChatSse(fromChunks(chunks));
  eq(acc.content, "你好", "聚合正文");
  eq(acc.reasoning_content, "深思", "聚合推理");
  eq(acc.tool_calls, [{ id: "call_1", name: "exec_command", arguments: "{\"cmd\":\"ls\"}" }], "聚合工具调用");
  eq(acc.finish_reason, "tool_calls");
}
{
  // 错误帧必须抛错（前端要转成 response.failed）
  let threw = false;
  try {
    for await (const _ of chatSseToNormalized(fromChunks(['data: {"error":{"message":"boom","type":"quota"}}\n\n']))) { /* noop */ }
  } catch (e) { threw = /boom/.test(e.message); }
  ok(threw, "上游错误帧抛出");
}

console.log("== 非流式翻译 ==");
{
  const chat = {
    choices: [{ message: { content: "done", reasoning_content: "think", tool_calls: [{ id: "call_7", type: "function", function: { name: "multi_agent_v1__spawn_agent", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  };
  const ctx = buildToolContext(codexTools);
  const r = chatCompletionToResponses(chat, { model: "m", responseId: "resp_x", toolContext: ctx });
  eq(r.output.map((o) => o.type), ["reasoning", "message", "function_call"], "非流式条目");
  eq(r.output[2], { id: "fc_call_7", type: "function_call", status: "completed", call_id: "call_7", name: "spawn_agent", arguments: "{}", namespace: "multi_agent_v1" }, "namespace 还原");
  eq(r.usage.total_tokens, 5, "非流式用量");
  eq(r.status, "completed");
}

console.log("== 用量/推理提取穷举 ==");
eq(extractReasoningText({ reasoning_content: "a" }), "a");
eq(extractReasoningText({ reasoning: "b" }), "b");
eq(extractReasoningText({ reasoning: { text: "c" } }), "c");
eq(extractReasoningText({ reasoning_details: [{ text: "d" }] }), "d");
eq(extractReasoningText({ content: "no" }), "");
eq(responsesUsage({ input_tokens: 5, output_tokens: 6 }).total_tokens, 11, "已归一化用量");
eq(responsesUsage({ prompt_tokens: 5, prompt_cache_hit_tokens: 2 }).input_tokens_details, { cached_tokens: 2 }, "DeepSeek cache_hit 兜底");
eq(responsesUsage(null).input_tokens, 0, "空用量不炸");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
