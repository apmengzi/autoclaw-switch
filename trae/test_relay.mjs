#!/usr/bin/env node
/** Smoke-test the Trae relay: models, non-stream, multi-turn, stream. */
const BASE = process.env.RELAY || "http://127.0.0.1:18768";

const post = async (path, body) => {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res;
};

const t0 = Date.now();
const models = await (await fetch(BASE + "/v1/models")).json();
console.log("models(%d): %s", models.data.length, models.data.map((m) => m.id).join(", "));

console.log("\n--- non-stream, Chinese ---");
let res = await post("/v1/chat/completions", {
  model: "glm-5.1",
  messages: [{ role: "user", content: "用一句话解释什么是反向代理" }],
});
let j = await res.json();
console.log("%s  [%sms] session=%s", j.choices?.[0]?.message?.content, Date.now() - t0, j.trae?.session_id);

console.log("\n--- follow-up turn (same conversation) ---");
res = await post("/v1/chat/completions", {
  model: "glm-5.1",
  messages: [
    { role: "user", content: "用一句话解释什么是反向代理" },
    { role: "assistant", content: j.choices[0].message.content },
    { role: "user", content: "那它和负载均衡是什么关系？一句话" },
  ],
});
j = await res.json();
console.log("%s  mode=%s session=%s", j.choices?.[0]?.message?.content, j.trae?.mode, j.trae?.session_id);

console.log("\n--- streaming ---");
res = await post("/v1/chat/completions", {
  model: "Doubao-Seed-Code",
  stream: true,
  messages: [{ role: "user", content: "写一首关于代码的四行短诗" }],
});
process.stdout.write("deltas: ");
let chunks = 0;
let text = "";
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "";
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf("\n\n")) >= 0) {
    const frame = buf.slice(0, i);
    buf = buf.slice(i + 2);
    const data = frame.split("\n").find((l) => l.startsWith("data:"));
    if (!data) continue;
    const payload = data.slice(5).trim();
    if (payload === "[DONE]") continue;
    const obj = JSON.parse(payload);
    const d = obj.choices?.[0]?.delta?.content;
    if (d) {
      chunks++;
      text += d;
      process.stdout.write(d.replace(/\n/g, "⏎"));
    }
  }
}
console.log("\n(%d chunks, %d chars) %ss", chunks, text.length, ((Date.now() - t0) / 1000).toFixed(1));

console.log("\n--- /v1/messages non-stream ---");
res = await post("/v1/messages", {
  model: "DeepSeek-V4-Flash",
  max_tokens: 1024,
  messages: [{ role: "user", content: "只回答一个数字：7 乘以 6 等于多少？" }],
});
j = await res.json();
console.log("%s  usage=%j", j.content?.[0]?.text, j.usage);

console.log("\n--- /v1/messages stream ---");
res = await post("/v1/messages", {
  model: "kimi-k2.6",
  max_tokens: 1024,
  stream: true,
  messages: [{ role: "user", content: "用两个字回答：中国的首都是哪里？" }],
});
buf = "";
let aText = "";
const r2 = res.body.getReader();
while (true) {
  const { done, value } = await r2.read();
  if (done) break;
  buf += new TextDecoder().decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf("\n\n")) >= 0) {
    const frame = buf.slice(0, i);
    buf = buf.slice(i + 2);
    const dl = frame.split("\n").find((l) => l.startsWith("data:"));
    if (!dl) continue;
    const obj = JSON.parse(dl.slice(5).trim());
    if (obj.type === "content_block_delta") aText += obj.delta.text;
    else process.stdout.write(`<${obj.type}>`);
  }
}
console.log("\nanthropic text: %s  (%ss)", aText, ((Date.now() - t0) / 1000).toFixed(1));
