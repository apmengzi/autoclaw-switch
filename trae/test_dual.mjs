#!/usr/bin/env node
/**
 * Offline acceptance test for the dual-channel relay.
 *
 * Spins up a fake Trae upstream (no quota, no network) and a relay child
 * process pointed at it, then exercises:
 *   - llm_utils_chat text / reasoning / tool_calls parsing
 *   - OpenAI and Anthropic streaming shapes, including tool_use blocks
 *   - 2001 "failed to get app config" -> automatic chat_sessions fallback
 *   - inbound api_key gate
 *
 *   node test_dual.mjs
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_PORT = 19001;
const RELAY_PORT = 19081;
const RELAY = `http://127.0.0.1:${RELAY_PORT}`;

const fake = { mode: "good", sessionMode: "ok", failModel: null, failExact: null, llmHits: 0, sessionHits: 0 };

const SESSION_TOOL_TEXT = '```tool_call\n{"name":"get_weather","arguments":{"city":"北京"}}\n```';
const SESSION_LONG_TEXT = "这是一段用于验证流式输出的正文。".repeat(8);
// Weak-model shape seen live: lowercase tool name, flattened parameters, extra brace.
const SESSION_FLAT_TEXT = '```tool_call\n{"name":"Get_Weather","city":"北京"}}\n```';
// Upstream finish-summary truncation: closing braces/fence are gone, but every
// required argument is complete (the cut landed in an optional field).
const SESSION_TRUNC_SAFE = '```tool_call\n{"name":"get_weather","arguments":{"city":"北京","note":"extra"';
// Cut in the middle of a required argument: must NOT be repaired into a call.
const SESSION_TRUNC_UNSAFE = '```tool_call\n{"name":"get_weather","arguments":{"city":"北';

const send = (res, obj) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
};
const sseHead = (res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
};
const frame = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

const fakeServer = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const path = url.pathname;
  if (path === "/api/remote/v1/models") {
    return send(res, {
      code: 0,
      data: {
        list: [
          {
            function: "solo_work_lite",
            models: [
              { name: "Doubao-Seed-Code", display_name: "Doubao Seed Code", context_window_tokens: 200000, multimodal: true },
              { name: "glm-5.1", display_name: "GLM 5.1", context_window_tokens: 128000, multimodal: false },
            ],
          },
          {
            function: "chat_v3",
            models: [
              { name: "DeepSeek-V4-Flash", display_name: "DeepSeek V4 Flash", context_window_tokens: 128000 },
              { name: "deepseek-v4-flash", display_name: "deepseek v4 flash", context_window_tokens: 128000 },
              { name: "kimi-k2.6", display_name: "Kimi K2.6", context_window_tokens: 256000 },
            ],
          },
        ],
      },
    });
  }
  if (path === "/api/agent/v3/llm_utils_chat") {
    fake.llmHits++;
    let raw = "";
    for await (const c of req) raw += c;
    try { fake.lastLlmBody = JSON.parse(raw); } catch { fake.lastLlmBody = null; }
    if (fake.mode === "2001") {
      return send(res, { code: 2001, message: "failed to do chat: failed to get app config: record not found" });
    }
    sseHead(res);
    frame(res, "output", { reasoning_content: "想" });
    frame(res, "output", { reasoning_content: "一想" });
    frame(res, "output", { content: "你" });
    frame(res, "output", { content: "好" });
    frame(res, "output", {
      tool_calls: [{ index: 0, id: "call_1", function_call: { name: "get_weather", arguments: '{"city":' } }],
    });
    frame(res, "output", { tool_calls: [{ index: 0, function_call: { arguments: '"北京"}' } }] });
    frame(res, "token_usage", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    frame(res, "done", { finish_reason: "tool_calls" });
    return res.end();
  }
  if (path === "/api/remote/v1/chat_sessions" && req.method === "POST") {
    fake.sessionHits++;
    let raw = "";
    for await (const c of req) raw += c;
    try { fake.lastSessionBody = JSON.parse(raw); } catch { fake.lastSessionBody = null; }
    return send(res, { code: 0, data: { chat_session_id: "fake-session-1" } });
  }
  if (/^\/api\/remote\/v1\/chat_sessions\/[^/]+\/events$/.test(path)) {
    sseHead(res);
    if (fake.sessionMode === "toolcall" || fake.sessionMode === "flat" || fake.sessionMode === "truncatedSafe" || fake.sessionMode === "truncatedUnsafe") {
      const text = fake.sessionMode === "flat" ? SESSION_FLAT_TEXT
        : fake.sessionMode === "truncatedSafe" ? SESSION_TRUNC_SAFE
        : fake.sessionMode === "truncatedUnsafe" ? SESSION_TRUNC_UNSAFE
        : SESSION_TOOL_TEXT;
      frame(res, "plan_item", { id: 2, thought: text });
      frame(res, "done", {});
      return res.end();
    }
    if (fake.sessionMode === "long") {
      const step = Math.ceil(SESSION_LONG_TEXT.length / 4);
      for (let i = 1; i <= 4; i++) {
        frame(res, "plan_item", { id: 3, thought: SESSION_LONG_TEXT.slice(0, step * i) });
      }
      frame(res, "done", {});
      return res.end();
    }
    frame(res, "plan_item", { id: 1, thought: "第一段" });
    frame(res, "plan_item", { id: 1, thought: "第一段第二段" });
    frame(res, "done", {});
    return res.end();
  }
  if (/^\/api\/remote\/v1\/chat_sessions\/[^/]+\/messages$/.test(path)) {
    const model = fake.lastSessionBody?.initial_message?.model_name || "";
    if (fake.sessionMode === "failed" || (fake.failExact && model === fake.failExact) || (fake.failModel && model.toLowerCase() === fake.failModel.toLowerCase())) {
      return send(res, {
        code: 0,
        data: {
          items: [{
            role: "assistant",
            status: "failed",
            error: JSON.stringify({ code: 4001, message: `config item is empty. Function: solo_agent_remote, ConfigName: ${model}` }),
            content: JSON.stringify({ messages: [] }),
          }],
        },
      });
    }
    const thought = fake.sessionMode === "toolcall" ? SESSION_TOOL_TEXT
      : fake.sessionMode === "flat" ? SESSION_FLAT_TEXT
      : fake.sessionMode === "truncatedSafe" ? SESSION_TRUNC_SAFE
      : fake.sessionMode === "truncatedUnsafe" ? SESSION_TRUNC_UNSAFE
      : fake.sessionMode === "long" ? SESSION_LONG_TEXT
      : "第一段第二段";
    return send(res, {
      code: 0,
      data: {
        items: [{
          role: "assistant",
          status: "completed",
          content: JSON.stringify({ messages: [{ plan_item: { id: fake.sessionMode === "toolcall" ? 2 : 1, thought } }] }),
        }],
      },
    });
  }
  res.writeHead(404, { "Content-Type": "text/html" });
  res.end("not found");
});

const t = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!ok) process.exitCode = 1;
};

const post = (path, body, headers = {}) =>
  fetch(RELAY + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

async function readSse(res) {
  const out = [];
  let buf = "";
  const dec = new TextDecoder();
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const event = raw.split("\n").find((l) => l.startsWith("event:"))?.slice(6).trim() || "";
      const data = raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      let payload = null;
      try { payload = JSON.parse(data); } catch { payload = data; }
      out.push({ event, payload });
    }
  }
  return out;
}

const waitFor = async (url, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timeout waiting for " + url);
};

await new Promise((r) => fakeServer.listen(FAKE_PORT, "127.0.0.1", r));

function startRelay(env) {
  const child = spawn(process.execPath, [join(HERE, "relay.mjs"), "--port", String(RELAY_PORT)], {
    cwd: HERE,
    env: {
      ...process.env,
      TRAE_HOSTS: `http://127.0.0.1:${FAKE_PORT}`,
      TRAE_UPSTREAM: "auto",
      TRAE_LLM_RETRY_MS: "600000",
      TRAE_MODEL_CACHE_MS: "0",
      TRAE_INBOUND_AUTH: "0",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.env.VERBOSE && process.stdout.write("[relay] " + d));
  child.stderr.on("data", (d) => process.stdout.write("[relay:err] " + d));
  return child;
}

let relay = startRelay();
try {
  await waitFor(RELAY + "/health");

  // ---- 1. health exposes both channels -------------------------------------
  let h = await (await fetch(RELAY + "/health")).json();
  t("health: 双通道可见", h.channels?.llm_utils_chat && h.channels?.chat_sessions, `mode=${h.upstream_mode}`);
  t("health: 模型缓存", Array.isArray(h.models) && h.models.includes("Doubao-Seed-Code"), `models=${h.models.length}`);

  // ---- 2. llm channel non-stream: text + reasoning + usage ------------------
  let r = await post("/v1/chat/completions", {
    model: "Doubao-Seed-Code",
    messages: [{ role: "user", content: "你好" }],
    tools: [{ type: "function", function: { name: "get_weather", description: "weather", parameters: { type: "object", properties: { city: { type: "string" } } } } }],
  });
  let j = await r.json();
  const chan = r.headers.get("x-upstream-channel");
  t("llm: 非流式走 llm_utils_chat", j.trae?.channel === "llm", `channel=${j.trae?.channel}${chan ? " hdr=" + chan : ""}`);
  t("llm: 文本拼装", j.choices?.[0]?.message?.content === "你好", JSON.stringify(j.choices?.[0]?.message?.content));
  t("llm: reasoning_content", j.choices?.[0]?.message?.reasoning_content === "想一想", JSON.stringify(j.choices?.[0]?.message?.reasoning_content));
  t("llm: usage 归一", j.usage?.prompt_tokens === 10 && j.usage?.completion_tokens === 5 && j.usage?.total_tokens === 15, JSON.stringify(j.usage));
  const lb = fake.lastLlmBody || {};
  t("llm: 请求体形状", lb.function === "solo_work_lite" && lb.model === "Doubao-Seed-Code" && lb.messages?.[0]?.content?.[0]?.text === "你好" && !!lb.session_id, JSON.stringify({ function: lb.function, model: lb.model, content: lb.messages?.[0]?.content }));
  t("llm: 工具参数转 JSON 字符串", typeof lb.tools?.[0]?.function?.parameters === "string" && JSON.parse(lb.tools[0].function.parameters).properties?.city?.type === "string", String(lb.tools?.[0]?.function?.parameters));

  // ---- 3. llm streaming: deltas + tool_calls + finish_reason ----------------
  r = await post("/v1/chat/completions", {
    model: "glm-5.1",
    stream: true,
    messages: [{ role: "user", content: "天气" }],
    tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }],
  });
  const evs = await readSse(r);
  let text = "", reason = "", tc = null, finish = null;
  for (const e of evs) {
    const d = e.payload?.choices?.[0]?.delta || {};
    if (d.content) text += d.content;
    if (d.reasoning_content) reason += d.reasoning_content;
    if (d.tool_calls) tc = d.tool_calls[0];
    if (e.payload?.choices?.[0]?.finish_reason) finish = e.payload.choices[0].finish_reason;
  }
  t("llm 流式: 文本增量", text === "你好", JSON.stringify(text));
  t("llm 流式: 推理增量", reason === "想一想", JSON.stringify(reason));
  t("llm 流式: 工具调用", tc?.id === "call_1" && tc?.function?.name === "get_weather" && tc?.function?.arguments === '{"city":"北京"}', JSON.stringify(tc));
  t("llm 流式: finish_reason=tool_calls", finish === "tool_calls", String(finish));

  // ---- 4. Anthropic non-stream: thinking block ------------------------------
  r = await post("/v1/messages", {
    model: "DeepSeek-V4-Flash",
    max_tokens: 100,
    thinking: { type: "enabled", budget_tokens: 64 },
    messages: [{ role: "user", content: "你好" }],
  });
  j = await r.json();
  t("anthropic: thinking + text 两块", j.content?.[0]?.type === "thinking" && j.content?.[0]?.thinking === "想一想" && j.content?.[1]?.type === "text" && j.content?.[1]?.text === "你好", JSON.stringify(j.content));
  t("anthropic: usage 归一", j.usage?.input_tokens === 10 && j.usage?.output_tokens === 5, JSON.stringify(j.usage));

  // ---- 5. Anthropic streaming: tool_use block ------------------------------
  r = await post("/v1/messages", {
    model: "kimi-k2.6",
    max_tokens: 100,
    stream: true,
    messages: [{ role: "user", content: "天气" }],
    tools: [{ name: "get_weather", input_schema: { type: "object" } }],
  });
  const aev = await readSse(r);
  const types = aev.map((e) => e.event);
  const toolStart = aev.find((e) => e.event === "content_block_start" && e.payload?.content_block?.type === "tool_use");
  const jsonDelta = aev.find((e) => e.event === "content_block_delta" && e.payload?.delta?.type === "input_json_delta");
  const msgDelta = aev.find((e) => e.event === "message_delta");
  t("anthropic 流式: 事件序列", types.includes("message_start") && types.includes("content_block_stop") && types.includes("message_stop"), types.join(","));
  t("anthropic 流式: tool_use 块", toolStart?.payload?.content_block?.name === "get_weather", JSON.stringify(toolStart?.payload?.content_block));
  t("anthropic 流式: input_json_delta", jsonDelta?.payload?.delta?.partial_json === '{"city":"北京"}', JSON.stringify(jsonDelta?.payload?.delta));
  t("anthropic 流式: stop_reason=tool_use", msgDelta?.payload?.delta?.stop_reason === "tool_use", JSON.stringify(msgDelta?.payload?.delta));
  const ab = fake.lastLlmBody || {};
  t("anthropic: input_schema 映射到 parameters", ab.function === "chat_v3" && ab.tools?.[0]?.function?.parameters === '{"type":"object"}', JSON.stringify({ function: ab.function, tools: ab.tools }));

  // ---- 6. 2001 -> auto fallback to chat_sessions ---------------------------
  fake.mode = "2001";
  const before = fake.llmHits;
  r = await post("/v1/chat/completions", {
    model: "glm-5.1",
    messages: [{ role: "user", content: "回退测试" }],
  });
  j = await r.json();
  t("回退: 2001 后自动走 session", j.trae?.channel === "session" && j.choices?.[0]?.message?.content === "第一段第二段", `channel=${j.trae?.channel} text=${JSON.stringify(j.choices?.[0]?.message?.content)}`);
  t("回退: 仍带 session_id", j.trae?.session_id === "fake-session-1", String(j.trae?.session_id));
  h = await (await fetch(RELAY + "/health")).json();
  t("回退: health 标记 llm 不可用", h.channels?.llm_utils_chat?.available === false && /2001/.test(JSON.stringify(h.channels?.llm_utils_chat?.last_error)), JSON.stringify(h.channels?.llm_utils_chat?.last_error));

  const afterFirst = fake.llmHits;
  r = await post("/v1/chat/completions", {
    model: "glm-5.1",
    messages: [{ role: "user", content: "第二次" }],
  });
  j = await r.json();
  t("回退: 冷却期内不再打 llm", j.trae?.channel === "session" && fake.llmHits === afterFirst, `hits ${before}->${afterFirst}->${fake.llmHits}`);

  // ---- 7. streaming fallback emits session deltas then done ----------------
  r = await post("/v1/chat/completions", {
    model: "glm-5.1",
    stream: true,
    messages: [{ role: "user", content: "流式回退" }],
  });
  const sev = await readSse(r);
  const sText = sev.map((e) => e.payload?.choices?.[0]?.delta?.content || "").join("");
  t("回退流式: 增量不重复", sText === "第一段第二段", JSON.stringify(sText));

  // ---- 8. session channel flattens Anthropic tool blocks -------------------
  await post("/v1/messages", {
    model: "glm-5.1",
    messages: [
      { role: "user", content: "北京天气" },
      { role: "assistant", content: [
        { type: "text", text: "我查一下" },
        { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "北京" } },
      ] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "25°C" }] },
    ],
  });
  const q = JSON.parse(fake.lastSessionBody.initial_message.query)[0].data.content;
  t("session: Anthropic 工具块拍平", q.includes('[Tool calls] get_weather({"city":"北京"})') && q.includes("[Tool result call_1] 25°C"), JSON.stringify(q.slice(-180)));

  // ---- 9. session 4001: explicit error, health mark, model list filter -----
  fake.sessionMode = "failed";
  r = await post("/v1/chat/completions", {
    model: "glm-5.1",
    messages: [{ role: "user", content: "欠配置" }],
  });
  j = await r.json();
  t("4001: 非流式 502 明确报错", r.status === 502 && j.error?.code === "4001" && /not provisioned/.test(j.error?.message || ""), `status=${r.status} ${JSON.stringify(j.error)}`);
  h = await (await fetch(RELAY + "/health")).json();
  t("4001: health 标记坏模型", (h.model_health || []).some((x) => x.model === "glm-5.1" && x.active && x.code === "4001"), JSON.stringify(h.model_health));
  const listed = await (await fetch(RELAY + "/v1/models")).json();
  t("4001: 坏模型从 /v1/models 隐藏", !listed.data.some((m) => m.id === "glm-5.1") && listed.data.some((m) => m.id === "kimi-k2.6"), listed.data.map((m) => m.id).join(","));

  r = await post("/v1/chat/completions", {
    model: "glm-5.1",
    stream: true,
    messages: [{ role: "user", content: "欠配置流式" }],
  });
  const fev = await readSse(r);
  const fText = fev.map((e) => e.payload?.choices?.[0]?.delta?.content || "").join("");
  t("4001: 流式明确报错", /\[relay error\]/.test(fText) && /4001/.test(fText), JSON.stringify(fText.slice(0, 120)));

  // ---- 10. chat_sessions 上的模拟工具调用 ---------------------------------
  fake.sessionMode = "toolcall";
  const weatherTool = {
    type: "function",
    function: { name: "get_weather", description: "weather", parameters: { type: "object", properties: { city: { type: "string" } } } },
  };
  r = await post("/v1/chat/completions", {
    model: "glm-5.1",
    messages: [{ role: "user", content: "查北京天气" }],
    tools: [weatherTool],
  });
  j = await r.json();
  let m = j.choices?.[0]?.message;
  t("模拟工具: OpenAI tool_calls", m?.tool_calls?.[0]?.function?.name === "get_weather" && JSON.parse(m.tool_calls[0].function.arguments).city === "北京" && m?.content === null, JSON.stringify(m));
  t("模拟工具: finish_reason=tool_calls", j.choices?.[0]?.finish_reason === "tool_calls", String(j.choices?.[0]?.finish_reason));
  const tq = JSON.parse(fake.lastSessionBody.initial_message.query)[0].data.content;
  t("模拟工具: 注入工具契约", tq.includes("[Tool protocol]") && tq.includes("get_weather") && tq.includes("```tool_call"), JSON.stringify(tq.slice(0, 160)));

  r = await post("/v1/messages", {
    model: "glm-5.1",
    max_tokens: 100,
    messages: [{ role: "user", content: "查天气" }],
    tools: [{ name: "get_weather", input_schema: { type: "object", properties: { city: { type: "string" } } } }],
  });
  j = await r.json();
  t("模拟工具: Anthropic tool_use", j.stop_reason === "tool_use" && j.content?.some((b) => b.type === "tool_use" && b.name === "get_weather" && b.input?.city === "北京"), JSON.stringify(j.content));

  // 带 tools 的正文仍要流式，不能整段憋到最后
  fake.sessionMode = "long";
  r = await post("/v1/chat/completions", {
    model: "glm-5.1",
    stream: true,
    messages: [{ role: "user", content: "写一段长文" }],
    tools: [weatherTool],
  });
  const lev = await readSse(r);
  const lText = lev.map((e) => e.payload?.choices?.[0]?.delta?.content || "").join("");
  const contentChunks = lev.filter((e) => (e.payload?.choices?.[0]?.delta?.content || "").length > 0).length;
  const lFinish = lev.find((e) => e.payload?.choices?.[0]?.finish_reason)?.payload?.choices?.[0]?.finish_reason;
  t("模拟工具: 正文仍然流式", lText === SESSION_LONG_TEXT && contentChunks >= 2 && lFinish === "stop", `chunks=${contentChunks} ${JSON.stringify(lText.slice(0, 40))}`);

  // 流式工具调用不能把 fenced 标记漏给客户端
  fake.sessionMode = "toolcall";
  r = await post("/v1/chat/completions", {
    model: "glm-5.1",
    stream: true,
    messages: [{ role: "user", content: "查北京天气" }],
    tools: [weatherTool],
  });
  const tev = await readSse(r);
  const tText = tev.map((e) => e.payload?.choices?.[0]?.delta?.content || "").join("");
  const tCall = tev.flatMap((e) => e.payload?.choices?.[0]?.delta?.tool_calls || [])[0];
  const tFinish = tev.find((e) => e.payload?.choices?.[0]?.finish_reason)?.payload?.choices?.[0]?.finish_reason;
  t("模拟工具: 流式不漏标记", !tText.includes("```") && !tText.includes('"name"') && tCall?.function?.name === "get_weather" && tFinish === "tool_calls", `text=${JSON.stringify(tText)} call=${JSON.stringify(tCall)}`);

  // 弱模型的坏形状：平铺参数、多余大括号、工具名大小写不一致
  fake.sessionMode = "flat";
  r = await post("/v1/chat/completions", {
    model: "glm-5.1",
    messages: [{ role: "user", content: "查北京天气" }],
    tools: [weatherTool],
  });
  j = await r.json();
  const flatCall = j.choices?.[0]?.message?.tool_calls?.[0];
  t("模拟工具: 容错平铺参数/多余括号/大小写", flatCall?.function?.name === "get_weather" && JSON.parse(flatCall.function.arguments).city === "北京", JSON.stringify(flatCall));

  r = await post("/v1/chat/completions", {
    model: "glm-5.1",
    stream: true,
    messages: [{ role: "user", content: "查北京天气" }],
    tools: [weatherTool],
  });
  const flatEv = await readSse(r);
  const flatText = flatEv.map((e) => e.payload?.choices?.[0]?.delta?.content || "").join("");
  const flatStreamCall = flatEv.flatMap((e) => e.payload?.choices?.[0]?.delta?.tool_calls || [])[0];
  t("模拟工具: 坏形状流式也不漏", !flatText.includes("```") && flatStreamCall?.function?.name === "get_weather" && JSON.parse(flatStreamCall.function.arguments).city === "北京", `text=${JSON.stringify(flatText)} call=${JSON.stringify(flatStreamCall)}`);

  // 上游 finish summary 截断：必需参数完整时修复，缺必需参数时拒绝执行
  fake.sessionMode = "truncatedSafe";
  r = await post("/v1/chat/completions", {
    model: "glm-5.1",
    stream: true,
    messages: [{ role: "user", content: "查北京天气" }],
    tools: [weatherTool],
  });
  const trEv = await readSse(r);
  const trText = trEv.map((e) => e.payload?.choices?.[0]?.delta?.content || "").join("");
  const trCall = trEv.flatMap((e) => e.payload?.choices?.[0]?.delta?.tool_calls || [])[0];
  t("模拟工具: 上游截断可安全修复", !trText.includes("```") && JSON.parse(trCall?.function?.arguments || "{}").city === "北京", `text=${JSON.stringify(trText)} call=${JSON.stringify(trCall)}`);

  fake.sessionMode = "truncatedUnsafe";
  r = await post("/v1/chat/completions", {
    model: "glm-5.1",
    messages: [{ role: "user", content: "查北京天气" }],
    tools: [weatherTool],
  });
  j = await r.json();
  const unsafeCalls = j.choices?.[0]?.message?.tool_calls || [];
  const unsafeText = String(j.choices?.[0]?.message?.content || "");
  t("模拟工具: 必需参数被截断不执行", unsafeCalls.length === 0 && unsafeText.includes("不完整") && !unsafeText.includes("```"), JSON.stringify(j.choices?.[0]?.message));

  r = await post("/v1/chat/completions", {
    model: "glm-5.1",
    stream: true,
    messages: [{ role: "user", content: "查北京天气" }],
    tools: [weatherTool],
  });
  const unEv = await readSse(r);
  const unText = unEv.map((e) => e.payload?.choices?.[0]?.delta?.content || "").join("");
  const unCall = unEv.flatMap((e) => e.payload?.choices?.[0]?.delta?.tool_calls || [])[0];
  t("模拟工具: 截断流式不漏原始块", !unCall && unText.includes("不完整") && !unText.includes("```"), `text=${JSON.stringify(unText)}`);

  fake.sessionMode = "ok";

  // ---- 10b. 同一模型大小写拼写不同：4001 后自动换拼写 ---------------------
  fake.failExact = "deepseek-v4-flash";
  r = await post("/v1/chat/completions", {
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: "别名" }],
  });
  j = await r.json();
  t("大小写别名: 4001 后自动换拼写", j.choices?.[0]?.message?.content === "第一段第二段" && j.trae?.model_alias === "DeepSeek-V4-Flash", JSON.stringify(j.trae));
  fake.failExact = null;

  relay.kill();
  await new Promise((r) => setTimeout(r, 300));

  // ---- 11. TRAE_MODEL_FALLBACK: 4001 model swaps to a working one ---------
  relay = startRelay({ TRAE_MODEL_FALLBACK: "glm-5.1" });
  await waitFor(RELAY + "/health");
  fake.failModel = "deepseek-v4-flash";
  r = await post("/v1/chat/completions", {
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: "回退模型" }],
  });
  j = await r.json();
  t("模型回退: 4001 自动换 glm-5.1", j.choices?.[0]?.message?.content === "第一段第二段" && j.trae?.model_fallback === true && String(j.trae?.requested_model).toLowerCase() === "deepseek-v4-flash", JSON.stringify(j.trae));
  const fh = await (await fetch(RELAY + "/health")).json();
  t("模型回退: 失败模型入健康表", (fh.model_health || []).some((x) => x.model.toLowerCase() === "deepseek-v4-flash" && x.active && x.code === "4001"), JSON.stringify(fh.model_health));
  fake.failModel = null;
  relay.kill();
  await new Promise((r) => setTimeout(r, 300));

  // ---- 8. inbound api_key gate --------------------------------------------
  relay = startRelay({ TRAE_INBOUND_AUTH: "1", TRAE_INBOUND_KEYS: "sk-test-gate" });
  await waitFor(RELAY + "/health");
  const noKey = await post("/v1/chat/completions", { model: "glm-5.1", messages: [{ role: "user", content: "x" }] });
  const noKeyBody = await noKey.json();
  t("闸门: 无钥 401", noKey.status === 401 && /unauthorized/.test(noKeyBody.error?.message || ""), `status=${noKey.status}`);
  const badKey = await post("/v1/chat/completions", { model: "glm-5.1", messages: [{ role: "user", content: "x" }] }, { Authorization: "Bearer wrong" });
  t("闸门: 错钥 401", badKey.status === 401, `status=${badKey.status}`);
  const goodKey = await post("/v1/chat/completions", { model: "glm-5.1", messages: [{ role: "user", content: "x" }] }, { Authorization: "Bearer sk-test-gate" });
  const goodBody = await goodKey.json();
  t("闸门: 正确钥放行", goodKey.status === 200 && !!goodBody.choices?.[0]?.message?.content, `status=${goodKey.status}`);
  const anthropicNoKey = await post("/v1/messages", { model: "glm-5.1", messages: [{ role: "user", content: "x" }] });
  const anthropicNoKeyBody = await anthropicNoKey.json();
  t("闸门: anthropic 错误形状", anthropicNoKey.status === 401 && anthropicNoKeyBody.type === "error", `status=${anthropicNoKey.status}`);
} finally {
  relay.kill();
  fakeServer.close();
}
console.log("\ndone");
