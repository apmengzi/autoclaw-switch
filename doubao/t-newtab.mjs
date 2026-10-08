import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { buildBody, streamChat } from "./probe.mjs";

const OUT = path.join(os.homedir(), ".doubao-relay");
const jar = JSON.parse(fs.readFileSync(path.join(OUT, "cookies-cdp.json"), "utf8"));
const cookies = jar.cookies || jar;
const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
const pick = (n) => (cookies.find((c) => c.name === n) || {}).value || "";
const CAP = JSON.parse(fs.readFileSync(path.join(OUT, "captured.json"), "utf8"));
const capUrl = new URL(CAP.find((x) => /chat\/completion/.test(x.url)).url);

const tabId = process.argv[2] || "KEEP";
if (tabId !== "KEEP") capUrl.searchParams.set("web_tab_id", tabId);
const q = capUrl.searchParams;
q.set("msToken", pick("msToken") || q.get("msToken"));

const body = buildBody("只回复三个字：新标签", {});
body.client_meta.local_conversation_id = "local_" + (BigInt(Date.now()) * 1000n + 777n).toString();

// stream with an explicit URL override
const { streamChat: _unused } = await import("./probe.mjs");
const url = capUrl.toString();
const res = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json", "agw-js-conv": "str", accept: "*/*", origin: "https://www.doubao.com", referer: "https://www.doubao.com/", cookie: cookieHeader, "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 SamanthaDoubaoWork/2.31.10" },
  body: JSON.stringify(body),
});
console.log("tab:", tabId, "status", res.status);
const dec = new TextDecoder(); const reader = res.body.getReader();
let buf = "", out = "", conv = "", cur = "", n = 0;
while (true) {
  const { done, value } = await reader.read(); if (done) break;
  buf += dec.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).replace(/\r$/, ""); buf = buf.slice(i + 1);
    if (!line) { cur = ""; continue; }
    const e2 = line.match(/^event: (.*)$/); if (e2) { cur = e2[1]; continue; }
    const d = line.match(/^data: (.*)$/); if (!d) continue;
    n++;
    if (cur === "SSE_ACK") { try { conv = JSON.parse(d[1]).ack_client_meta?.conversation_id || ""; } catch {} }
    if (cur === "CHUNK_DELTA") { try { out += JSON.parse(d[1]).text || ""; } catch {} }
    if (cur === "STREAM_MSG_NOTIFY") { try { for (const b of JSON.parse(d[1]).content?.content_block || []) if (b.block_type === 10000) out += b.content?.text_block?.text || ""; } catch {} }
  }
}
console.log("events", n, "conv:", conv, "| answer:", JSON.stringify(out.slice(0, 80)));
