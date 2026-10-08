#!/usr/bin/env node
/**
 * Trae SOLO CN -> OpenAI/Anthropic compatible relay.
 *
 * Why this shape: Trae's preset models are NOT called from the client. The IDE
 * posts an *agent session* to its cloud and the model runs inside a ByteDance
 * sandbox, so "reverse proxying Trae" means driving that session protocol:
 *
 *   POST /api/remote/v1/chat_sessions                     create + first prompt
 *   POST /api/remote/v1/chat_sessions/:id/messages        follow-up turn
 *   GET  /api/remote/v1/chat_sessions/:id/events          SSE: plan_item deltas
 *   GET  /api/remote/v1/models                            model catalog
 *
 * Auth is the *user token* from the IDE's own credential store, decrypted
 * offline (see decrypt_auth.py for how byteCrypto was reversed):
 *
 *   storage.json[iCubeAuthInfo://icube.cloudide]
 *     = "tc" 05 10 00 00 | keymat(32) | AES-128-CBC(sha512(body)(64) | body)
 *   key   = sha512(sha512(keymat) || (qoe XOR zoe))[0:16]
 *   iv    = same digest [16:32]
 *
 * So the whole thing runs with no patched client and no running IDE — only the
 * token file on disk.
 *
 *   node relay.mjs [--port 18768] [--host 127.0.0.1]
 */
import { createDecipheriv, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

const HOST_API = "https://trae-api-cn.mchost.guru";
const APP_ID = "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8";
const IDE_VERSION = "2.3.87413";
const DEFAULT_MODEL = "Doubao-Seed-Code";

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(name + "="));
  return eq ? eq.slice(name.length + 1) : fallback;
};
const PORT = Number(process.env.TRAE_RELAY_PORT || argOf("--port", 18768));
const HOST = process.env.TRAE_RELAY_HOST || argOf("--host", "127.0.0.1");

const TRAE_APP = process.env.TRAE_APP_DIR || "D:\\TRAE SOLO CN\\resources\\app";
const STORAGE =
  process.env.TRAE_STORAGE ||
  join(
    process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
    "TRAE SOLO CN",
    "User",
    "globalStorage",
    "storage.json",
  );
const AUTH_KEY = "iCubeAuthInfo://icube.cloudide";

// ---------------------------------------------------------------- byteCrypto

// Fallback tables copied from out-build/vs/base/common/byteCrypto.js. They are
// re-read from main.js on every credential load so a Trae update that rotates
// them does not silently produce garbage.
const TABLE_FALLBACK = {
  qoe: [82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251, 124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203, 84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78, 8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37],
  zoe: [31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95, 96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239, 160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97, 23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125],
};

let tables = null;
function loadTables() {
  if (tables) return tables;
  try {
    const src = readFileSync(join(TRAE_APP, "out", "main.js"), "utf8");
    const grab = (name) => {
      const m = src.match(
        new RegExp(name + "\\s*=\\s*(?:Uint8Array\\.from|new Uint8Array)\\(\\[([0-9,\\s]+)\\]\\)"),
      );
      return m ? Buffer.from(m[1].split(",").map((x) => Number(x.trim()))) : null;
    };
    const qoe = grab("qoe");
    const zoe = grab("zoe");
    if (qoe && zoe && qoe.length === 64 && zoe.length === 64) {
      log("byteCrypto tables parsed from main.js");
      tables = { mask: Buffer.from(qoe.map((v, i) => v ^ zoe[i])) };
      return tables;
    }
  } catch {
    /* fall through */
  }
  log("byteCrypto tables: using built-in fallback");
  tables = {
    mask: Buffer.from(TABLE_FALLBACK.qoe.map((v, i) => v ^ TABLE_FALLBACK.zoe[i])),
  };
  return tables;
}

const sha512 = (buf) => createHash("sha512").update(buf).digest();

function decryptAuthBlob(b64) {
  const { mask } = loadTables();
  const blob = Buffer.from(b64, "base64");
  if (blob.subarray(0, 2).toString() !== "tc" || blob[3] !== 16) {
    throw new Error("unexpected credential envelope");
  }
  const keymat = blob.subarray(6, 38);
  const buf = Buffer.alloc(128);
  sha512(keymat).copy(buf, 0);
  mask.copy(buf, 64);
  const digest = sha512(buf);
  const decipher = createDecipheriv("aes-128-cbc", digest.subarray(0, 16), digest.subarray(16, 32));
  const plain = Buffer.concat([decipher.update(blob.subarray(38)), decipher.final()]);
  const body = plain.subarray(64);
  if (!sha512(body).equals(plain.subarray(0, 64))) throw new Error("credential integrity check failed");
  return JSON.parse(body.toString("utf8"));
}

