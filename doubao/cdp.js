#!/usr/bin/env node
// DoubaoWork 客户端 CDP 调试工具（开发/录制用，非运行时依赖）
// 用法:
//   node cdp.js targets
//   node cdp.js cookies [out.json]        # 拉取浏览器明文 Cookie
//   node cdp.js eval "<js>"               # 在聊天页执行 JS
//   node cdp.js net <seconds>             # 抓 samantha/alice 请求（含 body）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = process.env.DOUBAO_CDP_PORT || "9222";
const BASE = `http://127.0.0.1:${PORT}`;

async function listTargets() {
  const r = await fetch(`${BASE}/json/list`);
  return await r.json();
}

function pickChatPage(ts) {
  return (
    ts.find((t) => t.type === "page" && /doubaowork-chat\/chat/.test(t.url)) ||
    ts.find((t) => t.type === "page" && /doubaowork/.test(t.url)) ||
    ts.find((t) => t.type === "page")
  );
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map(); // method -> fn
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener("open", res);
      this.ws.addEventListener("error", (e) => rej(new Error("ws error")));
    });
    this.ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      } else if (m.method && this.handlers.has(m.method)) {
        this.handlers.get(m.method)(m.params || {});
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, fn) { this.handlers.set(method, fn); }
  close() { try { this.ws.close(); } catch {} }
}

async function connect() {
  const ts = await listTargets();
  const t = pickChatPage(ts);
  if (!t) throw new Error("no chat page target found");
  const cdp = new CDP(t.webSocketDebuggerUrl);
  await cdp.ready;
  return { cdp, target: t };
}

const OUT_DIR = path.join(os.homedir(), ".doubao-relay");

async function cmdCookies(outFile) {
  const { cdp } = await connect();
  const { cookies } = await cdp.send("Network.getAllCookies");
  const mine = cookies.filter((c) => /doubao|byte|feishu/.test(c.domain));
  const jar = {};
  for (const c of mine) jar[c.name] = c.value;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = outFile || path.join(OUT_DIR, "cookies-cdp.json");
  fs.writeFileSync(out, JSON.stringify({ savedAt: new Date().toISOString(), count: mine.length, jar, cookies: mine }, null, 1));
  console.log(`cookies: ${mine.length} (doubao/byte/feishu) -> ${out}`);
  for (const n of ["sessionid", "sessionid_ss", "sid_tt", "sid_guard", "ttwid", "msToken", "uid_tt", "passport_csrf_token", "s_v_web_id"])
    if (jar[n]) console.log(`  ${n.padEnd(22)} len=${jar[n].length} head=${jar[n].slice(0, 16)}`);
  cdp.close();
}

async function cmdEval(js) {
  const { cdp } = await connect();
  const r = await cdp.send("Runtime.evaluate", { expression: js, awaitPromise: true, returnByValue: true, userGesture: true });
  console.log(JSON.stringify(r.result?.value ?? r.exceptionDetails ?? r, null, 1).slice(0, 4000));
  cdp.close();
}

async function cmdNet(seconds) {
  const { cdp, target } = await connect();
  console.log(`# attached: ${target.url}`);
  await cdp.send("Network.enable", { maxPostDataSize: 1 << 20 });
  cdp.on("Network.requestWillBeSent", (p) => {
    const url = p.request?.url || "";
    if (!process.env.NET_ALL && !/(samantha|alice|chat\/completion|\/im\/)/.test(url)) return;
    if (process.env.NET_ALL && !/^https/.test(url)) return;
    const pd = p.request.postData ? p.request.postData.slice(0, 1200) : "";
    console.log(`\n>>> ${p.request.method} ${url.slice(0, 500)}`);
    if (pd) console.log(`BODY: ${pd}`);
    if (process.env.NET_HEADERS) console.log("HDR: " + JSON.stringify(p.request.headers));
  });
  cdp.on("Network.responseReceived", (p) => {
    const url = p.response?.url || "";
    if (!/(completion)/.test(url)) return;
    console.log(`<<< ${p.response.status} ${p.response.mimeType} ${url.slice(0, 200)}`);
  });
  await new Promise((r) => setTimeout(r, Number(seconds) * 1000));
  cdp.close();
}

async function cmdDrive(text, seconds) {
  const { cdp, target } = await connect();
  console.log(`# attached: ${target.url}`);
  await cdp.send("Network.enable", { maxPostDataSize: 1 << 20 });
  const seen = [];
  cdp.on("Network.requestWillBeSent", (p) => {
    const url = p.request?.url || "";
    if (!/(samantha|alice|\/im\/|completion)/.test(url)) return;
    seen.push({ url, method: p.request.method, body: p.request.postData || "" });
    console.log(`\n>>> ${p.request.method} ${url.slice(0, 600)}`);
    if (p.request.postData) console.log(`BODY: ${p.request.postData.slice(0, 1500)}`);
  });
  cdp.on("Network.responseReceived", (p) => {
    const url = p.response?.url || "";
    if (!/completion/.test(url)) return;
    console.log(`<<< ${p.response.status} ${p.response.mimeType}`);
  });
  // 聚焦 tiptap 编辑器 -> 插入文本 -> 回车发送
  await cdp.send("Runtime.evaluate", {
    expression: `(()=>{const el=document.querySelector('.ProseMirror');if(!el)return 'no editor';el.focus();return 'focused';})()`,
    returnByValue: true, userGesture: true,
  }).then((r) => console.log("# focus:", r.result?.value));
  await cdp.send("Input.insertText", { text });
  await new Promise((r) => setTimeout(r, 600));
  for (const type of ["keyDown", "char", "keyUp"])
    await cdp.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r" });
  await new Promise((r) => setTimeout(r, Number(seconds) * 1000));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "captured.json"), JSON.stringify(seen, null, 1));
  console.log(`\n# captured ${seen.length} requests -> ~/.doubao-relay/captured.json`);
  cdp.close();
}

const [cmd, ...rest] = process.argv.slice(2);
const run = {
  targets: async () => {
    const ts = await listTargets();
    for (const t of ts) console.log(`[${t.type}] ${t.title} :: ${t.url}`);
  },
  cookies: () => cmdCookies(rest[0]),
  eval: () => cmdEval(rest.join(" ")),
  net: () => cmdNet(rest[0] || 20),
  drive: () => cmdDrive(rest[0] || "你好", rest[1] || 25),
}[cmd];
if (!run) { console.error("usage: targets|cookies|eval|net|drive"); process.exit(2); }
run().then(() => process.exit(0)).catch((e) => { console.error("ERR", e.message); process.exit(1); });
