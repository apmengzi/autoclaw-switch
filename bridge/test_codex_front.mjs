#!/usr/bin/env node
/**
 * Codex 前门（bridge/codex_front.mjs）离线集成测试：`node bridge/test_codex_front.mjs`
 *
 * 起一个假 WorkBuddy 上游（chat completions + models + 401 + 非 JSON），让前门连它：
 *   1 流式：/wb/v1/responses → 真流式 Responses 事件（推理/正文/工具/用量）
 *   2 透传：/wb/v1/models 原样回（状态码/头/体），Authorization 原样转给上游
 *   3 上游 401：状态码与错误体逐字回传（Codex 的供应商语义靠它）
 *   4 非流式 responses + 路径无前缀形态（/v1/responses → 唯一 link）
 *   5 /health 汇总与压缩回合（compaction_trigger）
 *   6 上游 200 但非 JSON：502 明确报错，不给 Codex 半截响应
 */
import { createServer, request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push([name, true]); }
  catch (e) { results.push([name, false, e.message + (process.env.FRONT_TEST_DEBUG ? "\n    " + String(e.stack).split("\n").slice(1, 5).join("\n    ") : "")]); }
};
const assert = (c, m) => { if (!c) throw new Error(m || "assert failed"); };
const eq = (a, b, m) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${m || "not equal"}: ${A} !== ${B}`);
};

// ------------------------------------------------------------- 假 WorkBuddy 上游
const up = { mode: "sse", seen: [], auth: [] };
const chatSse = (chunks) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
const upstream = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  let body = "";
  for await (const c of req) body += c;
  up.seen.push({ method: req.method, path: url.pathname, body: body ? JSON.parse(body) : null });
  up.auth.push(req.headers.authorization || req.headers["x-api-key"] || "");
  const json = (o, status = 200, headers = {}) => {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(JSON.stringify(o));
  };
  if (url.pathname === "/v1/models") {
    if (up.mode === "401") return json({ error: { message: "invalid api key", type: "invalid_request_error" } }, 401);
    return json({ object: "list", data: [{ id: "glm-5.2", object: "model" }] }, 200, { "x-upstream": "wb" });
  }
  if (url.pathname === "/v1/chat/completions") {
    if (up.mode === "401") return json({ error: { message: "invalid api key", type: "invalid_request_error" } }, 401);
    if (up.mode === "402") return json({ error: { message: "积分不足，请充值", type: "insufficient_quota" } }, 402);
    if (up.mode === "nonjson") { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("not json at all"); return; }
    const p = body ? JSON.parse(body) : {};
    if (!p.stream) {
      return json({
        id: "chatcmpl-1", object: "chat.completion", model: p.model,
        choices: [{ index: 0, message: { role: "assistant", content: "非流式答案", reasoning_content: "非流式思考" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
      });
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(chatSse([
      { choices: [{ index: 0, delta: { role: "assistant" } }] },
      { choices: [{ index: 0, delta: { reasoning_content: "先想" } }] },
      { choices: [{ index: 0, delta: { content: "记 " } }] },
      { choices: [{ index: 0, delta: { content: "ls" } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_wb1", function: { name: "exec_command", arguments: "" } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{\"cmd\":\"ls\"}" } }] }, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 11, completion_tokens: 6, total_tokens: 17, prompt_tokens_details: { cached_tokens: 3 } } },
    ]));
    res.end();
    return;
  }
  json({ error: { message: "no route" } }, 404);
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const UP = `http://127.0.0.1:${upstream.address().port}`;

// ------------------------------------------------------------- 起前门
const PORT = 18776 + Math.floor(Math.random() * 500);
const front = spawn(process.execPath, [path.join(here, "codex_front.mjs"), "--port", String(PORT), "--wb", UP],
  { stdio: ["ignore", "pipe", "pipe"] });
let frontLog = "";
front.stdout.on("data", (d) => (frontLog += d.toString()));
front.stderr.on("data", (d) => (frontLog += d.toString()));
const waitReady = async () => {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) return true;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};
const ready = await waitReady();
if (!ready) { console.log("前门未就绪：\n" + frontLog); process.exit(1); }

