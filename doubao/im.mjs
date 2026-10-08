// Minimal Doubao (IM cmd protocol) client: cookies + JSON cmd/uplink_body.
// Usage: node doubao/im.mjs <cmd-name> [json-args]
//   info <conversationId>        -> conversation info (cmd 1110)
//   modify <conversationId> <json> -> conversation modify (cmd 1114)
//   recent [limit]               -> recent conversations (cmd 3200)
//   single <conversationId> [limit] -> message chain (cmd 3100)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const OUT = path.join(os.homedir(), ".doubao-relay");
const jar = JSON.parse(fs.readFileSync(path.join(OUT, "cookies-cdp.json"), "utf8"));
const cookies = jar.cookies || jar;
export const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
export const pick = (n) => (cookies.find((c) => c.name === n) || {}).value || "";

const CAP = JSON.parse(fs.readFileSync(path.join(OUT, "captured.json"), "utf8"));
const comp = CAP.find((x) => /chat\/completion/.test(x.url));
const url = new URL(comp.url);
const deviceId = pick("device_id") || url.searchParams.get("device_id");

export const baseParams = () => {
  const q = new URLSearchParams({
    version_code: "20800", language: "zh", device_platform: "web",
    doubao_device_platform: "desktop", aid: "1044603", real_aid: "1044603",
    pkg_type: "release_version", device_id: deviceId, pc_version: "2.31.10",
    doubao_pc_version: "2.31.10", web_id: url.searchParams.get("web_id") || "",
    tea_uuid: deviceId, region: "CN", sys_region: "CN", samantha_web: "1",
    web_platform: "desktop", "use-olympus-account": "1", runtime: "web",
    runtime_version: "3.39.0", client_platform: "pc_client",
    chromium_version: "147.0.7727.149", channel: "win", fp: "verify_" + deviceId,
    web_tab_id: url.searchParams.get("web_tab_id") || "",
  });
  return q;
};

export async function im(cmd, uplinkBody, ep) {
  const q = baseParams();
  const res = await fetch(`https://www.doubao.com${ep || "/im/conversation/info"}?${q}`, {
    method: "POST",
    headers: {
      "content-type": "application/json; encoding=utf-8",
      "agw-js-conv": "str",
      accept: "application/json, text/plain, */*",
      origin: "https://www.doubao.com",
      referer: "https://www.doubao.com/",
      cookie: cookieHeader,
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    },
    body: JSON.stringify({
      cmd, uplink_body: uplinkBody, sequence_id: crypto.randomUUID(),
      channel: 2, version: "1",
    }),
  });
  const txt = await res.text();
  try { return { status: res.status, json: JSON.parse(txt) }; }
  catch { return { status: res.status, text: txt.slice(0, 500) }; }
}

const dump = (r, n) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "last-im.json"), JSON.stringify(r, null, 1));
  console.log(JSON.stringify(r, null, 1).slice(0, n));
  console.log(`\n# full -> ~/.doubao-relay/last-im.json (${JSON.stringify(r).length} chars)`);
};
const [name, a1, a2] = process.argv.slice(2);
if (name === "info") {
  const r = await im(1110, { get_conv_info_uplink_body: { conversation_id: a1, bot_id: "", conversation_type: 3, option: { need_bot_info: true } } });
  dump(r, 6000);
} else if (name === "modify") {
  const r = await im(1114, { modify_conv_uplink_body: { conversation_id: a1, ...JSON.parse(a2 || "{}") } });
  dump(r, 4000);
} else if (name === "recent") {
  const r = await im(3200, { pull_recent_conv_chain_uplink_body: { limit: Number(a1) || 20, message_count_per_conv: 0, api_version: 1, conv_version: 0, direction: 3, option: { not_need_message: true, need_complete_conversation: true } } }, "/im/chain/recent_conv");
  dump(r, 6000);
} else if (name === "single") {
  const r = await im(3100, { pull_singe_chain_uplink_body: { conversation_id: a1, anchor_index: Number.MAX_SAFE_INTEGER, conversation_type: 3, direction: 1, limit: Number(a2) || 20, ext: {}, filter: { index_list: [] }, option: { lazy_load_strategy: 0 } } }, "/im/chain/single");
  dump(r, 6000);
} else {
  console.log("usage: node doubao/im.mjs info|modify|recent|single ...");
}
