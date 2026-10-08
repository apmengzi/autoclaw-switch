import { buildBody, streamChat } from "./probe.mjs";

async function turn(text, conv, opts = {}) {
  const body = buildBody(text, { conversationId: conv, ...opts });
  let streamed = "", brief = "", convId = "";
  const textLen = [];
  const r = await streamChat(body, (e) => {
    if (e.event === "SSE_ACK") {
      try { convId = JSON.parse(e.data).ack_client_meta?.conversation_id || convId; } catch {}
    }
    if (e.event === "STREAM_MSG_NOTIFY") {
      try {
        for (const b of JSON.parse(e.data).content?.content_block || [])
          if (b.block_type === 10000 && b.content?.text_block?.text) textLen.push(b.content.text_block.text.length);
      } catch {}
    }
    if (e.event === "STREAM_CHUNK") {
      try {
        for (const op of JSON.parse(e.data).patch_op || [])
          for (const b of op.patch_value?.content_block || [])
            if (b.block_type === 10000 && b.content?.text_block?.text) textLen.push(b.content.text_block.text.length);
      } catch {}
    }
    if (e.event === "SSE_REPLY_END") {
      try { const j = JSON.parse(e.data); if (j.end_type === 1) brief = j.msg_finish_attr?.brief || ""; } catch {}
    }
  });
  console.log(`Q: ${text}`);
  console.log(`  text-frame lengths: [${textLen.slice(0, 12).join(",")}${textLen.length > 12 ? ",..." : ""}] total ${textLen.length} frames`);
  console.log(`  brief(${brief.length}): ${brief.slice(0, 220).replace(/\n/g, "\n")}`);
  return convId || conv;
}

const text = process.argv[2] || "用中文写一段 200 字左右的短文，主题是秋天的清晨。";
let conv = "";
conv = await turn(text, conv);
conv = await turn("刚才那篇短文里，第一句话是什么？", conv);
console.log("# conv:", conv);
