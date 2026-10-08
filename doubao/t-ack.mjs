import { buildBody, streamChat } from "./probe.mjs";
const body = buildBody(process.argv[2] || "只回复：收到", {});
body.client_meta.local_conversation_id = "local_" + (BigInt(Date.now()) * 1000n + 123n).toString();
let conv = "", out = "";
const r = await streamChat(body, (e) => {
  if (e.event === "SSE_ACK") { try { conv = JSON.parse(e.data).ack_client_meta?.conversation_id || ""; } catch {} }
  if (e.event === "CHUNK_DELTA") { try { out += JSON.parse(e.data).text || ""; } catch {} }
  if (e.event === "SSE_REPLY_END") { try { const j = JSON.parse(e.data); if (j.end_type === 1 && !out) out = j.msg_finish_attr?.brief || ""; } catch {} }
});
console.log("status", r.status, "| ack conv:", conv || "(none)", "| answer:", JSON.stringify(out.slice(0, 50)));
