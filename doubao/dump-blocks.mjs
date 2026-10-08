// Dump unique content-block shapes from a deep-think chat run.
import { buildBody, streamChat } from "./probe.mjs";

const text = process.argv[2] || "1+1等于几，只说数字";
const body = buildBody(text, { needDeepThink: 9, reasoningEffort: "5" });
const seen = new Map();
const r = await streamChat(body, (e) => {
  if (e.event === "STREAM_MSG_NOTIFY") {
    try {
      const j = JSON.parse(e.data);
      for (const b of j.content?.content_block || []) {
        const key = "NOTIFY " + b.block_type + " " + Object.keys(b.content || {}).join(",");
        if (!seen.has(key)) seen.set(key, JSON.stringify(b).slice(0, 400));
      }
    } catch {}
  }
  if (e.event !== "STREAM_CHUNK") return;
  try {
    const j = JSON.parse(e.data);
    for (const op of j.patch_op || []) {
      for (const b of op.patch_value?.content_block || []) {
        const key = "CHUNK " + b.block_type + " " + Object.keys(b.content || {}).join(",");
        if (!seen.has(key)) seen.set(key, JSON.stringify(b).slice(0, 400));
      }
    }
  } catch {}
});
console.log("status", r.status);
for (const [k, v] of seen) console.log("--- " + k + "\n" + v);
