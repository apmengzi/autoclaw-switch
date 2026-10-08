#!/usr/bin/env node
/** Dump raw Trae SSE events for a fresh session to see exactly what arrives. */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash, createDecipheriv } from "node:crypto";

const APP = join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "TRAE SOLO CN");
const STORAGE = join(APP, "User", "globalStorage", "storage.json");
const MAIN = "D:/TRAE SOLO CN/resources/app/out/main.js";
const HOST_API = "https://trae-api-cn.mchost.guru";
const APP_ID = "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8";

const main = readFileSync(MAIN, "utf8");
const grab = (name) => {
  const re = new RegExp(name + "\\s*=\\s*(?:Uint8Array\\.from|new Uint8Array)\\(\\[([0-9,\\s]+)\\]\\)");
  const m = main.match(re);
  if (!m) throw new Error("table not found: " + name);
  return Uint8Array.from(m[1].split(",").map((s) => parseInt(s.trim(), 10)));
};
const qoe = grab("qoe");
const zoe = grab("zoe");

const store = JSON.parse(readFileSync(STORAGE, "utf8"));
const blobRaw = store["iCubeAuthInfo://icube.cloudide"];
const blob = Buffer.from(typeof blobRaw === "string" ? blobRaw : blobRaw.value, "base64");
const keymat = blob.subarray(6, 38);
const body = blob.subarray(38);
const mask = Buffer.allocUnsafe(64);
for (let i = 0; i < 64; i++) mask[i] = qoe[i] ^ zoe[i];
let n = Buffer.alloc(128);
createHash("sha512").update(keymat).digest().copy(n, 0);
mask.copy(n, 64);
const digest = createHash("sha512").update(n).digest();
const dec = createDecipheriv("aes-128-cbc", digest.subarray(0, 16), digest.subarray(16, 32));
let pt = Buffer.concat([dec.update(body), dec.final()]);
const pad = pt[pt.length - 1];
if (pad > 0 && pad <= 16) pt = pt.subarray(0, pt.length - pad);
const cred = JSON.parse(pt.subarray(64).toString("utf8"));

const h = {
  Accept: "application/json",
  "Content-Type": "application/json",
  Authorization: "Cloud-IDE-JWT " + cred.token,
  "X-Trae-Client-Type": "lite",
  "X-App-Id": APP_ID,
  "X-User-Region": "CN",
  "X-Preferenced-Language": "zh-cn",
  "X-Trae-User-Timezone": "Asia/Shanghai",
};

const model = process.argv[2] || "Doubao-Seed-Code";
const prompt = process.argv[3] || "写一首关于代码的四行短诗";

const created = await (
  await fetch(`${HOST_API}/api/remote/v1/chat_sessions`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({
      env: "local",
      mode: "work",
      session_type: "assistant_chat",
      initial_message: {
        content: [],
        query: JSON.stringify([{ type: "text", data: { content: prompt } }]),
        model_name: model,
        agent_type: "",
      },
    }),
  })
).json();
const sid = created.data.chat_session_id;
console.log("session:", sid, "model:", model, "prompt:", prompt);

const res = await fetch(`${HOST_API}/api/remote/v1/chat_sessions/${sid}/events`, {
  headers: { ...h, Accept: "text/event-stream" },
});
console.log("events HTTP", res.status, res.headers.get("content-type"));
let buf = "";
let event = null;
let count = 0;
for await (const chunk of res.body) {
  buf += Buffer.from(chunk).toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).replace(/\r$/, "");
    buf = buf.slice(nl + 1);
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) {
      const raw = line.slice(5).trim();
      count++;
      if (event === "plan_item") {
        let p;
        try {
          p = JSON.parse(raw);
        } catch {}
        if (p) {
          console.log(
            `[${count}] plan_item id=${p.id} type=${p.type || p.plan_item_type} status=${p.status} thought=${JSON.stringify((p.thought || "").slice(-40))} reasoning=${(p.reasoning_content || "").length}chars tool=${p.tool_call_info?.name} keys=${Object.keys(p).join(",")}`
          );
        } else console.log(`[${count}] plan_item RAW ${raw.slice(0, 300)}`);
      } else {
        console.log(`[${count}] ${event} ${raw.slice(0, 240)}`);
      }
      if (event === "done") {
        console.log("--- done, total events:", count);
        process.exit(0);
      }
    }
  }
}
