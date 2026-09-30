// 用法: node warm_account.mjs <token文件> [轮数=8]
// 给新号建立"真人形"用量基线：真实技术话题 + 抖动间隔 + 小输出上限。
// 背景：上游风控看的是推理流水的形态——纯 1-token 探针（input<100 且 output<=8）
// 的号会被判机器号封掉；真人形 = input>100 或 output>8。
//
// 2026-09-30 适配 2.0.2 网关（与 server.mjs 同一套规则，勿单点修改）：
//   1) token 文件改为 JSON：{"refresh_token","device_id","auth"}（a_switch 写入），
//      兼容旧的裸 token 文本文件；chat 端点校验 token **铸造新鲜度**（分钟级，
//      JWT 的 24h exp 不算数），所以每轮请求前现刷一票；
//   2) body 不得含 `max_tokens` 字段（OpenAI 废弃参数，网关 406 空 body），
//      用 `max_completion_tokens`；model 用目录全名（zai_ 前缀不去掉）；
//   3) 头集合对齐桌面端：凭证挂 x-authorization（挂 authorization 报 Invalid
//      token）、必带 x-agent-id: main 与 x-auth-sign 三元组、X-Version 三段 2.0.2、
//      X-Channel official、user-agent OpenAI/JS 6.26.0。
// 注意：必须 `import crypto from "node:crypto"`（全局 webcrypto 没有 createHash）。
import fs from "node:fs";
import crypto from "node:crypto";

const [tokFile, roundsArg] = process.argv.slice(2);
if (!tokFile) { console.error("usage: node warm_account.mjs <tokenFile> [rounds]"); process.exit(2); }
const rawTok = fs.readFileSync(tokFile, "utf8").trim();
let cred = { auth: rawTok.startsWith("{") ? "" : rawTok, refresh_token: "", device_id: "" };
if (rawTok.startsWith("{")) {
  try { cred = { ...cred, ...JSON.parse(rawTok) }; } catch { /* 裸 token 兜底 */ }
}
if (cred.auth && !/^Bearer\s/i.test(cred.auth)) cred.auth = `Bearer ${cred.auth}`;

const N = Number(roundsArg || 8);

const ORIGIN = "https://autoglm-api.autoglm.ai";
const U = `${ORIGIN}/autoclaw-proxy/proxy/autoclaw/chat/completions`;
const APP_ID = "100003";
const APP_KEY = "38d2391985e2369a5fb8227d8e6cd5e5";
const VERSION = "2.0.2";
// 2.0.2 客户端的 system 提示词开头（main.cjs 的 ZWORK_DEFAULT_SYSTEM_PROMPT），
// 旧的 "OpenClaw plugin-injected..." 标记在 2.0.2 里已不存在，继续发会被拦。
const MARKER = [
  "You are AutoClaw. Answer the user directly and concisely.",
  "Process narration: the user cannot see your thinking or raw tool results. Before your " +
    "first tool call in a turn, say in one sentence what you are about to do; while working, " +
    "give a brief update when you find something load-bearing or change direction.",
].join(" ");
const TOPICS = [
  "帮我设计一个本地Python服务的心跳保活机制，要求考虑进程崩溃后自拉起、信号优雅退出、心跳间隔抖动避免钟摆效应。给出核心代码结构和关键字段说明。",
  "解释JWT的签名校验完整流程：为什么服务端不能只信任客户端传来的payload？过期时间、刷新令牌、吊销列表各自解决什么问题？",
  "我有个脚本并发打外部API被限流。帮我分析check-then-act竞态：多个线程先查配额再发请求，中间有30秒空隙导致配额被穿透。给出三种修复思路。",
  "写一个生成器函数：扫描大目录，按文件修改时间分批返回，每批不超过N个文件。注意处理权限错误和符号链接循环。",
  "数据库索引为什么能加速查询？什么情况下索引反而拖慢写入？复合索引的最左前缀原则是什么？",
  "讲讲asyncio中Task与协程的区别，gather与wait的适用场景，以及为什么在任务里吞异常会导致静默失败。",
  "如何用diff/patch思路实现配置文件的无损热更新？要求改动字段生效、未动字段保留、出错可回滚。",
  "手写一个简化版LRU缓存：O(1) get/put，说明哈希表+双向链表的操作顺序和淘汰时机。",
];
const SYSTEM = MARKER + "\n\n你是一个资深后端工程师，回答简洁、给可运行代码。";

