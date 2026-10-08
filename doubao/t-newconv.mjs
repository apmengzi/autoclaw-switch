import { buildBody, streamChat } from "./probe.mjs";
const local = "local_" + (BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 900) + 100)).toString();
const body = buildBody("记住一个暗号：紫色犀牛。只回复OK", {});
body.client_meta.local_conversation_id = local;
body.client_meta.conversation_id = "";
console.log("# local_conversation_id:", local);
let conv = "", out = "";
const r = await streamChat(body, (e) => {
  if (e.event === "SSE_ACK") { try { conv = JSON.parse(e.data).ack_client_meta?.conversation_id || ""; } catch {} }
  if (e.event === "CHUNK_DELTA") { try { out += JSON.parse(e.data).text || ""; } catch {} }
  if (e.event === "STREAM_MSG_NOTIFY") { try { for (const b of JSON.parse(e.data).content?.content_block || []) if (b.block_type === 10000) out += b.content?.text_block?.text || ""; } catch {} }
  if (e.event === "STREAM_CHUNK") { try { for (const op of JSON.parse(e.data).patch_op || []) for (const b of op.patch_value?.content_block || []) if (b.block_type === 10000) out += b.content?.text_block?.text || ""; } catch {} }
});
console.log("status", r.status, "conv:", conv, "answer:", JSON.stringify(out.slice(0,60)));
