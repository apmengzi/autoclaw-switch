// Send a raw key chord through CDP (works for app-level shortcuts).
// Usage: node doubao/cdp-key.mjs ctrl+n | ctrl+shift+s | enter
const PORT = process.env.DOUBAO_CDP_PORT || "9222";
const BASE = `http://127.0.0.1:${PORT}`;
const targets = await (await fetch(BASE + "/json/list")).json();
const page = targets.find((t) => /doubaowork-chat\/chat/.test(t.url)) || targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = (m) => { const j = JSON.parse(m.data); if (pend.has(j.id)) { pend.get(j.id)(j); pend.delete(j.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

const key = (process.argv[2] || "ctrl+n").toLowerCase();
const parts = key.split("+");
const k = parts.pop();
const modifiers = (parts.includes("ctrl") ? 2 : 0) | (parts.includes("shift") ? 8 : 0) | (parts.includes("alt") ? 1 : 0);
const vk = { n: 78, s: 83, d: 68, t: 84, enter: 13, escape: 27 }[k] || (k.toUpperCase().charCodeAt(0));
const code = k === "enter" ? "Enter" : "Key" + k.toUpperCase();
for (const type of ["rawKeyDown", "keyUp"])
  await send("Input.dispatchKeyEvent", { type, modifiers, key: k === "enter" ? "Enter" : k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
console.log("sent", key);
await new Promise((r) => setTimeout(r, 300));
const r = await send("Runtime.evaluate", { expression: "location.href", returnByValue: true });
console.log("url:", r.result?.result?.value);
ws.close();