// 每轮现刷一票（与桌面端 credentialLifecycle 同节奏）；无 refresh_token 时退回静态票
async function freshToken() {
  if (!cred.refresh_token) return cred.auth;
  const ts = String(Math.floor(Date.now() / 1e3));
  const sign = crypto.createHash("md5").update(`${APP_ID}&${ts}&${APP_KEY}`).digest("hex");
  const r = await fetch(`${ORIGIN}/userapi/v1/refresh`, {
    method: "POST",
    headers: {
      "content-type": "application/json", accept: "*/*", "user-agent": "node",
      "x-auth-appid": APP_ID, "x-auth-sign": sign, "x-auth-timestamp": ts,
      "x-channel": "official", "x-lang": "zh-CN", "x-product": "autoclaw", "x-tm": "win",
      "x-trace-id": crypto.randomUUID(), "x-version": VERSION,
      "authorization": cred.auth,
    },
    body: JSON.stringify({ refresh_token: cred.refresh_token, source_id: "autoclaw", device_id: cred.device_id }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json();
  if (j.code !== 0 || !j.data?.access_token) {
    console.log(`refresh fail: code=${j.code} ${j.msg || ""} —— 退回静态票`);
    return cred.auth;
  }
  const t = String(j.data.access_token);
  return t.startsWith("Bearer ") ? t : `Bearer ${t}`;
}

function chatHeaders(tok) {
  const ts = String(Math.floor(Date.now() / 1e3));
  const sign = crypto.createHash("md5").update(`${APP_ID}&${ts}&${APP_KEY}`).digest("hex");
  const rid = crypto.randomUUID();
  return {
    "accept": "application/json", "content-type": "application/json",
    "user-agent": "OpenAI/JS 6.26.0", "x-agent-id": "main",
    "x-auth-appid": APP_ID, "x-auth-sign": sign, "x-auth-timestamp": ts,
    "x-authorization": tok, "x-channel": "official", "x-client-type": "pc",
    "x-lang": "zh-CN", "x-product": "autoclaw",
    "x-request-id": rid, "x-request-model": "zai_glm-5.3-flash", "x-session-id": crypto.randomUUID(),
    "x-stainless-arch": "x64", "x-stainless-lang": "js", "x-stainless-os": "Windows",
    "x-stainless-package-version": "6.26.0", "x-stainless-retry-count": "0",
    "x-stainless-runtime": "node", "x-stainless-runtime-version": `v${process.versions.node}`,
    "x-tm": "win", "x-trace-id": rid, "x-version": VERSION, "x_trace_id": "autoclaw-desktop",
  };
}

async function one(i) {
  const mt = 600 + Math.floor(Math.random() * 300);
  let tok = "";
  try { tok = await freshToken(); } catch (e) { tok = cred.auth; }
  // 轮内重试：连接层偶发 RST 时 5s 后再试一次
  for (let a = 0; a < 2; a++) {
    try {
      const r = await fetch(U, {
        method: "POST", headers: chatHeaders(tok),
        body: JSON.stringify({ model: "zai_glm-5.3-flash", stream: false, max_completion_tokens: mt,
          temperature: 0.7, messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: TOPICS[Math.floor(Math.random() * TOPICS.length)] }] }),
        signal: AbortSignal.timeout(120000),
      });
      const t = await r.text();
      let usage = "";
      try {
        const d = JSON.parse(t);
        usage = `${d.usage?.prompt_tokens ?? "?"}/${d.usage?.completion_tokens ?? "?"}`;
      } catch {}
      console.log(`round${i + 1}: ${r.status} tok(in/out)=${usage}`);
      return r.status === 200;
    } catch (e) {
      console.log(`round${i + 1}: ERR ${e.message}${a === 0 ? " (5s后重试)" : ""}`);
      if (a === 0) await new Promise((x) => setTimeout(x, 5000));
    }
  }
  return false;
}

let ok = 0;
for (let i = 0; i < N; i++) {
  if (await one(i)) ok++;
  if (i < N - 1) await new Promise((r) => setTimeout(r, 20000 + Math.random() * 20000));
}
console.log(`WARM_DONE ok=${ok}/${N}`);

// 拉流水算真人形占比（业务端点：X-Auth-* 签名 + authorization；版本/渠道对齐 2.0.2）
const ts = String(Math.floor(Date.now() / 1000));
const sign = crypto.createHash("md5").update(`${APP_ID}&${ts}&${APP_KEY}`).digest("hex");
const bh = {
  "Content-Type": "application/json", "Accept": "*/*", "X-Version": VERSION, "X-Tm": "win",
  "X-Product": "autoclaw", "X-Auth-Appid": APP_ID, "X-Auth-TimeStamp": ts, "X-Auth-Sign": sign,
  "X-Lang": "zh-CN", "X-Channel": "official", "X-Trace-Id": crypto.randomUUID(), "authorization": cred.auth,
};
for (let i = 0; i < 4; i++) {
  try {
    const r = await fetch(`${ORIGIN}/agent-assetmgr/api/v1/ledgers_std?page=1&page_size=12`,
      { headers: bh, signal: AbortSignal.timeout(20000) });
    const d = await r.json();
    if (d.code === 0) {
      const es = (d.data.entries || []).filter((e) => String(e.description).includes("model usage"));
      let human = 0;
      for (const e of es) {
        const tu = e.metadata?.token_usage || "";
        const im = Number(/input_tokens:(\d+)/.exec(tu)?.[1] || 0);
        const om = Number(/output_tokens:(\d+)/.exec(tu)?.[1] || 0);
        if (im > 100 || om > 8) human++;
      }
      const ratio = es.length ? human / es.length : 0;
      console.log(`RATIO ${human}/${es.length} = ${(ratio * 100).toFixed(0)}%`
        + (ratio >= 0.5 && es.length >= 3 ? "  <- 真人形达标" : "  <- 未达标，多跑几轮"));
      break;
    }
    console.log(`ledger: code=${d.code} ${d.msg}`);
  } catch (e) { console.log(`ledger try${i + 1}: ERR ${e.message}`); }
  await new Promise((x) => setTimeout(x, 4000));
}