function postSse(pathname, body, headers = {}) {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port: PORT, path: pathname, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), ...headers } }, (res) => {
      const frames = [];
      let buf = "";
      res.on("data", (c) => {
        buf += c.toString("utf8");
        const blocks = buf.split("\n\n");
        buf = blocks.pop() ?? "";
        for (const b of blocks) {
          if (!b.trim()) continue;
          const ev = /^event: (.+)$/m.exec(b)?.[1];
          const dl = /^data: (.+)$/m.exec(b)?.[1];
          if (dl === "[DONE]") { frames.push({ event: "DONE" }); continue; }
          if (!dl) continue;
          try { frames.push({ event: ev, data: JSON.parse(dl) }); } catch {}
        }
      });
      res.on("end", () => resolve({ frames, status: res.statusCode }));
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}
function postJson(pathname, body, headers = {}) {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port: PORT, path: pathname, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), ...headers } }, (res) => {
      let t = "";
      res.on("data", (c) => (t += c));
      res.on("end", () => resolve({ status: res.statusCode, text: t, headers: res.headers }));
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}
const codexBody = (extra = {}) => ({
  model: "glm-5.2", instructions: "You are Codex.", stream: true,
  tools: [{ type: "function", name: "exec_command", description: "run", parameters: { type: "object", properties: { cmd: { type: "string" } } } }],
  tool_choice: "auto", reasoning: { summary: "auto" }, store: false,
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "跑 ls" }] }],
  ...extra,
});
const evOf = (r, t) => r.frames.filter((f) => f.event === t).map((f) => f.data);

// ---------------------------------------------------------------- 1 流式
await check("1 流式 /wb/v1/responses：推理/正文/工具/用量，Authorization 原样上游", async () => {
  up.mode = "sse"; up.seen = []; up.auth = [];
  const r = await postSse("/wb/v1/responses", codexBody(), { Authorization: "Bearer wb-secret-key" });
  assert(r.status === 200, `status ${r.status}`);
  const types = r.frames.map((f) => f.event);
  eq(types.slice(0, 2), ["response.created", "response.in_progress"], "开头");
  eq(types.at(-2), "response.completed", "结尾 completed（再跟 [DONE]）");
  eq(evOf(r, "response.reasoning_summary_text.delta").map((d) => d.delta), ["先想"], "推理");
  eq(evOf(r, "response.output_text.delta").map((d) => d.delta).join(""), "记 ls", "正文逐片");
  const fc = evOf(r, "response.output_item.done").find((d) => d.item.type === "function_call").item;
  eq(fc.name, "exec_command", "工具名");
  eq(fc.call_id, "call_wb1", "call_id");
  eq(JSON.parse(fc.arguments), { cmd: "ls" }, "参数合并");
  const final = evOf(r, "response.completed")[0].response;
  eq(final.output.map((o) => o.type), ["reasoning", "message", "function_call"], "条目");
  eq(final.usage, {
    input_tokens: 11, output_tokens: 6, total_tokens: 17,
    output_tokens_details: { reasoning_tokens: 0 },
    input_tokens_details: { cached_tokens: 3 }, cache_read_input_tokens: 3,
  }, "用量（含缓存命中）");
  eq(up.auth[0], "Bearer wb-secret-key", "Authorization 原样透传");
  // 前门发给上游的请求体是 chat 形状：system 折叠 + tools 降级 + max_tokens 钳制
  const sent = up.seen[0].body;
  eq(sent.messages[0], { role: "system", content: "You are Codex." }, "instructions → system");
  eq(sent.messages[1], { role: "user", content: "跑 ls" }, "input → user");
  eq(sent.tools[0].function.name, "exec_command", "工具透传");
  eq(sent.stream, true, "stream");
  eq(sent.stream_options, { include_usage: true }, "include_usage");
  eq(sent.max_tokens, 8192, "max_tokens 钳到默认安全值");
});

