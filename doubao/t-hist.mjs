// Does /chat/completion accept a multi-message array (history replay)?
import { buildBody, streamChat, buildUrl } from "./probe.mjs";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";

const body = buildBody("忽略历史，只回答问题", {});
body.option.need_create_conversation = true;
body.client_meta.conversation_id = "";
const uuid = () => crypto.randomUUID();
const mk = (role, text) => ({
  local_message_id: uuid(),
  content_block: [{ block_type: 10000, content: { text_block: { text, icon_url: "", icon_url_dark: "", summary: "" } }, pc_event_block: "", block_id: uuid(), parent_id: "", meta_info: [], append_fields: [] }],
  message_status: 0,
});
body.messages = [mk(0, "我今年养了三只猫"), mk(1, "好的，记住了：你有三只猫。"), mk(0, "我养了几只猫？只回答数字")];

let out = "", brief = "", events = [];
const r = await streamChat(body, (e) => {
  events.push(e.event);
  if (e.event === "CHUNK_DELTA") { try { out += JSON.parse(e.data).text || ""; } catch {} }
  if (e.event === "STREAM_MSG_NOTIFY") { try { for (const b of JSON.parse(e.data).content?.content_block || []) if (b.block_type === 10000) out += b.content?.text_block?.text || ""; } catch {} }
  if (e.event === "STREAM_CHUNK") { try { for (const op of JSON.parse(e.data).patch_op || []) for (const b of op.patch_value?.content_block || []) if (b.block_type === 10000) out += b.content?.text_block?.text || ""; } catch {} }
  if (e.event === "SSE_REPLY_END") { try { const j = JSON.parse(e.data); if (j.end_type === 1) brief = j.msg_finish_attr?.brief || ""; } catch {} }
});
console.log("status", r.status, "events", events.length);
console.log("streamed:", JSON.stringify(out));
console.log("brief:", JSON.stringify(brief));
