import { buildBody, streamChat } from "./probe.mjs";
const body = buildBody("只回复：新会话测试", {});
body.option.need_create_conversation = true;
body.option.conversation_init_option = { need_ack_conversation: true };
body.option.conversation_init_ext = { model_item_key: "9", mode_id: "3", reasoning_effort: "5" };
body.client_meta.local_conversation_id = "local_" + (BigInt(Date.now()) * 1000n + 321n).toString();
let conv = "", out = "";
const r = await streamChat(body, (e) => {
  if (e.event === "SSE_ACK") { try { conv = JSON.parse(e.data).ack_client_meta?.conversation_id || ""; } catch {} }
  if (e.event === "CHUNK_DELTA") { try { out += JSON.parse(e.data).text || ""; } catch {} }
  if (e.event === "STREAM_MSG_NOTIFY") { try { for (const b of JSON.parse(e.data).content?.content_block || []) if (b.block_type === 10000) out += b.content?.text_block?.text || ""; } catch {} }
});
console.log("status", r.status, "| ack conv:", conv || "(none)", "| answer:", JSON.stringify(out.slice(0, 50)));
