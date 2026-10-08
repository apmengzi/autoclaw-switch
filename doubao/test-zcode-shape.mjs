// ZCode 形状的请求回归：真实 ZCode 会带长 system、tools 数组、stream_options、max_tokens 等字段。
// 用于确认 relay 对这些"多余"字段不报错、流式帧符合 OpenAI SSE 约定。
// Usage: node doubao/test-zcode-shape.mjs [port]
const PORT = process.argv[2] || "18770";
const KEY = process.env.DOUBAO_RELAY_KEY || "doubao-local-key";
const BASE = `http://127.0.0.1:${PORT}`;

const SYS = [
  "You are ZCode, an interactive coding agent.",
  "IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts.",
  "Before your first tool call, say in a sentence what you're about to do.",
  "Text you write between tool calls may not be shown to the user.",
].join("\n");

const TOOLS = [
  { type: "function", function: { name: "Bash", description: "Run a shell command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
  { type: "function", function: { name: "Read", description: "Read a file", parameters: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } } },
];

async function streamReq(body, label) {
  const t0 = Date.now();
  const r = await fetch(BASE + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + KEY },
    body: JSON.stringify(body),
  });
  if (r.status !== 200) { console.log(`[${label}] HTTP ${r.status}`, (await r.text()).slice(0, 300)); return; }
  const rd = r.body.getReader(), dec = new TextDecoder();
  let buf = "", text = "", frames = 0, finish = null, firstMs = 0, usage = null;
  while (true) {
    const { done, value } = await rd.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith("data: ")) continue;
      const p = line.slice(6); if (p === "[DONE]") continue;
      let j; try { j = JSON.parse(p); } catch { continue; }
      frames++;
      const d = j.choices?.[0]?.delta || {};
      if (d.content) { if (!firstMs) firstMs = Date.now() - t0; text += d.content; }
      if (j.choices?.[0]?.finish_reason) finish = j.choices[0].finish_reason;
      if (j.usage) usage = j.usage;
    }
  }
  console.log(`[${label}] frames=${frames} first=${firstMs}ms total=${Date.now() - t0}ms finish=${finish} usage=${usage ? JSON.stringify(usage) : "无"}`);
  console.log(`[${label}] text: ${text.slice(0, 200)}`);
}

// 1) 带 tools / stream_options / max_tokens / temperature 的完整 ZCode 形状
await streamReq({
  model: "doubao",
  stream: true,
  stream_options: { include_usage: true },
  max_tokens: 1024,
  temperature: 0.7,
  tools: TOOLS,
  tool_choice: "auto",
  messages: [
    { role: "system", content: SYS },
    { role: "user", content: "用两句话说明你为什么不能调用工具，然后回答 6*7=?" },
  ],
}, "zcode-shape+tools");

// 2) 多轮：assistant 历史 + 追问
await streamReq({
  model: "doubao",
  stream: true,
  messages: [
    { role: "system", content: SYS },
    { role: "user", content: "请记住数字 42。" },
    { role: "assistant", content: "好的，我记住了数字 42。" },
    { role: "user", content: "我刚才让你记的数字是多少？只回答数字。" },
  ],
}, "multi-turn");
