// Cloudflare Email Worker —— 自建域名验证码邮箱（网页查看器 + JSON API 双模）
//
// 功能：
//   1. email 事件：接收任意 *@your-domain.example 的邮件，解码 MIME，存 KV（含 HTML 正文）
//   2. GET /viewer?key=...        网页版邮件查看器（列表 + 渲染 HTML 正文，链接可点）
//   3. GET /api/getcode?addr=...&key=...   JSON 取码（自动化用）
//   4. GET /api/mails?key=...     JSON 邮件列表
//   5. GET /api/list              调试：信封形状 + 错误记录
//   6. GET /ping
//
// 无第三方依赖；内置轻量 MIME 解码（multipart/base64/quoted-printable）。
// v4：收信全程分段容错——解析/存储任何一步失败都降级保存原始内容，错误进 /api/list，
//     并 console.log 到 Worker Observability（Events 流可见）。

const API_KEY = process.env.MAILCODE_API_KEY || "REPLACE_WITH_YOUR_OWN_KEY";           // 取码口令（自己保管）
const TTL = 86400;                                 // 邮件保留 1 天
const EMAIL_DOMAIN = process.env.MAILCODE_DOMAIN || "your-domain.example";          // ← 你的域名
const NC = { "Cache-Control": "no-store" };        // 禁止浏览器缓存取码结果

// ---------- 轻量 MIME 解码 ----------
function b64ToText(b64) {
  try {
    const bin = atob(b64.replace(/\s+/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch { return ""; }
}
function decodeQP(s) {
  try {
    const bytes = [];
    const raw = s.replace(/=\r?\n/g, "");
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(raw.slice(i + 1, i + 3))) {
        bytes.push(parseInt(raw.slice(i + 1, i + 3), 16)); i += 2;
      } else bytes.push(raw.charCodeAt(i));
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes));
  } catch { return s; }
}
function mimeToParts(raw, depth) {
  depth = depth || 0;
  if (depth > 4) return [{ head: raw, body: "" }];
  const boundary = /boundary="?([^";\r\n]+)"?/i.exec(raw);
  if (boundary) {
    const b = "--" + boundary[1];
    const parts = raw.split(b).slice(1, -1);
    let all = [];
    for (const p of parts) all = all.concat(mimeToParts(p, depth + 1));
    return all;
  }
  const sep = raw.match(/\r?\n\r?\n/);
  if (!sep) return [{ head: raw, body: "" }];
  const head = raw.slice(0, sep.index);
  const body = raw.slice(sep.index + sep[0].length);
  return [{ head, body }];
}
function mimeToTextAndHtml(raw) {
  let text = "", html = "";
  for (const { head, body } of mimeToParts(raw)) {
    const cte = (/content-transfer-encoding:\s*([^\r\n;]+)/i.exec(head) || [])[1] || "";
    const ct = (/content-type:\s*([^;\r\n]+)/i.exec(head) || [])[1] || "";
    let decoded = body;
    if (/base64/i.test(cte)) decoded = b64ToText(body);    else if (/quoted-printable/i.test(cte)) decoded = decodeQP(body);
    if (/html/i.test(ct) || /<html|<body|<div|<table/i.test(decoded)) html += decoded;
    else text += decoded + "\n";
  }
  text = text.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
  return { text, html };
}
// RFC2047 编码头解码：=?charset?B/Q?data?=（可多段相邻；B=base64，Q=下划线转空格的QP）
function decodeRFC2047(s) {
  if (!s || s.indexOf("=?") === -1) return s || "";
  let out = "";
  var re = /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g;
  var m, last = 0;
  while ((m = re.exec(s)) !== null) {
    out += s.slice(last, m.index);
    var cs = m[1].toLowerCase(), enc = m[2], data = m[3];
    try {
      if (enc === "b") {
        var bin = atob(data);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        out += new TextDecoder(cs, { fatal: false }).decode(bytes);
      } else {
        out += decodeQP(data.replace(/_/g, " "));
      }
    } catch (e) { out += m[0]; }
    last = m.index + m[0].length;
  }
  out += s.slice(last);
  return out;
}

