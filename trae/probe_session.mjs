#!/usr/bin/env node
/**
 * Probe `/api/remote/v1/chat_sessions` creation parameters.
 *
 * The relay used {mode:"work", session_type:"assistant_chat"}, which upstream
 * resolves to Function=solo_agent_remote; some models have no config item there
 * (4001 "config item is empty"). Try the other session types/modes to find a
 * shape that serves all catalog models.
 *
 *   node probe_session.mjs --model deepseek-v4-flash --mode chat --type ide_chat
 */
import { createDecipheriv, createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const APP_ID = "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8";
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const STORAGE = join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
  "TRAE SOLO CN", "User", "globalStorage", "storage.json");
const TABLE = {
  qoe: [82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251, 124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203, 84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78, 8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37],
  zoe: [31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95, 96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239, 160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97, 23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125],
};
const sha512 = (b) => createHash("sha512").update(b).digest();
function decrypt(b64) {
  const blob = Buffer.from(b64, "base64");
  const keymat = blob.subarray(6, 38);
  const mask = Buffer.from(TABLE.qoe.map((v, i) => v ^ TABLE.zoe[i]));
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
const HOSTS = ["https://trae-api-cn.mchost.guru", "https://api5-normal.mchost.guru"];
const headers = {
  Authorization: "Cloud-IDE-JWT " + cred.token,
  Accept: "application/json",
  "Content-Type": "application/json",
  "X-App-Id": APP_ID,
  "X-User-Region": "CN",
};

const model = argOf("--model", "deepseek-v4-flash");
const mode = argOf("--mode", "work");
const sessionType = argOf("--type", "assistant_chat");
const agentType = argOf("--agent", "");
const promptText = argOf("--prompt", "只回复两个字：收到");
const query = JSON.stringify([{ type: "text", data: { content: promptText } }]);

async function api(method, path, body) {
  let last;
  for (const host of HOSTS) {
    try {
      const res = await fetch(host + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
      if (res.status >= 500) { last = data; continue; }
      return { host, status: res.status, data };
    } catch (err) { last = err.message; }
  }
  throw new Error("no host: " + JSON.stringify(last));
}

const body = {
  env: "local",
  mode,
  session_type: sessionType,
  initial_message: {
    content: [],
    query,
    model_name: model,
    agent_type: agentType,
  },
};
const created = await api("POST", "/api/remote/v1/chat_sessions", body);
const sid = created.data?.data?.chat_session_id;
console.log(JSON.stringify({ model, mode, sessionType, agentType, http: created.status, code: created.data?.code, sid, message: created.data?.message }, null, 2));
if (!sid) process.exit(1);

let lastAssistant = null;
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const got = await api("GET", `/api/remote/v1/chat_sessions/${sid}/messages`);
  const items = got.data?.data?.items || [];
  const assistants = items.filter((x) => x.role === "assistant");
  lastAssistant = assistants[assistants.length - 1];
  if (lastAssistant && ["completed", "failed", "stopped", "canceled"].includes(lastAssistant.status)) break;
}
if (!lastAssistant) {
  console.log("NO_ASSISTANT");
  process.exit(1);
}
let summary = "";
let thought = "";
try {
  const blob = JSON.parse(lastAssistant.content);
  for (const m of blob.messages || []) {
    const pi = m.plan_item;
    if (!pi) continue;
    if (pi.thought) thought += pi.thought;
    if (pi.tool_call_info?.name === "finish") summary += pi.tool_call_info.params?.summary || "";
  }
} catch { /* ignore */ }
console.log(JSON.stringify({
  status: lastAssistant.status,
  agent_type: lastAssistant.agent_type,
  agent_name: lastAssistant.agent_name,
  summary: summary.slice(0, 300),
  thought: thought.slice(0, 300),
  error: lastAssistant.error ? String(lastAssistant.error).slice(0, 500) : null,
}, null, 2));
