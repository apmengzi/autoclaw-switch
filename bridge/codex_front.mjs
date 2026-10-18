#!/usr/bin/env node
/**
 * Codex 前门（WorkBuddy 等只讲 chat completions 的链路）。
 *
 * 为什么需要它：Codex CLI 的 wire_api 只认 "responses"，而 WorkBuddy 的
 * wb2api.exe 是 Go 单文件上游，路由表里只有 chat/completions 与 models
 * （workbuddy-manager/upstream/internal/server/handler.go 穷举过，没有
 * /v1/responses，源码注释还写着「Responses -> Chat 转换器」由外部提供）。
 * 改 Go 二进制或换成那个 FastAPI 平台都不划算，所以在本进程里做转换：
 *
 *    Codex ──/wb/v1/responses──▶ 前门 ──/v1/chat/completions──▶ wb2api(release)
 *                                │
 *                                └── 其余 /wb/v1/*（models 等）原样透传
 *
 * 设计约束：
 *   - 不存钥匙：Authorization / x-api-key 原样透传给上游，上游自己校验
 *     （Codex 的 provider 配的就是 wb2api 的那把 key）
 *   - 只绑 127.0.0.1：本进程只是本机 Codex 的适配器，不是对外服务
 *   - 上游报错原样回传状态码与响应体（Codex 与 Codex 供应商的 401/402 语义
 *     要靠它们），只有流已开之后的错误才用 Responses 形状的 response.failed
 *   - 变换层与 comate/relay.mjs 共用（bridge/responses_transform.mjs）
 *
 *   node codex_front.mjs --port 18776 --wb http://127.0.0.1:7863
 *   env: CODEX_FRONT_PORT / CODEX_FRONT_HOST / CODEX_FRONT_WB
 */
import { createServer, request as httpRequest } from "node:http";
import {
  responsesToChatRequest, ResponsesSseWriter, chatSseToNormalized, accumulateChatSse,
  chatCompletionToResponses, compactionToResponses, streamCompactionAsResponses, newResponseId,
} from "./responses_transform.mjs";

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(name + "="));
  return eq ? eq.slice(name.length + 1) : fallback;
};
const PORT = Number(process.env.CODEX_FRONT_PORT || argOf("--port", 18776));
const HOST = process.env.CODEX_FRONT_HOST || argOf("--host", "127.0.0.1");

// link 前缀 → 上游 origin。`--wb <url>` 是 WorkBuddy 的快捷写法；
// `--upstream <link>=<origin>` 可再加别的 chat-only 链路（如未来某天要接 Trae）。
const LINKS = new Map();
function addLink(link, origin) {
  const m = /^https?:\/\/[^\s/]+$/.exec(String(origin || "").trim());
  if (!link || !m) return;
  LINKS.set(link.replace(/^\/+|\/+$/g, ""), origin.replace(/\/+$/, ""));
}
addLink("wb", process.env.CODEX_FRONT_WB || argOf("--wb", ""));
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--upstream" && argv[i + 1]) {
    const [link, ...rest] = argv[i + 1].split("=");
    addLink(link, rest.join("="));
  }
}
if (!LINKS.size) LINKS.set("wb", "http://127.0.0.1:7863");   // 默认就是 WorkBuddy 那条

const stats = { started: Date.now(), requests: 0, responsesCalls: 0, upstreamErrors: 0, lastError: null, byLink: {} };
function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }

// ------------------------------------------------------------------ 上游请求
function upstreamRequest(origin, pathname, { method, headers, body }) {
  const url = new URL(origin + pathname);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: url.hostname, port: url.port || 80, path: url.pathname + url.search, method,
      headers: { ...headers, host: url.host },
    }, resolve);
    req.on("error", reject);
    req.setTimeout(300000, () => { req.destroy(new Error("upstream timeout (300s)")); });
    if (body) req.write(body);
    req.end();
  });
}
const HOP_HEADERS = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-authorization", "proxy-authenticate", "te", "trailer"]);

