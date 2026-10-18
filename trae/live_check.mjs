#!/usr/bin/env node
/**
 * Live acceptance check against a real Trae account (no fake upstream).
 * Verifies the session-channel tool emulation, case-alias retry, and the 4001
 * error surface.
 *
 *   TRAE_LIVE_BASE=http://127.0.0.1:19082 node live_check.mjs
 */
const BASE = process.env.TRAE_LIVE_BASE || "http://127.0.0.1:19082";
const KEY = process.env.TRAE_LIVE_KEY || "";
const AUTH = KEY ? { Authorization: "Bearer " + KEY } : {};
const MODEL = process.env.TRAE_LIVE_MODEL || "glm-5.1";
const ALIAS_MODEL = process.env.TRAE_LIVE_ALIAS_MODEL || "deepseek-v4-flash";
const DEAD_MODEL = process.env.TRAE_LIVE_DEAD_MODEL || "deepseek-r1";
const timeout = 300000;

const get = (path) => fetch(BASE + path, { headers: AUTH, signal: AbortSignal.timeout(timeout) });
const post = (path, body) =>
  fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });

const t = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!ok) process.exitCode = 1;
};

const tool = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read a UTF-8 text file from the workspace.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
};

const h = await (await get("/health")).json();
console.log("health:", JSON.stringify({ upstream: h.upstream, channel: h.channels?.llm_utils_chat, cred: h.credential?.ok }));

// 1. first turn: expect an emulated tool call
let r = await post("/v1/chat/completions", {
  model: MODEL,
  messages: [
    { role: "system", content: "You are a coding agent. Use tools when the user asks for file contents." },
    { role: "user", content: "请用 read_file 工具读取 package.json，不要猜测内容。" },
  ],
  tools: [tool],
});
let j = await r.json();
const msg = j.choices?.[0]?.message || {};
console.log("turn1:", JSON.stringify({ status: r.status, finish: j.choices?.[0]?.finish_reason, content: (msg.content || "").slice(0, 120), tool_calls: msg.tool_calls, trae: j.trae }, null, 0));
const call = msg.tool_calls?.[0];
t("真机: 首轮返回 tool_calls", r.status === 200 && call?.function?.name === "read_file" && j.choices?.[0]?.finish_reason === "tool_calls");

// 2. second turn: feed the tool result back, expect prose (or another call)
if (call) {
  r = await post("/v1/chat/completions", {
    model: MODEL,
    messages: [
      { role: "system", content: "You are a coding agent. Use tools when the user asks for file contents." },
      { role: "user", content: "请用 read_file 工具读取 package.json，不要猜测内容。" },
      { role: "assistant", content: null, tool_calls: [call] },
      { role: "tool", tool_call_id: call.id, content: '{"name":"autoclaw-to-zcode","version":"1.0.0"}' },
      { role: "user", content: "总结刚才读到的文件内容，一句话即可。" },
    ],
    tools: [tool],
  });
  j = await r.json();
  const m2 = j.choices?.[0]?.message || {};
  console.log("turn2:", JSON.stringify({ status: r.status, finish: j.choices?.[0]?.finish_reason, content: (m2.content || "").slice(0, 300), tool_calls: m2.tool_calls, trae: j.trae }, null, 0));
  t("真机: 工具结果回灌后给出文本", r.status === 200 && !!(m2.content || "").trim() && j.choices?.[0]?.finish_reason === "stop");
}

// 3. lowercase spelling is not provisioned, but the TitleCase spelling is
r = await post("/v1/chat/completions", {
  model: ALIAS_MODEL,
  messages: [{ role: "user", content: "只回复 ok" }],
});
j = await r.json();
console.log("alias model:", JSON.stringify({ status: r.status, content: j.choices?.[0]?.message?.content, trae: j.trae }, null, 0));
t("真机: 小写拼写经别名重试成功", r.status === 200 && j.trae?.model_alias === "DeepSeek-V4-Flash" && !!(j.choices?.[0]?.message?.content || "").trim());

// 4. a genuinely unprovisioned model must fail loudly, not return an empty answer
r = await post("/v1/chat/completions", {
  model: DEAD_MODEL,
  messages: [{ role: "user", content: "你好" }],
});
j = await r.json();
console.log("dead model:", JSON.stringify({ status: r.status, error: j.error }, null, 0));
t("真机: 4001 模型返回明确错误", r.status === 502 && j.error?.code === "4001" && /not provisioned/.test(j.error?.message || ""));

// 5. after the failure the model is hidden from the catalog and tracked in health
const listed = await (await get("/v1/models")).json();
const health = await (await get("/health")).json();
t("真机: 坏模型从 /v1/models 消失", !listed.data.some((m) => m.id.toLowerCase() === DEAD_MODEL.toLowerCase()), listed.data.map((m) => m.id).filter((id) => /deepseek/.test(id)).join(","));
t("真机: health 暴露模型健康", (health.model_health || []).some((x) => x.model.toLowerCase() === DEAD_MODEL.toLowerCase() && x.active), JSON.stringify(health.model_health));

console.log("\ndone");
