// Generic POST caller for doubao.com endpoints (cookies from ~/.doubao-relay/cookies-cdp.json).
// Usage: node doubao/raw.mjs <path> [json-body]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const OUT = path.join(os.homedir(), ".doubao-relay");
const jar = JSON.parse(fs.readFileSync(path.join(OUT, "cookies-cdp.json"), "utf8"));
const cookies = jar.cookies || jar;
const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
const pick = (n) => (cookies.find((c) => c.name === n) || {}).value || "";
// 正常情况下 device_id 来自 cookie；取不到时用随机指纹，不硬编码真实设备 ID
const deviceId = pick("device_id") || process.env.DOUBAO_DEVICE_ID || String(Math.floor(Math.random() * 9e15) + 1e15);

const q = new URLSearchParams({
  version_code: "20800", language: "zh", device_platform: "web",
  doubao_device_platform: "desktop", aid: "1044603", real_aid: "1044603",
  pkg_type: "release_version", device_id: deviceId,
  pc_version: "2.31.10", doubao_pc_version: "2.31.10", region: "CN",
  sys_region: "CN", samantha_web: "1", web_platform: "desktop",
  "use-olympus-account": "1", runtime: "web", runtime_version: "3.39.0",
  client_platform: "pc_client", chromium_version: "147.0.7727.149",
  channel: "win", fp: "verify_" + deviceId,
});

const [p, body] = process.argv.slice(2);
const url = `https://www.doubao.com${p}?${q}`;
const r = await fetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/json; encoding=utf-8", "agw-js-conv": "str",
    accept: "application/json, text/plain, */*",
    origin: "https://www.doubao.com", referer: "https://www.doubao.com/",
    cookie: cookieHeader,
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 SamanthaDoubaoWork/2.31.10",
  },
  body: body || "{}",
});
const t = await r.text();
fs.mkdirSync(OUT, { recursive: true });
const f = path.join(OUT, "raw-" + p.replace(/\W+/g, "_") + ".json");
fs.writeFileSync(f, t);
console.log(r.status, t.length + "ch -> " + f);
const hits = [...t.matchAll(/"[a-zA-Z_]*(model|mode|item_key)[a-zA-Z_]*"/g)].map((m) => m[0]);
console.log("model-ish keys:", [...new Set(hits)].slice(0, 25).join(" "));