function writeSse(res, payload) {
  if (res.writableEnded || res.destroyed) return false;
  try { res.write(payload); return true; } catch { return false; }
}
function startHeartbeat(res, ms = 15000) {
  const t = setInterval(() => writeSse(res, ": keep-alive\n\n"), ms);
  if (t.unref) t.unref();
  return () => clearInterval(t);
}
// 客户端挂断 → 掐掉上游（上游那侧还在跑就是白烧额度）
function bindAbort(req, res) {
  const onClose = () => { if (res.upstream && !res.upstream.destroyed) { try { res.upstream.destroy(); } catch {} } };
  req.on("close", onClose);
  res.on("close", onClose);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

// ------------------------------------------------------------------ 主处理
async function handle(req, res, url) {
  const p = url.pathname;
  if (p === "/health" || p === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: LINKS.size > 0, service: "codex-front", mode: "responses→chat",
      links: Object.fromEntries([...LINKS].map(([k, v]) => [k, v])),
      responses_paths: [...LINKS.keys()].map((k) => `/${k}/v1/responses`),
      uptime_s: Math.floor((Date.now() - stats.started) / 1000),
      requests: stats.requests, responsesCalls: stats.responsesCalls,
      upstreamErrors: stats.upstreamErrors, lastError: stats.lastError,
      byLink: stats.byLink,
    }));
    return;
  }
  // /<link>/... 分流；裸 /v1/... 落到唯一的 link（方便手动测试）
  const seg = p.split("/").filter(Boolean);
  let link = null, rest = null;
  if (seg.length && LINKS.has(seg[0])) { link = seg[0]; rest = "/" + seg.slice(1).join("/"); }
  else if (seg[0] === "v1" && LINKS.size === 1) { link = [...LINKS.keys()][0]; rest = p; }
  if (!link) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `codex-front: no route ${p} (links: ${[...LINKS.keys()].join(",")})` } }));
    return;
  }
  const origin = LINKS.get(link);
  stats.requests++;
  stats.byLink[link] = stats.byLink[link] || { requests: 0 };
  stats.byLink[link].requests++;
  bindAbort(req, res);

  const isResponses = rest === "/v1/responses" || rest === "/responses";
  const passthroughPath = origin + (rest.startsWith("/v1") ? rest : "/v1" + rest);

  if (!isResponses) {
    // 透传（models / chat/completions / …）：头与体原样转发，状态码与响应体原样回
    const body = req.method === "GET" || req.method === "HEAD" ? null : await readBody(req);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP_HEADERS.has(k.toLowerCase())) headers[k] = v;
    let up;
    try { up = await upstreamRequest(origin, passthroughPath.slice(origin.length), { method: req.method, headers, body }); }
    catch (e) {
      stats.upstreamErrors++; stats.lastError = `${link}: ${e.message}`;
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: `codex-front: upstream ${origin} unreachable (${e.message})` } }));
      return;
    }
    res.upstream = up;
    const outHeaders = {};
    for (const [k, v] of Object.entries(up.headers)) if (!HOP_HEADERS.has(k.toLowerCase())) outHeaders[k] = v;
    res.writeHead(up.statusCode || 502, outHeaders);
    up.pipe(res);
    return;
  }

  // /v1/responses → 翻译
  stats.responsesCalls++;
  let payload;
  try { payload = JSON.parse((await readBody(req)).toString("utf8") || "{}"); }
  catch (e) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `codex-front: bad JSON body (${e.message})`, type: "invalid_request_error" } }));
    return;
  }
  const { chat, meta } = responsesToChatRequest(payload, { defaultMaxTokens: 8192 });
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP_HEADERS.has(k.toLowerCase())) headers[k] = v;
  headers["content-type"] = "application/json";
  const bodyBuf = Buffer.from(JSON.stringify(chat), "utf8");
  headers["content-length"] = String(bodyBuf.length);

  let up;
  try {
    up = await upstreamRequest(origin, "/v1/chat/completions", { method: "POST", headers, body: bodyBuf });
  } catch (e) {
    stats.upstreamErrors++; stats.lastError = `${link}: ${e.message}`;
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `codex-front: upstream ${origin} unreachable (${e.message})` } }));
    return;
  }
  res.upstream = up;

  if (up.statusCode !== 200) {
    // 上游拒绝（401 钥匙不对 / 402 欠费 / 400 参数）：状态码与响应体原样回传，
    // Codex 与供应商的报错语义都由上游说了算
    const errBody = await readBody(up);
    stats.upstreamErrors++;
    stats.lastError = `${link}: HTTP ${up.statusCode} ${errBody.toString("utf8").slice(0, 200)}`;
    log(`responses upstream ${up.statusCode} — relaying verbatim`);
    res.writeHead(up.statusCode, { "Content-Type": up.headers["content-type"] || "application/json" });
    res.end(errBody);
    return;
  }

  const responseId = newResponseId();
  const model = payload.model || chat.model || "";
  if (!payload.stream) {
    // 非流式：把上游 JSON（或 CSV 流）聚合成一个 Responses 响应体
    const raw = await readBody(up);
    let chatRes;
    try { chatRes = JSON.parse(raw.toString("utf8")); }
    catch { chatRes = null; }
    let body;
    if (meta.compaction) {
      const text = chatRes?.choices?.[0]?.message?.content || "";
      body = compactionToResponses({ text, usage: chatRes?.usage, model, responseId, finishReason: chatRes?.choices?.[0]?.finish_reason });
    } else if (chatRes) {
      body = chatCompletionToResponses(chatRes, { model, responseId, toolContext: meta.toolContext });
    } else {
      // 上游声称 200 却不是 JSON：当失败处理，别让 Codex 收到半截
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "codex-front: upstream returned non-JSON 200 body" } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
    log(`responses model=${model} stream=0 items=[${(body.output || []).map((o) => o.type).join(",")}]${meta.compaction ? " compaction" : ""}`);
    return;
  }

  // 流式：真流式转发（上游分片即到即转），收尾补 response.completed
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const stopBeat = startHeartbeat(res);
  try {
    if (meta.compaction) {
      const acc = await accumulateChatSse(up);
      stopBeat();
      streamCompactionAsResponses(res, { text: acc.content, usage: acc.usage, model, responseId, finishReason: acc.finish_reason });
      writeSse(res, "data: [DONE]\n\n");
      res.end();
      log(`responses model=${model} stream=1 compaction chars=${acc.content.length}`);
      return;
    }
    const w = new ResponsesSseWriter(res, { model, responseId, toolContext: meta.toolContext });
    let usage = null;
    for await (const ev of chatSseToNormalized(up)) {
      if (ev.type === "done") usage = ev.usage;
      w.emit(ev);
    }
    stopBeat();
    const final = w.finalize({ usage });
    writeSse(res, "data: [DONE]\n\n");
    res.end();
    log(`responses model=${model} stream=1 items=[${final.output.map((o) => o.type).join(",")}]`);
  } catch (e) {
    stopBeat();
    stats.upstreamErrors++;
    stats.lastError = `${link}: ${e.message}`;
    // 流已开：只能用 Responses 形状的失败帧收尾（Codex 读得懂，可重试）
    const w = new ResponsesSseWriter(res, { model, responseId, toolContext: meta.toolContext });
    w.fail(`codex-front: ${e.message}`, "upstream_error");
    writeSse(res, "data: [DONE]\n\n");
    try { res.end(); } catch {}
  }
}

const server = createServer((req, res) => {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || HOST}`); }
  catch { res.writeHead(400); res.end(); return; }
  handle(req, res, url).catch((e) => {
    stats.upstreamErrors++; stats.lastError = String(e.message);
    log("error:", e.message);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: `codex-front: ${e.message}` } }));
    } else { try { res.end(); } catch {} }
  });
});

const LISTEN = !process.env.CODEX_FRONT_NO_LISTEN;
if (LISTEN) server.listen(PORT, HOST, () => {
  log(`codex-front listening on http://${HOST}:${PORT} (responses→chat bridge)`);
  for (const [link, origin] of LINKS) log(`  /${link}/v1/responses → ${origin}/v1/chat/completions`);
});

export { server, LINKS, stats };
