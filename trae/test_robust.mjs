#!/usr/bin/env node
/** Robustness checks against real client behaviour: system prompts, tool schemas,
 *  unknown model ids, and conversation isolation under the stateless design
 *  (every request builds its own fresh Trae session from the flattened history). */
const BASE = process.env.RELAY || "http://127.0.0.1:18768";
const post = async (path, body) =>
  (await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();

const t0 = Date.now();
const t = (name, ok, extra = "") => console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);

// 1. system prompt + tools present (tools are not forwarded to Trae; must not break the call)
let j = await post("/v1/chat/completions", {
  model: "Doubao-Seed-Code",
  messages: [
    { role: "system", content: "你是简洁的助手，回答不超过 10 个字。" },
    { role: "user", content: "中国的首都是？" },
  ],
  tools: [{ type: "function", function: { name: "noop", description: "unused", parameters: { type: "object", properties: {} } } }],
  tool_choice: "auto",
  max_tokens: 64,
});
t("system prompt + tools 不报错", j.choices?.[0]?.message?.content?.length > 0, `reply=${JSON.stringify(j.choices?.[0]?.message?.content)}`);

// 2. unknown model id -> relay falls back to passing it through and upstream decides
j = await post("/v1/chat/completions", {
  model: "trae/Not-A-Real-Model",
  messages: [{ role: "user", content: "hi" }],
  max_tokens: 32,
});
t("未知模型不崩溃（有结构化返回）", typeof j === "object" && (j.choices || j.error), j.error ? "上游拒绝：" + String(j.error.message).slice(0, 60) : "有回复");

// 3. two distinct conversations must not share a Trae session
const a1 = await post("/v1/chat/completions", { model: "glm-5.1", messages: [{ role: "user", content: "记住数字 111，只回复“好”" }] });
const b1 = await post("/v1/chat/completions", { model: "glm-5.1", messages: [{ role: "user", content: "记住数字 222，只回复“好”" }] });
t("不同会话各自独立的上游会话", a1.trae?.session_id !== b1.trae?.session_id, `${a1.trae?.session_id} vs ${b1.trae?.session_id}`);

// 4. continuing conversation A keeps recalling its own context (history is re-sent and flattened per request)
const a2 = await post("/v1/chat/completions", {
  model: "glm-5.1",
  messages: [
    { role: "user", content: "记住数字 111，只回复“好”" },
    { role: "assistant", content: a1.choices[0].message.content },
    { role: "user", content: "我刚才让你记住的数字是多少？只回复数字" },
  ],
});
const recalled = /111/.test(a2.choices?.[0]?.message?.content || "");
t("多轮记忆（每次全量重发历史）", a2.trae?.mode === "stateless" && recalled, `mode=${a2.trae?.mode} reply=${JSON.stringify((a2.choices?.[0]?.message?.content || "").slice(0, 40))}`);

console.log(`(总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
