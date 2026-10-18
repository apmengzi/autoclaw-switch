#!/usr/bin/env node
/**
 * Live streaming acceptance for the Trae relay: prose with tools must arrive in
 * multiple deltas spread over time, and a streamed tool call must not leak the
 * fenced markup. Reads the inbound key from ~/.autoclaw-relay/inbound-keys.json
 * unless TRAE_LIVE_KEY is set.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.env.TRAE_LIVE_BASE || "http://127.0.0.1:18768";
const MODEL = process.env.TRAE_LIVE_MODEL || "glm-5.1";
const KEYFILE = path.join(os.homedir(), ".autoclaw-relay", "inbound-keys.json");

function inboundKey() {
  if (process.env.TRAE_LIVE_KEY) return process.env.TRAE_LIVE_KEY;
  try {
    const j = JSON.parse(fs.readFileSync(KEYFILE, "utf8"));
    return j.trae || "";
  } catch {
    return "";
  }
}

const key = inboundKey();
const headers = { "Content-Type": "application/json" };
if (key) headers.Authorization = "Bearer " + key;

const weatherTool = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
};

async function readSse(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const events = [];
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of raw.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try { events.push({ at: Date.now(), payload: JSON.parse(data) }); } catch { /* ignore */ }
      }
    }
  }
  return events;
}

let pass = 0;
let fail = 0;
const t = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
  ok ? pass++ : fail++;
};

// 1. Prose with tools present must stream incrementally.
const t0 = Date.now();
let r = await fetch(BASE + "/v1/chat/completions", {
  method: "POST",
  headers,
  body: JSON.stringify({
    model: MODEL,
    stream: true,
    messages: [{ role: "user", content: "用大约200字介绍一下反向代理的工作原理，不要调用任何工具。" }],
    tools: [weatherTool],
  }),
});
t("正文流式: HTTP 200", r.status === 200, `status=${r.status}`);
const ev = await readSse(r);
const contentDeltas = ev.filter((e) => (e.payload?.choices?.[0]?.delta?.content || "").length > 0);
const text = contentDeltas.map((e) => e.payload.choices[0].delta.content).join("");
const firstAt = contentDeltas[0]?.at;
const lastAt = contentDeltas[contentDeltas.length - 1]?.at;
t("正文流式: 多段增量", contentDeltas.length >= 2, `deltas=${contentDeltas.length}`);
t("正文流式: 跨时间分布", !!firstAt && !!lastAt && lastAt - firstAt >= 300, `spread=${lastAt && firstAt ? lastAt - firstAt : "?"}ms first@${firstAt ? firstAt - t0 : "?"}ms total=${Date.now() - t0}ms`);
t("正文流式: 文本非空", text.length >= 40, `len=${text.length} ${JSON.stringify(text.slice(0, 30))}`);
const finish = ev.find((e) => e.payload?.choices?.[0]?.finish_reason)?.payload.choices[0].finish_reason;
t("正文流式: finish_reason=stop", finish === "stop", String(finish));

// 2. Streamed tool call must hide the fenced markup.
r = await fetch(BASE + "/v1/chat/completions", {
  method: "POST",
  headers,
  body: JSON.stringify({
    model: MODEL,
    stream: true,
    messages: [{ role: "user", content: "北京现在天气怎么样？请调用工具查询。" }],
    tools: [weatherTool],
  }),
});
t("工具流式: HTTP 200", r.status === 200, `status=${r.status}`);
const tev = await readSse(r);
const ttext = tev.map((e) => e.payload?.choices?.[0]?.delta?.content || "").join("");
const tcall = tev.flatMap((e) => e.payload?.choices?.[0]?.delta?.tool_calls || [])[0];
const tfinish = tev.find((e) => e.payload?.choices?.[0]?.finish_reason)?.payload.choices[0].finish_reason;
t("工具流式: 不漏标记", !ttext.includes("```") && !ttext.includes('"name"'), JSON.stringify(ttext.slice(0, 60)));
t("工具流式: tool_calls 到达", tcall?.function?.name === "get_weather", JSON.stringify(tcall || null));
t("工具流式: finish_reason=tool_calls", tfinish === "tool_calls", String(tfinish));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