function extractCodes(text) {
  const codes = [];
  const six = text.match(/(?<!\d)(\d{6})(?!\d)/g);
  if (six) codes.push(...new Set(six));
  if (!codes.length) {
    const any = text.match(/(?<!\d)(\d{4,8})(?!\d)/g);
    if (any) codes.push(...new Set(any).slice(0, 5));
  }
  return codes;
}

export default {
  // ---- 收信（分段容错：任何一步失败都降级保存，绝不让邮件凭空消失） ----
  async email(message, env, ctx) {
    const ts = Date.now();
    const to = (message.to || "").toLowerCase();
    const local = to.split("@")[0];
    const from = message.from || "";
    let subject = "";
    try { subject = decodeRFC2047(message.headers.get("subject") || ""); } catch {}
    let raw = "", text = "", html = "", codes = [], parseErr = "";
    try { raw = await new Response(message.raw).text(); }
    catch (e) { parseErr = "raw read: " + e; }
    if (raw) {
      try { ({ text, html } = mimeToTextAndHtml(raw)); }
      catch (e) { parseErr = "mime: " + e; text = raw.slice(0, 4000); }
      try { codes = extractCodes(text + " " + subject); } catch {}
    }
    const record = { from, subject, codes, code: codes[0] || "",
                     text: (text || raw || "").replace(/\s+/g, " ").slice(0, 4000),
                     html: (html || "").slice(0, 300000), ts,
                     parseErr: parseErr || undefined };
    const v = JSON.stringify(record);
    // 存储逐键独立 try：某个键失败不影响其余；失败记录进 err:（/api/list 可见）
    for (const k of ["m:" + to, "m:" + local, "dbg:v4 " + ts]) {
      try { await env.MAILCODE.put(k, v, { expirationTtl: TTL }); } catch (e) {
        try { await env.MAILCODE.put("err:" + ts + ":put", "put " + k + ": " + e, { expirationTtl: 86400 }); } catch {}
      }
    }
    try {
      const rawTo = message.to;
      if (rawTo && rawTo.toLowerCase() !== to) {
        await env.MAILCODE.put("m:" + rawTo, v, { expirationTtl: TTL });
      }
    } catch {}
    // console.log 进 Worker Observability（Events 流可见）
    console.log("email handled: to=" + to + " local=" + local + " from=" + from
      + " codes=" + JSON.stringify(codes) + " rawLen=" + raw.length
      + (parseErr ? " parseErr=" + parseErr : ""));
  },

  // ---- HTTP：查看器 + API ----
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const key = url.searchParams.get("key") || "";
    const keyOk = key === API_KEY;

    if (url.pathname === "/ping") {
      return Response.json({ ok: true, domain: EMAIL_DOMAIN }, { headers: NC });
    }

    // ---- JSON：邮件列表 ----
    if (url.pathname === "/api/mails") {
      if (!keyOk) return Response.json({ ok: false, error: "bad key" }, { status: 403, headers: NC });
      const d2 = await env.MAILCODE.list({ prefix: "m:" });
      const byLocal = new Map();   // 本地部分去重：同邮件的"全地址键/短键"只留最新一条
      for (const k of (d2.keys || []).slice(0, 60)) {
        const addr = k.name.slice(2);
        const lp = addr.split("@")[0].toLowerCase();
        const prev = byLocal.get(lp);
        if (!prev || prev.k.length < k.name.length) byLocal.set(lp, { k, addr });
      }
      const mails = [];
      for (const { k, addr } of byLocal.values()) {
        try {
          const rec = JSON.parse(await env.MAILCODE.get(k.name) || "{}");
          mails.push({ addr, subject: rec.subject, from: rec.from, code: rec.code,
                       codes: rec.codes, ts: rec.ts, parseErr: rec.parseErr });
        } catch {}
      }
      mails.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      return Response.json({ ok: true, mails }, { headers: NC });
    }

    // ---- JSON：取码（自动化） ----
    if (url.pathname === "/api/getcode") {
      if (!keyOk) return Response.json({ ok: false, error: "bad key" }, { status: 403, headers: NC });
      const addr = (url.searchParams.get("addr") || "").toLowerCase();
      if (!addr) {
        return Response.json({ ok: false, error: "addr required" }, { status: 400, headers: NC });
      }
      // 含 @ 时必须是本域名；不含 @ 时按本地部分查（兼容短键别名）
      let recRaw = await env.MAILCODE.get("m:" + addr.toLowerCase());
      if (!recRaw) recRaw = await env.MAILCODE.get("m:" + addr.toLowerCase().split("@")[0]);
      if (!recRaw) {
        return Response.json({ ok: false, error: "no mail yet", addr,
                               hint: "已收到但查不到时，GET /api/list 看信封形状与错误" }, { headers: NC });
      }
      const rec = JSON.parse(recRaw);
      return Response.json({ ok: true, addr, code: rec.code, codes: rec.codes,
                             subject: rec.subject, from: rec.from, ts: rec.ts,
                             html: (rec.html || "").slice(0, 2000),
                             text: (rec.text || "").slice(0, 800),
                             parseErr: rec.parseErr }, { headers: NC });
    }

    // ---- HTML 正文（完整，供 viewer iframe 加载） ----
    if (url.pathname === "/api/html") {
      if (!keyOk) return new Response("bad key", { status: 403 });
      const addr = (url.searchParams.get("addr") || "").toLowerCase();
      let recRaw = await env.MAILCODE.get("m:" + addr);
      if (!recRaw) recRaw = await env.MAILCODE.get("m:" + addr.split("@")[0]);
      if (!recRaw) return new Response("(no mail)", { status: 404 });
      const rec = JSON.parse(recRaw);
      return new Response(rec.html || ("<pre>" + (rec.text || "(无正文)") + "</pre>"),
                          { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // ---- 调试：信封形状 + 错误 ----
    if (url.pathname === "/api/list") {
      if (!keyOk) return Response.json({ ok: false, error: "bad key" }, { status: 403, headers: NC });
      const dbg = [], errs = [], mailKeys = [];
      const d1 = await env.MAILCODE.list({ prefix: "dbg:" });
      for (const k of (d1.keys || []).slice(0, 5)) {
        const v = await env.MAILCODE.get(k.name);
        try { dbg.push(JSON.parse(v || "{}")); } catch { dbg.push(v); }
      }
      const d0 = await env.MAILCODE.list({ prefix: "err:" });
      for (const k of (d0.keys || []).slice(0, 10)) {
        errs.push({ key: k.name, msg: (await env.MAILCODE.get(k.name) || "").slice(0, 200) });
      }
      const d2 = await env.MAILCODE.list({ prefix: "m:" });
      for (const k of (d2.keys || []).slice(0, 20)) mailKeys.push(k.name);
      return Response.json({ ok: true, dbg, errs, mailKeys }, { headers: NC });
    }

    // ---- 网页查看器 ----
    if (url.pathname === "/viewer") {
      if (!keyOk) return new Response("bad key", { status: 403 });
      const html = `<!doctype html><html><head><meta charset="utf-8">
<title>邮件查看器 · ${EMAIL_DOMAIN}</title>
<style>
 body{margin:0;font:14px/1.6 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;background:#f4f5f7;color:#222}
 .wrap{max-width:1100px;margin:0 auto;padding:18px}
 h1{font-size:20px} .mut{color:#888;font-size:12px}
 .grid{display:grid;grid-template-columns:340px 1fr;gap:14px;align-items:start}
 .list{background:#fff;border:1px solid #e3e5e8;border-radius:8px;overflow:hidden}
 .item{padding:10px 12px;border-bottom:1px solid #eef0f2;cursor:pointer}
 .item:hover{background:#f0f4ff}
 .item.on{background:#e8efff}
 .item .t{font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 .item .m{font-size:11.5px;color:#888}
 .view{background:#fff;border:1px solid #e3e5e8;border-radius:8px;padding:14px}
 .code{font-size:28px;font-weight:700;background:#eef;padding:6px 14px;border-radius:6px;display:inline-block;margin:6px 0}
 iframe{width:100%;height:1100px;border:1px solid #e3e5e8;border-radius:6px;background:#fff}
 .empty{color:#999;padding:40px;text-align:center}
 @media (max-width:760px){.grid{grid-template-columns:1fr}}
</style></head><body><div class="wrap">
<h1>邮件查看器 <span class="mut">${EMAIL_DOMAIN}</span></h1>
<div class="grid"><div class="list" id="list"></div><div class="view" id="view"><div class="empty">左侧选择一封邮件</div></div></div>
</div>
<script>
var KEY = new URLSearchParams(location.search).get("key") || "";
function esc(s){return String(s??"").replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c];});}
function fmtTs(ts){try{return new Date(ts).toLocaleString();}catch(e){return "";}}
async function loadList(){
  var r = await fetch("/api/mails?key="+encodeURIComponent(KEY));
  var d = await r.json();
  var box = document.getElementById("list");
  if(!d.ok || !d.mails.length){ box.innerHTML = '<div class="empty">暂无邮件</div>'; return; }
  box.innerHTML = d.mails.map(function(m,i){
    return '<div class="item" data-i="'+i+'"><div class="t">'+esc(m.subject||"(无主题)")+'</div>'
      + '<div class="m">'+esc(m.addr)+' · '+esc(fmtTs(m.ts))+(m.code?' · 码:'+esc(m.code):'')+(m.parseErr?' · 解析降级':'')+'</div></div>';
  }).join("");
  window._mails = d.mails;
  box.querySelectorAll(".item").forEach(function(el){
    el.onclick = function(){ show(el.dataset.i|0); };
  });
  if(window._curAddr){
    var idx = window._mails.findIndex(function(m){return m.addr===window._curAddr;});
    if(idx>=0) show(idx); else show(0);
  } else show(0);
}
async function showByAddr(addr){ show(window._mails.findIndex(function(m){return m.addr===addr;})); }
async function show(i){
  var m = window._mails[i]; if(!m) return;
  window._curAddr = m.addr;
  document.querySelectorAll(".item").forEach(function(el,idx){ el.classList.toggle("on", idx===i); });
  var r = await fetch("/api/getcode?addr="+encodeURIComponent(m.addr)+"&key="+encodeURIComponent(KEY));
  var d = await r.json();
  var v = document.getElementById("view");
  if(!d.ok){ v.innerHTML = '<div class="empty">'+esc(d.error||"读取失败")+'</div>'; return; }
  v.innerHTML = '<div style="margin-bottom:8px">'
    + (d.code ? '验证码/码: <span class="code">'+esc(d.code)+'</span>' : '')
    + (d.parseErr ? '<div class="mut" style="color:#c60">解析降级: '+esc(d.parseErr)+'</div>' : '')
    + '<div class="mut">主题: '+esc(d.subject)+' · 来自: '+esc(d.from)+' · '+esc(fmtTs(d.ts))+'</div></div>'
    + '<iframe sandbox="allow-popups allow-popups-to-escape-sandbox" src="/api/html?addr='+encodeURIComponent(d.addr)+'&key='+encodeURIComponent(KEY)+'"></iframe>'
    + '<div class="mut" style="margin-top:6px">按钮看不到？<a href="/api/html?addr='+encodeURIComponent(d.addr)+'&key='+encodeURIComponent(KEY)+'" target="_blank">在新标签打开完整邮件</a></div>';
}
loadList();
setInterval(function(){
  if(document.hidden) return;
  var scroll = document.getElementById("list").scrollTop;
  loadList().then(function(){
    document.getElementById("list").scrollTop = scroll;
  });
}, 5000);
</script></body></html>`;
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    return new Response("A-SWITCH mail-code worker\n", { status: 200 });
  },
};
