import { buildBody, streamChat } from "./probe.mjs";
// 用法: node doubao/t-convid.mjs <conversation_id>（会话 id 从 /health 或客户端 URL 里取，不硬编码）
const convArg = process.argv[2];
if (!convArg) { console.log("用法: node doubao/t-convid.mjs <conversation_id>"); process.exit(1); }
const body = buildBody("只回复：收到", { conversationId: convArg });
console.log("sending conversation_id:", convArg, "need_create:", body.option.need_create_conversation);
let conv = "", out = "";
const r = await streamChat(body, (e) => {
  if (e.event === "SSE_ACK") { try { conv = JSON.parse(e.data).ack_client_meta?.conversation_id || ""; } catch {} }
  if (e.event === "CHUNK_DELTA") { try { out += JSON.parse(e.data).text || ""; } catch {} }
  if (e.event === "SSE_REPLY_END") { try { const j = JSON.parse(e.data); if (j.end_type === 1) out = out || (j.msg_finish_attr?.brief || ""); } catch {} }
});
console.log("status", r.status, "-> ack conv:", conv, "| answer:", JSON.stringify(out.slice(0, 40)));