function loadCredential() {
  const store = JSON.parse(readFileSync(STORAGE, "utf8"));
  const raw = store[AUTH_KEY];
  if (!raw) throw new Error("no " + AUTH_KEY + " in " + STORAGE);
  return decryptAuthBlob(raw);
}

let credential = null;
function cred() {
  if (!credential) credential = loadCredential();
  return credential;
}

// ------------------------------------------------------------------ trae api

function authHeaders() {
  const c = cred();
  return {
    Authorization: "Cloud-IDE-JWT " + c.token,
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Trae-Client-Type": "lite",
    "X-App-Id": APP_ID,
    "X-User-Region": (c.userRegion && c.userRegion.region) || "CN",
    "X-Preferenced-Language": "en",
    "X-Trae-User-Timezone": "Asia/Shanghai",
  };
}

async function api(method, path, body, signal) {
  const res = await fetch(HOST_API + path, {
    method,
    headers: authHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (res.status === 401) {
    credential = null; // token rotated in the IDE -> re-read storage.json
    throw Object.assign(new Error("trae auth failed (401)"), { status: 401, data });
  }
  return { status: res.status, data };
}

// 客户端 bundle 里 model.listModels 的实参：不带 functions 时云端只回默认的
// solo_coder 一组（12 个模型），带上 IDE 用的 7 个分组才会返回全量目录
// （glm-5.3 / deepseek-v4.1-flash / kimi-k3 / minimax-m3 等只在 agent/work 组里）。
const MODEL_FUNCTIONS = [
  "solo_coder",
  "solo_agent_lite",
  "solo_agent_remote",
  "solo_work_lite",
  "solo_work_remote",
  "solo_design_lite",
  "solo_design_remote",
  "builder",
].join(",");

// show_custom_model=true 会带出账号里的自定义条目；实测 `z-ai/glm-5.2` 走本 relay
// 返回 200 但 content 为空（自定义条目缺自己的 provider 凭证），这种「能选但不出字」
// 的模型比没有更糟，直接不暴露。
const MODEL_EXCLUDE = new Set(["z-ai/glm-5.2"]);

async function listModels() {
  const byName = new Map();
  for (const p of [
    "/api/remote/v1/models",
    `/api/remote/v1/models?functions=${MODEL_FUNCTIONS}&show_custom_model=true&force_refresh=true`,
  ]) {
    const { status, data } = await api("GET", p);
    if (status !== 200 || !data || data.code !== 0) {
      if (!byName.size) throw new Error("models: " + JSON.stringify(data).slice(0, 200));
      continue;
    }
    for (const group of data.data.list) {
      for (const m of group.models) {
        if (MODEL_EXCLUDE.has(m.name)) continue;
        const prev = byName.get(m.name);
        if (!prev) {
          byName.set(m.name, { ...m, group: group.function, groups: [group.function] });
          continue;
        }
        if (!prev.groups.includes(group.function)) prev.groups.push(group.function);
        // 同一个模型会在多组里出现（如 glm-5.2 同时在 work / builder / design）；
        // 保留上下文窗信息最全的那条，分组则全部记录
        if (!prev.context_window_tokens && m.context_window_tokens) {
          const groups = prev.groups;
          Object.assign(prev, { ...m, group: group.function, groups });
        }
      }
    }
  }
  return [...byName.values()];
}

// Wire format accepted by chat_sessions. (The service echoes back the
// normalised shape `{type:"text",text_content:"..."}`, but only this one
// actually delivers the text.)
const prompt = (text) => [{ type: "text", data: { content: text } }];

async function createSession(text, model, mode = "work") {
  const body = {
    env: "local",
    mode,
    session_type: "assistant_chat",
    initial_message: { content: [], query: JSON.stringify(prompt(text)), model_name: model, agent_type: "" },
  };
  const { status, data } = await api("POST", "/api/remote/v1/chat_sessions", body);
  if (status !== 200 || data.code !== 0) throw new Error("createSession: " + JSON.stringify(data).slice(0, 300));
  return data.data.chat_session_id;
}

async function getMessages(sid) {
  const { status, data } = await api("GET", `/api/remote/v1/chat_sessions/${sid}/messages`);
  if (status !== 200) return [];
  return (data.data && data.data.items) || [];
}

/** Plan items carry the answer in `thought`; `finish` carries it in params.summary. */
function extractAnswer(item) {
  if (!item || !item.content) return { text: "", reasoning: "" };
  let blob;
  try {
    blob = JSON.parse(item.content);
  } catch {
    return { text: String(item.content), reasoning: "" };
  }
  const byId = new Map();
  for (const m of blob.messages || []) {
    const pi = m.plan_item;
    if (!pi) continue;
    byId.set(pi.id, pi); // same id re-sent while streaming -> last wins
  }
  const texts = [];
  const reasoning = [];
  let finishSummary = "";
  for (const pi of byId.values()) {
    if (pi.thought && pi.thought.trim()) texts.push(pi.thought);
    if (pi.reasoning_content) reasoning.push(pi.reasoning_content);
    const tc = pi.tool_call_info;
    if (tc && tc.name === "finish" && tc.params && typeof tc.params.summary === "string") {
      finishSummary = tc.params.summary;
    }
  }
  let text = texts.join("\n").trim();
  if (!text && finishSummary) text = finishSummary.trim();
  return { text, reasoning: reasoning.join("\n").trim() };
}

const TERMINAL = new Set(["completed", "finished", "success", "failed", "stopped", "canceled"]);

/**
 * Emit only the newly appended tail of a growing text. The service occasionally
 * rewrites or trims the front of a `thought` (display windowing), and replaying a
 * whole replacement would duplicate what the client already received.
 */
function emitGrowth(next, prev, onDelta) {
  if (!onDelta || !next || next === prev) return;
  if (next.startsWith(prev)) {
    onDelta(next.slice(prev.length), next);
    return;
  }
  let i = 0;
  while (i < prev.length && i < next.length && prev[i] === next[i]) i++;
  if (next.length > prev.length && i > 0) onDelta(next.slice(i), next);
}

/** Drive one turn and stream answer deltas out of the SSE event channel. */
async function runTurn(sid, { onDelta, onReasoning, signal, timeoutMs = 600000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const relayAbort = () => controller.abort();
  if (signal) signal.addEventListener("abort", relayAbort, { once: true });
  let usage = null;
  let finished = false;
  const itemState = new Map();
  try {
    const res = await fetch(`${HOST_API}/api/remote/v1/chat_sessions/${sid}/events`, {
      headers: { ...authHeaders(), Accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error("events stream HTTP " + res.status);
    let event = null;
    let buffer = "";
    const decoder = new TextDecoder("utf-8");
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) {
          const raw = line.slice(5).trim();
          let payload;
          try {
            payload = JSON.parse(raw);
          } catch {
            continue;
          }
          if (event === "plan_item") {
            const id = payload.id;
            const prev = itemState.get(id) || { thought: "", reasoning: "" };
            const thought = payload.thought || "";
            const reasoning = payload.reasoning_content || "";
            emitGrowth(thought, prev.thought, onDelta);
            emitGrowth(reasoning, prev.reasoning, onReasoning);
            itemState.set(id, { thought, reasoning });
          } else if (event === "token_usage") {
            usage = payload;
          } else if (event === "done") {
            finished = true;
            controller.abort();
          }
        }
      }
      if (finished) break;
    }
  } catch (err) {
    if (!finished && err.name !== "AbortError") throw err;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", relayAbort);
    controller.abort();
  }
  const items = await getMessages(sid);
  const assistants = items.filter((i) => i.role === "assistant");
  const last = assistants[assistants.length - 1];
  const answer = extractAnswer(last);
  if (!answer.text && itemState.size) {
    // stream aborted early: rebuild from what we saw
    const texts = [...itemState.values()].map((v) => v.thought).filter((t) => t && t.trim());
    answer.text = texts.join("\n").trim();
  }
  return { ...answer, usage, status: last ? last.status : "unknown", items };
}

// --------------------------------------------------------------- stateless
// 对齐 AutoClaw relay 的无状态语义：不再维护会话池，每次请求都新建一个
// Trae 远端会话并把完整历史拍平进去，用完即弃。回答只取决于本次请求。
// 代价：每轮都付 Trae agent system prompt 的固定 token 开销（无复用摊薄），
// 且 Trae 账号里的会话列表增长更快。

const convKey = (messages) => {
  const first = messages.find((m) => m.role === "user");
  const system = messages.find((m) => m.role === "system");
  return createHash("sha1")
    .update((system ? system.content : "") + "\u0000" + (first ? first.content : ""))
    .digest("hex");
};

/** Flatten an OpenAI message list into one Trae prompt (stateless mode: every request). */
function flatten(messages) {
  const parts = [];
  for (const m of messages) {
    const text = typeof m.content === "string" ? m.content : (m.content || []).map((p) => p.text || "").join("");
    if (!text.trim()) continue;
    if (m.role === "system") parts.push("[System instructions]\n" + text);
    else if (m.role === "user") parts.push("[User]\n" + text);
    else if (m.role === "assistant") parts.push("[Assistant]\n" + text);
  }
  const history = parts.slice(0, -1);
  const latest = parts[parts.length - 1] || "";
  if (!history.length) return latest;
  return (
    "Continue the conversation below. The messages are history; answer the final [User] message only.\n\n" +
    history.join("\n\n") +
    "\n\n" +
    latest
  );
}

// -------------------------------------------------------------- http surface

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 8 << 20) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
};

async function resolveModel(requested, catalog) {
  if (!requested) return DEFAULT_MODEL;
  const clean = String(requested).replace(/^trae\//, "");
  // 先精确命中（TitleCase 变体仍可解析），再忽略大小写（规范名/旧名都收）；
  // 未知名字原样透传，由上游给准确错误
  const hit = catalog.find((m) => m.name === clean)
    || catalog.find((m) => m.name.toLowerCase() === clean.toLowerCase());
  return hit ? hit.name : clean;
}

async function handleChatCompletions(req, res) {
  const body = await readBody(req);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const model = await resolveModel(body.model, await listModels().catch(() => []));
  const turns = messages.filter((m) => m.role === "user").length;
  const key = convKey(messages);

  const stream = body.stream === true;
  const id = "chatcmpl-" + createHash("sha1").update(key + turns + Date.now()).digest("hex").slice(0, 24);
  const created = Math.floor(Date.now() / 1000);

  if (stream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    sse(res, "chat.completion.chunk", chunkOf(id, created, model, { role: "assistant" }));
  }

  let sessionId = null;
  let text = "";
  let reasoning = "";
  let sent = "";
  const emit = (delta) => {
    sent += delta;
    if (stream) sse(res, "chat.completion.chunk", chunkOf(id, created, model, { content: delta }));
  };
  const emitReasoning = () => {};

  try {
    // 无状态（对齐 AutoClaw）：每次请求都新建远端会话，完整历史在首条
    // 消息里一次性给到，不依赖任何跨请求状态。
    sessionId = await createSession(flatten(messages), model);
    log(`chat model=${model} turns=${turns} stateless sid=${sessionId} stream=${stream}`);
    const result = await runTurn(sessionId, {
      onDelta: emit,
      onReasoning: (d, full) => {
        reasoning = full;
      },
    });
    text = result.text || reasoning || sent;
    if (stream) {
      // Deltas can lag or stop short of the authoritative answer stored on the
      // message; emit whatever the client has not seen yet (nothing to do if the
      // service rewrote text we already streamed, since that cannot be retracted).
      const tail = text === sent ? "" : text.startsWith(sent) ? text.slice(sent.length) : sent ? "" : text;
      if (tail) sse(res, "chat.completion.chunk", chunkOf(id, created, model, { content: tail }));
    }
    const usage = result.usage
      ? {
          prompt_tokens: Number(result.usage.prompt_tokens) || 0,
          completion_tokens: Number(result.usage.completion_tokens) || 0,
          total_tokens: Number(result.usage.total_tokens) || 0,
        }
      : undefined;
    if (stream) {
      sse(
        res,
        "chat.completion.chunk",
        chunkOf(id, created, model, {}, usage ? "stop" : "stop", usage),
      );
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      json(res, 200, {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage,
        trae: { session_id: sessionId, status: result.status, mode: "stateless" },
      });
    }
  } catch (err) {
    log("chat error:", err.message);
    const message = "Trae relay error: " + err.message;
    if (stream) {
      sse(res, "chat.completion.chunk", chunkOf(id, created, model, { content: "\n[relay error] " + err.message }));
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      json(res, 502, { error: { message, type: "trae_relay_error" } });
    }
  }
}

function chunkOf(id, created, model, delta, finish = null, usage) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  };
}