// ---------------------------------------------------------------- 2 透传
await check("2 透传 /wb/v1/models：状态码/自定义头/体原样，钥匙原样", async () => {
  up.mode = "sse"; up.seen = []; up.auth = [];
  const r = await fetch(`http://127.0.0.1:${PORT}/wb/v1/models`, { headers: { Authorization: "Bearer wb-secret-key" } });
  eq(r.status, 200, "状态码");
  eq(r.headers.get("x-upstream"), "wb", "上游自定义头");
  const j = await r.json();
  eq(j.data[0].id, "glm-5.2", "体原样");
  eq(up.auth[0], "Bearer wb-secret-key", "钥匙透传");
});

// ---------------------------------------------------------------- 3 401
await check("3 上游 401/402：状态码与错误体逐字回传（供应商语义）", async () => {
  up.mode = "401";
  const r = await postJson("/wb/v1/responses", codexBody({ stream: false }), { Authorization: "Bearer wrong" });
  eq(r.status, 401, "401 透传");
  eq(JSON.parse(r.text).error.message, "invalid api key", "错误体逐字");
  up.mode = "402";
  const r2 = await postJson("/wb/v1/responses", codexBody({ stream: false }), { Authorization: "Bearer x" });
  eq(r2.status, 402, "402 透传");
  assert(JSON.parse(r2.text).error.message.includes("积分"), "402 文案");
  up.mode = "sse";
});

// ---------------------------------------------------------------- 4 非流式 + 无前缀
await check("4 非流式 + 裸路径 /v1/responses（唯一 link）", async () => {
  up.mode = "sse"; up.seen = [];
  const r = await postJson("/v1/responses", codexBody({ stream: false }));
  eq(r.status, 200, "status");
  const j = JSON.parse(r.text);
  eq(j.output.map((o) => o.type), ["reasoning", "message"], "条目");
  eq(j.output[1].content[0].text, "非流式答案", "正文");
  eq(j.output[0].summary[0].text, "非流式思考", "推理");
  eq(j.usage.total_tokens, 13, "用量");
  eq(up.seen[0].body.stream, undefined, "上游收到非流式请求");
});

// ---------------------------------------------------------------- 5 health + 压缩
await check("5 /health 汇总；压缩回合恰一个 compaction 条目", async () => {
  const h = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
  eq(h.service, "codex-front", "service");
  assert(h.responsesCalls >= 4, "计数");
  assert(h.links.wb === UP, "link 表");
  up.mode = "sse"; up.seen = [];
  const r = await postSse("/wb/v1/responses", codexBody({
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "go" }] }, { type: "compaction_trigger" }],
  }));
  const done = evOf(r, "response.output_item.done");
  eq(done.length, 1, "恰一个 done");
  eq(done[0].item.type, "compaction", "compaction 条目");
  assert(!evOf(r, "response.output_item.added").length, "压缩不发 added");
  eq(evOf(r, "response.completed")[0].response.output.length, 1, "completed.output 一条");
  assert(up.seen[0].body.messages.at(-1).content.includes("CONTEXT CHECKPOINT COMPACTION"), "压缩提示词");
  assert(up.seen[0].body.tools === undefined, "压缩不带工具");
});

// ---------------------------------------------------------------- 6 非 JSON 200
await check("6 上游 200 但非 JSON：502 明确报错", async () => {
  up.mode = "nonjson";
  const r = await postJson("/wb/v1/responses", codexBody({ stream: false }));
  eq(r.status, 502, "502");
  assert(JSON.parse(r.text).error.message.includes("non-JSON"), "错误信息");
  up.mode = "sse";
});

// ---------------------------------------------------------------- 汇总
for (const [name, ok, msg] of results) console.log(ok ? "PASS " : "FAIL ", name, ok ? "" : `— ${msg}`);
const pass = results.filter((r) => r[1]).length;
console.log(`\n==== ${pass}/${results.length} ====`);
front.kill();
upstream.close();
await new Promise((r) => setTimeout(r, 200));   // 让 kill/close 先落地，避免退出时 libuv 断言
process.exit(pass === results.length ? 0 : 1);
