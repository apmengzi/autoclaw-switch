#!/usr/bin/env node
/** Print the raw items of a Trae chat session (diagnostic only; no secrets). */
import { createDecipheriv, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const APP_ID = "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8";
const STORAGE = join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
  "TRAE SOLO CN", "User", "globalStorage", "storage.json");
const TABLE_FALLBACK = {
  qoe: [82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251, 124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203, 84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78, 8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37],
  zoe: [31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95, 96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239, 160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97, 23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125],
};
const sha512 = (b) => createHash("sha512").update(b).digest();
function decrypt(b64) {
  const blob = Buffer.from(b64, "base64");
  const keymat = blob.subarray(6, 38);
  const mask = Buffer.from(TABLE_FALLBACK.qoe.map((v, i) => v ^ TABLE_FALLBACK.zoe[i]));
  const buf = Buffer.alloc(128);
  sha512(keymat).copy(buf, 0);
  mask.copy(buf, 64);
  const d = sha512(buf);
  const dec = createDecipheriv("aes-128-cbc", d.subarray(0, 16), d.subarray(16, 32));
  const plain = Buffer.concat([dec.update(blob.subarray(38)), dec.final()]);
  return JSON.parse(plain.subarray(64).toString("utf8"));
}
const store = JSON.parse(readFileSync(STORAGE, "utf8"));
const cred = decrypt(store["iCubeAuthInfo://icube.cloudide"]);

const sid = process.argv[2];
if (!sid) { console.error("usage: node inspect_session.mjs <session_id>"); process.exit(2); }
const hosts = ["https://trae-api-cn.mchost.guru", "https://api5-normal.mchost.guru"];
let data;
for (const host of hosts) {
  const res = await fetch(`${host}/api/remote/v1/chat_sessions/${sid}/messages`, {
    headers: {
      Authorization: "Cloud-IDE-JWT " + cred.token,
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-App-Id": APP_ID,
      "X-User-Region": "CN",
    },
  });
  if (res.ok) { data = await res.json(); break; }
  console.error(host, res.status, (await res.text()).slice(0, 200));
}
if (!data) process.exit(1);
const items = data.data?.items || [];
console.log("items:", items.length);
for (const it of items) {
  console.log("--- role=%s status=%s", it.role, it.status);
  if (it.role !== "assistant") {
    console.log(String(it.content || "").slice(0, 300));
    continue;
  }
  console.log("item_keys:", Object.keys(it).join(","));
  if (it.error || it.error_message || it.fail_reason) {
    console.log("error_fields:", JSON.stringify({ error: it.error, error_message: it.error_message, fail_reason: it.fail_reason }));
  }
  let blob;
  try { blob = JSON.parse(it.content); } catch { console.log(String(it.content).slice(0, 500)); continue; }
  const pis = (blob.messages || []).map((m) => m.plan_item).filter(Boolean);
  console.log("plan_items:", pis.length);
  if (!pis.length) console.log("raw:", String(it.content).slice(0, 1200));
  for (const pi of pis) {
    console.log(JSON.stringify({
      id: pi.id,
      type: pi.type,
      thought: (pi.thought || "").slice(0, 400),
      thoughtLen: (pi.thought || "").length,
      tool: pi.tool_call_info && {
        name: pi.tool_call_info.name,
        params: pi.tool_call_info.params,
        status: pi.tool_call_info.status,
      },
      keys: Object.keys(pi),
    }, null, 2));
  }
}