async function handleAnthropic(req, res) {
  const body = await readBody(req);
  const messages = [];
  if (body.system) messages.push({ role: "system", content: typeof body.system === "string" ? body.system : JSON.stringify(body.system) });
  for (const m of body.messages || []) {
    messages.push({
      role: m.role,
      content: typeof m.content === "string" ? m.content : (m.content || []).map((p) => p.text || "").join(""),
    });
  }
  const model = await resolveModel(body.model, await listModels().catch(() => []));
  const turns = messages.filter((m) => m.role === "user").length;
  const key = convKey(messages);
  const id = "msg_" + createHash("sha1").update(key + turns + Date.now()).digest("hex").slice(0, 24);
  const stream = body.stream === true;

  if (stream) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`);
    res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`);
  }
  try {
    // 无状态（对齐 AutoClaw）：每次请求都新建远端会话，完整历史在首条消息里给到。
    const sessionId = await createSession(flatten(messages), model);
    log(`messages model=${model} turns=${turns} stateless sid=${sessionId} stream=${stream}`);
    let sent = "";
    const result = await runTurn(sessionId, {
      onDelta: (delta) => {
        sent += delta;
        if (stream) res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta } })}\n\n`);
      },
    });
    const text = result.text || result.reasoning || sent;
    if (stream) {
      const tail = text === sent ? "" : text.startsWith(sent) ? text.slice(sent.length) : sent ? "" : text;
      if (tail) res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: tail } })}\n\n`);
    }
    const usage = result.usage
      ? { input_tokens: Number(result.usage.prompt_tokens) || 0, output_tokens: Number(result.usage.completion_tokens) || 0 }
      : { input_tokens: 0, output_tokens: 0 };
    if (stream) {
      res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
      res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage })}\n\n`);
      res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
      res.end();
    } else {
      json(res, 200, {
        id,
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        usage,
      });
    }
  } catch (err) {
    log("messages error:", err.message);
    if (stream) {
      res.write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "trae_relay_error", message: err.message } })}\n\n`);
      res.end();
    } else {
      json(res, 502, { type: "error", error: { type: "trae_relay_error", message: "Trae relay error: " + err.message } });
    }
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
      let credInfo = { ok: false };
      try {
        const c = cred();
        credInfo = { ok: true, userId: c.userId, expiresAt: c.expiredAt, account: c.account && c.account.username };
      } catch (err) {
        credInfo = { ok: false, error: err.message };
      }
      let models = [];
      try {
        models = (await listModels()).map((m) => m.name);
      } catch (err) {
        models = ["<models error: " + err.message + ">"];
      }
      return json(res, 200, {
        service: "trae-relay",
        upstream: HOST_API,
        credential: credInfo,
        mode: "stateless",
        models,
      });
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      const catalog = await listModels();
      // 对外 id 一律规范名（见 models-catalog.json 命名规范）：统一小写、无大小写混排。
      // 撞名时保留本就是小写拼写的那条（上游的规范形态，且覆盖组更全），
      // TitleCase 重复条目并入；旧名仍可在 chat 侧解析（resolveModel 先精确后忽略大小写）。
      const byCanon = new Map();
      for (const m of catalog) {
        const canon = String(m.name).toLowerCase();
        const prev = byCanon.get(canon);
        if (!prev) { byCanon.set(canon, m); continue; }
        if (prev.name !== canon && m.name === canon) byCanon.set(canon, m);
      }
      return json(res, 200, {
        object: "list",
        data: [...byCanon.entries()].map(([id, m]) => ({
          id,
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "trae",
          trae: { group: m.group, groups: m.groups, display_name: m.display_name, context_window: m.context_window_tokens, multimodal: m.multimodal, upstream_name: m.name },
        })),
      });
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") return handleChatCompletions(req, res);
    if (req.method === "POST" && url.pathname === "/v1/messages") return handleAnthropic(req, res);
    json(res, 404, { error: { message: "not found: " + url.pathname } });
  } catch (err) {
    log("unhandled:", err.stack || err.message);
    json(res, 500, { error: { message: String(err.message || err) } });
  }
});

server.listen(PORT, HOST, () => {
  log(`trae-relay listening on http://${HOST}:${PORT}`);
  log(`credential source: ${STORAGE}`);
  try {
    const c = cred();
    log(`trae account: ${c.account && c.account.username} (${c.userId}) expires ${c.expiredAt}`);
  } catch (err) {
    log("credential load failed: " + err.message);
  }
});
