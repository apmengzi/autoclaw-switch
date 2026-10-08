// Smoke test for doubao/relay.mjs (OpenAI + Anthropic surfaces).
// Usage: node doubao/test-relay.mjs [port]
const PORT = process.argv[2] || "18770";
const KEY = process.env.DOUBAO_RELAY_KEY || "doubao-local-key";
const BASE = `http://127.0.0.1:${PORT}`;

async function post(path, body, headers = {}) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": KEY, ...headers },
    body: JSON.stringify(body),
  });
  return r;
}

// 1) OpenAI non-stream
{
  const t0 = Date.now();
  const r = await post("/v1/chat/completions", { model: "doubao", messages: [{ role: "user", content: "只回答三个字：你好呀" }] });
  const j = await r.json();
  console.log(`[openai] ${r.status} ${Date.now() - t0}ms ->`, JSON.stringify(j.choices?.[0]?.message?.content || j).slice(0, 200));
}

// 2) OpenAI stream
{
  const t0 = Date.now();
  const r = await post("/v1/chat/completions", { model: "doubao", stream: true, messages: [{ role: "user", content: "用一句话介绍你自己" }] });
  let text = "", frames = 0;
  const rd = r.body.getReader(); const dec = new TextDecoder(); let buf = "";
  while (true) {
    const { done, value } = await rd.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6);
      if (payload === "[DONE]") continue;
      frames++;
      try { text += JSON.parse(payload).choices?.[0]?.delta?.content || ""; } catch {}
    }
  }
  console.log(`[openai stream] ${r.status} ${Date.now() - t0}ms frames=${frames} ->`, JSON.stringify(text).slice(0, 220));
}

// 3) Anthropic non-stream
{
  const t0 = Date.now();
  const r = await post("/v1/messages", { model: "doubao", max_tokens: 256, messages: [{ role: "user", content: "1+1等于几？只回答数字" }] }, { "anthropic-version": "2023-06-01" });
  const j = await r.json();
  console.log(`[anthropic] ${r.status} ${Date.now() - t0}ms ->`, JSON.stringify(j.content?.[0]?.text || j).slice(0, 200));
}

// 4) deep-think model, multi-turn (relay session reuse)
{
  const t0 = Date.now();
  const r = await post("/v1/chat/completions", { model: "doubao-think", messages: [{ role: "user", content: "记住暗号：蓝色太阳。只回复OK" }] });
  const j = await r.json();
  console.log(`[think#1] ${Date.now() - t0}ms ->`, JSON.stringify(j.choices?.[0]?.message?.content || j).slice(0, 120));
  const t1 = Date.now();
  const r2 = await post("/v1/chat/completions", {
    model: "doubao-think",
    messages: [{ role: "user", content: "记住暗号：蓝色太阳。只回复OK" }, { role: "assistant", content: "OK" }, { role: "user", content: "暗号是什么？只回答暗号本身" }],
  });
  const j2 = await r2.json();
  console.log(`[think#2 follow-up] ${Date.now() - t1}ms ->`, JSON.stringify(j2.choices?.[0]?.message?.content || j2).slice(0, 120));
}
