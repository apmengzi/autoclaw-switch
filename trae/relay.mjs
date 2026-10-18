#!/usr/bin/env node
/**
 * Trae SOLO CN -> OpenAI/Anthropic compatible relay.
 *
 * Two upstream channels, chosen per request:
 *
 *   A. llm_utils_chat (preferred when the account has an app config)
 *      POST /api/agent/v3/llm_utils_chat          direct SSE, native tools
 *      - fastest shape, messages go through instead of being flattened
 *      - personal Free accounts answer `2001 failed to get app config`
 *        (verified 2026-10-18); in `auto` mode the relay then falls back to B
 *        and retries A after TRAE_LLM_RETRY_MS.
 *
 *   B. chat_sessions (always available, what this relay used before)
 *      POST /api/remote/v1/chat_sessions          create + first prompt
 *      POST /api/remote/v1/chat_sessions/:id/messages   follow-up turn
 *      GET  /api/remote/v1/chat_sessions/:id/events     SSE: plan_item deltas
 *      GET  /api/remote/v1/models                 model catalog
 *
 * Auth is the *user token* from the IDE's own credential store, decrypted
 * offline (see decrypt_auth.py for how byteCrypto was reversed):
 *
 *   storage.json[iCubeAuthInfo://icube.cloudide]
 *     = "tc" 05 10 00 00 | keymat(32) | AES-128-CBC(sha512(body)(64) | body)
 *   key   = sha512(sha512(keymat) || (qoe XOR zoe))[0:16]
 *   iv    = same digest [16:32]
 *
 *   node relay.mjs [--port 18768] [--host 127.0.0.1]
 *
 * Env:
 *   TRAE_UPSTREAM=auto|llm|session   channel policy (default auto)
 *   TRAE_HOSTS=url,url               upstream host fallback order
 *   TRAE_LLM_RETRY_MS=600000         auto-mode cooldown after a hard LLM error
 *   TRAE_MODEL_CACHE_MS=60000        model catalog TTL
 *   TRAE_REASONING=0                 disable reasoning_content/thinking output
 */
import { createDecipheriv, createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

const APP_ID = "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8";
const DEFAULT_MODEL = "Doubao-Seed-Code";
const HOSTS = (process.env.TRAE_HOSTS || "https://trae-api-cn.mchost.guru,https://api5-normal.mchost.guru")
  .split(",").map((s) => s.trim()).filter(Boolean);
let activeHost = HOSTS[0];

const UPSTREAM = (process.env.TRAE_UPSTREAM || "auto").toLowerCase(); // auto | llm | session
const LLM_RETRY_MS = Number(process.env.TRAE_LLM_RETRY_MS || 600000);
const MODEL_CACHE_MS = Number(process.env.TRAE_MODEL_CACHE_MS || 60000);
const REASONING = process.env.TRAE_REASONING !== "0";

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

// ---------------- 入站 api_key 闸门（C 档反代，2026-10-11 补齐） ----------------
// Trae 是 C 档（chat_sessions 无调用方工具通道），但对外仍是标准 anthropic/openai
// 模型端点，此前完全无鉴权——本机任何进程都能匿名打推理。现在把注册进 ZCode 的
// access.apiKey（trae-local-key）真正当成入站钥匙：/v1/models、/v1/chat/completions、
// /v1/messages 必须带 x-api-key 或 Authorization: Bearer，常数时间比对。
// /health 与 / 豁免（控制台 trae:start 起来就探活，不带钥匙）。
// 默认开启；TRAE_INBOUND_AUTH=0 关闭；轮换：TRAE_INBOUND_KEYS=逗号追加多把并存。
//
// 控制台「生成」的钥读 ~/.autoclaw-relay/inbound-keys.json（键 = 链路 id）：
// 生成是加钥，内置钥永久兜底；生成后控制台会重启本链路把新钥吃进来，手动
// 启动的实例重启一次同样生效（启动时读一次档案）。
// 档案里本链路有两摊钥：扁平主钥（「生成」）与顶层保留键 _aliases 下的标准钥
// （控制台「sk 钥」——给 dsh / Codex / OpenAI SDK 这类只认 sk- 的工具用）。
// 两摊都是本链路的有效入站钥，这里一并吃进闸门集合；改任一处都要重启本链路。
const INBOUND_AUTH = process.env.TRAE_INBOUND_AUTH !== "0";
function consoleStoreKeys() {
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), ".autoclaw-relay", "inbound-keys.json"), "utf8"));
    const main = typeof raw?.trae === "string" ? [raw.trae] : [];
    const aliases = Array.isArray(raw?._aliases?.trae) ? raw._aliases.trae : [];
    return main.concat(aliases).map((s) => (typeof s === "string" ? s.trim() : "")).filter(Boolean);
  } catch { return []; }
}
const INBOUND_KEYS = new Set(
  ["trae-local-key"]
    .concat(consoleStoreKeys())
    .concat((process.env.TRAE_INBOUND_KEYS || "").split(","))
    .map((s) => s.trim()).filter(Boolean),
);
function inboundKeyOk(req) {
  const given = (req.headers["x-api-key"]
    || String(req.headers.authorization || "").replace(/^Bearer\s+/i, "")).trim();
  if (!given) return false;
  for (const k of INBOUND_KEYS) {
    const a = Buffer.from(given, "utf8"), b = Buffer.from(k, "utf8");
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}
const INBOUND_MODEL_PATHS = ["/v1/models", "/v1/chat/completions", "/v1/messages"];

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

// --------------------------------------------------------------- device info
// llm_utils_chat validates the client shape more than the remote session API:
// it wants the IDE identity headers (device/machine/version), so read them from
// the same storage.json / product.json the desktop client uses.
let deviceInfo = null;
function device() {
  if (deviceInfo) return deviceInfo;
  let store = {};
  try { store = JSON.parse(readFileSync(STORAGE, "utf8")); } catch { /* ignore */ }
  let product = {};
  try { product = JSON.parse(readFileSync(join(TRAE_APP, "product.json"), "utf8")); } catch { /* ignore */ }
  deviceInfo = {
    deviceId: store["telemetry.devDeviceId"] || "",
    machineId: store["telemetry.machineId"] || "",
    ideVersion: process.env.TRAE_IDE_VERSION || product.appVersion || "0.1.69",
    ideVersionCode: process.env.TRAE_IDE_VERSION_CODE || "20260904",
  };
  return deviceInfo;
}

// -------------------------------------------------------------- upstream hosts

const hostsOrder = () => [activeHost, ...HOSTS.filter((h) => h !== activeHost)];

function authHeaders(accept = "application/json") {
  const c = cred();
  return {
    Authorization: "Cloud-IDE-JWT " + c.token,
    Accept: accept,
    "Content-Type": "application/json",
    "X-Trae-Client-Type": "lite",
    "X-App-Id": APP_ID,
    "X-User-Region": (c.userRegion && c.userRegion.region) || "CN",
    "X-Preferenced-Language": "en",
    "X-Trae-User-Timezone": "Asia/Shanghai",
  };
}

function llmHeaders() {
  const c = cred();
  const d = device();
  return {
    Authorization: "Cloud-IDE-JWT " + c.token,
    "X-Cloudide-Token": c.token,
    "X-Ide-Token": c.token,
    "X-Uid": String(c.userId),
    "x-uid": String(c.userId),
    "X-App-Id": APP_ID,
    "x-app-id": APP_ID,
    "x-app-version": "default",
    "x-app-version-code": d.ideVersionCode,
    "x-device-id": d.deviceId,
    "x-machine-id": d.machineId,
    "x-request-id": randomUUID(),
    "x-ide-version": d.ideVersion,
    "x-ide-version-code": d.ideVersionCode,
    "x-ide-version-type": "stable",
    "x-device-type": "windows",
    "x-device-brand": "pc",
    "x-os-version": "Windows 10",
    "x-system-type": "windows",
    "X-User-Region": (c.userRegion && c.userRegion.region) || "CN",
    "X-Preferenced-Language": "en",
    "X-Trae-User-Timezone": "Asia/Shanghai",
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "User-Agent": "Trae/" + d.ideVersion,
  };
}

/** JSON API with host failover. A 5xx or network error moves to the next host. */
async function api(method, path, body, signal) {
  let lastErr;
  const hosts = hostsOrder();
  for (const host of hosts) {
    try {
      const res = await fetch(host + path, {
        method,
        headers: authHeaders(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
      if (res.status === 401) {
        credential = null; // token rotated in the IDE -> re-read storage.json
        throw Object.assign(new Error("trae auth failed (401)"), { status: 401, data });
      }
      if (res.status >= 500 && host !== hosts[hosts.length - 1]) {
        lastErr = Object.assign(new Error("upstream HTTP " + res.status), { status: res.status, data });
        continue;
      }
      activeHost = host;
      return { status: res.status, data };
    } catch (err) {
      if (err.status === 401) throw err;
      lastErr = err;
    }
  }
  throw lastErr || new Error("no upstream host available");
}

/** SSE GET/POST with host failover; never retries once the body has started. */
async function fetchSse(path, init) {
  let lastErr;
  const hosts = hostsOrder();
  for (const host of hosts) {
    try {
      const res = await fetch(host + path, init);
      if (res.status >= 500 && host !== hosts[hosts.length - 1]) {
        lastErr = new Error("upstream HTTP " + res.status);
        continue;
      }
      activeHost = host;
      return res;
    } catch (err) {
      if (err.name === "AbortError") throw err;
      lastErr = err;
    }
  }
  throw lastErr || new Error("no upstream host available");
}

// ------------------------------------------------------------ llm_utils_chat

const LLM_ERROR_CODES = new Set(["2001", "4001", "4011", "1005", "4023"]);
let llmDisabledUntil = 0;
let llmLastError = null;

// chat_sessions resolves every request to Function=solo_agent_remote. Models
// without a config item for that function fail the turn with 4001 and return
// an empty answer; remember them so /health (and optionally /v1/models) can be
// honest about it. A failed model is re-tried after TRAE_MODEL_BAD_MS.
const MODEL_BAD_MS = Number(process.env.TRAE_MODEL_BAD_MS || 600000);
const HIDE_BAD_MODELS = process.env.TRAE_MODELS_HIDE_BAD !== "0";
const MODEL_FALLBACK = (process.env.TRAE_MODEL_FALLBACK || "").trim();
const modelHealth = new Map();
const modelIsBad = (model) => {
  const h = modelHealth.get(model);
  return h && h.badUntil > Date.now() ? h : null;
};
function markModelBad(model, err) {
  modelHealth.set(model, {
    badUntil: Date.now() + MODEL_BAD_MS,
    code: String(err.code || ""),
    message: String(err.message || "").slice(0, 300),
    at: new Date().toISOString(),
  });
}

class LlmUnavailableError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LlmUnavailableError";
    this.code = code == null ? "" : String(code);
  }
}

const llmAvailable = () => UPSTREAM !== "session" && Date.now() >= llmDisabledUntil;
function disableLlm(err) {
  llmLastError = { at: new Date().toISOString(), code: err.code || "", message: err.message };
  if (UPSTREAM === "auto") {
    llmDisabledUntil = Date.now() + LLM_RETRY_MS;
    log(`llm_utils_chat disabled for ${Math.round(LLM_RETRY_MS / 1000)}s: ${err.code || ""} ${err.message}`);
  }
}

function toTraeContent(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) {
    const out = [];
    for (const p of content) {
      if (!p) continue;
      if (p.type === "text" && typeof p.text === "string") out.push({ type: "text", text: p.text });
      else if (p.type === "image_url") {
        const url = p.image_url && typeof p.image_url === "object" ? p.image_url.url : p.image_url;
        if (url) out.push({ type: "image_url", image_url: { url } });
      } else if (p.type === "image" && p.source) {
        const s = p.source;
        if (s.type === "base64" && s.data) {
          out.push({ type: "image_url", image_url: { url: `data:${s.media_type || "image/png"};base64,${s.data}` } });
        } else if (s.type === "url" && s.url) {
          out.push({ type: "image_url", image_url: { url: s.url } });
        }
      } else if (p.type === "tool_result") {
        const text = typeof p.content === "string"
          ? p.content
          : (p.content || []).map((x) => x.text || "").join("");
        out.push({ type: "text", text: `[Tool result${p.tool_use_id ? " " + p.tool_use_id : ""}] ${text}` });
      } else if (p.type === "tool_use") {
        // carried by `tool_calls` below, not re-fed as prose
      } else if (typeof p.text === "string") out.push({ type: "text", text: p.text });
    }
    return out.length ? out : [{ type: "text", text: "" }];
  }
  return [{ type: "text", text: content == null ? "" : String(content) }];
}

function toTraeMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (!m || !m.role) continue;
    if (m.role === "tool") {
      out.push({ role: "tool", tool_call_id: m.tool_call_id, content: toTraeContent(m.content) });
      continue;
    }
    const row = {
      role: m.role === "developer" ? "system" : m.role,
      content: toTraeContent(m.content),
    };
    if (m.name) row.name = m.name;
    let calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
    if (!calls.length && Array.isArray(m.content)) {
      calls = m.content
        .filter((p) => p && p.type === "tool_use")
        .map((p) => ({ id: p.id, function: { name: p.name, arguments: JSON.stringify(p.input || {}) } }));
    }
    if (calls.length) {
      row.tool_calls = calls.map((tc) => ({
        id: tc.id,
        type: "function",
        function_call: {
          name: (tc.function && tc.function.name) || tc.name || "",
          arguments: typeof (tc.function && tc.function.arguments) === "string"
            ? tc.function.arguments
            : JSON.stringify((tc.function && tc.function.arguments) || {}),
        },
      }));
    }
    out.push(row);
  }
  return out;
}

function toTraeTools(tools) {
  return (tools || []).map((t) => {
    const f = t.function || t;
    return {
      type: "function",
      function: {
        name: f.name,
        description: f.description || "",
        parameters: typeof (f.parameters || f.input_schema) === "string"
          ? (f.parameters || f.input_schema)
          : JSON.stringify(f.parameters || f.input_schema || { type: "object", properties: {} }),
      },
    };
  });
}

// ------------------------------------------------------- emulated tool layer
// chat_sessions has no caller-tool channel, but the model can follow a strict
// text protocol. We put the tool schemas plus a one-call-per-reply contract in
// the system prompt, then turn the fenced block back into real tool_calls for
// ZCode. The tool executes on the client; its result comes back as a normal
// `role:"tool"` message and is flattened into the next turn.

function normalizeToolSpecs(tools) {
  return (tools || []).map((t) => {
    const f = t.function || t;
    return {
      name: f.name,
      description: f.description || "",
      parameters: f.parameters || f.input_schema || { type: "object", properties: {} },
    };
  }).filter((t) => t.name);
}

/** Required property names for a tool, from its JSON schema. */
function requiredParams(tools, name) {
  const spec = normalizeToolSpecs(tools).find((t) => t.name === name);
  let p = spec && spec.parameters;
  if (typeof p === "string") {
    try { p = JSON.parse(p); } catch { p = null; }
  }
  return p && Array.isArray(p.required) ? p.required : [];
}

function buildToolInstruction(tools, toolChoice) {
  const specs = normalizeToolSpecs(tools);
  const required = toolChoice === "required" || (toolChoice && typeof toolChoice === "object");
  return [
    "[Tool protocol]",
    "You are running behind an adapter that cannot pass native tool calls upstream.",
    "When a tool is needed, reply with exactly one fenced block and nothing else:",
    "```tool_call",
    '{"name":"<tool name>","arguments":{...}}',
    "```",
    "Rules:",
    "- Use only the tools listed below and match their JSON schema.",
    "- The top-level object has exactly two keys: name and arguments. Put parameters inside arguments; never put them beside name.",
    "- Balance the braces: the block contains exactly one top-level { and one matching }. Do not append an extra }.",
    "- Keep the whole block compact (under 240 characters). Split long commands or file writes into several smaller calls.",
    "- Write the block as ordinary assistant text. Do not put it inside a native finish/summary tool.",
    "- Emit one tool call per reply. Do not invent tool results; wait for the next [Tool result] message.",
    "- If the request can be completed with one of these tools, you MUST call it. Never fabricate a result and never claim you cannot access files or the system.",
    "- The whole reply must be the fenced block: no preamble, no explanation, no text outside the fence.",
    ...(required ? ["- tool_choice requires a tool call this turn: emit exactly one block now."] : []),
    "- If no tool is needed, answer normally without a tool_call block.",
    "Tools:",
    JSON.stringify(specs, null, 2),
  ].join("\n");
}

/** Merge the tool contract into the system message (or prepend one). */
function withToolProtocol(messages, tools, toolChoice) {
  if (!tools || !tools.length || toolChoice === "none") return messages;
  const instruction = buildToolInstruction(tools, toolChoice);
  const out = messages.map((m) => ({ ...m }));
  const idx = out.findIndex((m) => m.role === "system" || m.role === "developer");
  if (idx >= 0) {
    const m = out[idx];
    const text = Array.isArray(m.content)
      ? m.content.map((p) => p.text || "").join("\n")
      : String(m.content || "");
    out[idx] = { ...m, content: (text.trim() ? text + "\n\n" : "") + instruction };
  } else {
    out.unshift({ role: "system", content: instruction });
  }
  return out;
}

/**
 * JSON.parse, but tolerate junk after the first balanced object and repair a
 * tail truncated by the upstream summary limit. Returns
 * `{ value, repaired, cutInsideString, lastKey }` so the caller can refuse a
 * call that was cut in the middle of a required argument.
 */
function parseJsonLoose(text) {
  const s = String(text || "").trim();
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v)
      ? { value: v, repaired: false, cutInsideString: false, lastKey: "" }
      : null;
  } catch { /* scan for the first balanced object */ }
  let depth = 0;
  let array = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  let isKey = false;
  let keyBuf = "";
  let lastKey = "";
  let keyExpected = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') {
        inStr = false;
        if (isKey) {
          lastKey = keyBuf;
          keyBuf = "";
          keyExpected = false;
          isKey = false;
        }
      } else if (isKey) keyBuf += ch;
      continue;
    }
    if (ch === '"') {
      isKey = depth === 1 && array === 0 && keyExpected;
      inStr = true;
      continue;
    }
    if (ch === "[") { array++; continue; }
    if (ch === "]") { array--; continue; }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          const v = JSON.parse(s.slice(start, i + 1));
          return v && typeof v === "object" && !Array.isArray(v)
            ? { value: v, repaired: false, cutInsideString: false, lastKey }
            : null;
        } catch {
          return null;
        }
      }
      continue;
    }
    if (depth === 1 && array === 0 && ch === ",") { keyExpected = true; continue; }
    if (depth === 1 && array === 0 && ch === ":") { keyExpected = false; }
  }
  if (start >= 0 && depth > 0) {
    const cutInsideString = inStr;
    let fixed = s.slice(start);
    if (inStr) fixed += '"';
    fixed += "}".repeat(depth);
    try {
      const v = JSON.parse(fixed);
      return v && typeof v === "object" && !Array.isArray(v)
        ? { value: v, repaired: true, cutInsideString, lastKey }
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Pull the first declared tool call out of the model's text. Accepts fenced
 * blocks (```tool_call / ```json), <tool_call> tags, a bare JSON object, and
 * `name({...})` syntax. Returns null when the reply is ordinary prose.
 */
function parseToolCall(text, tools) {
  const raw = String(text || "");
  const names = new Set(normalizeToolSpecs(tools).map((t) => t.name));
  if (!names.size) return null;
  const resolveName = (n) => {
    if (names.has(n)) return n;
    const low = String(n || "").toLowerCase();
    return [...names].find((x) => x.toLowerCase() === low) || null;
  };
  const candidates = [];
  let m;
  const fence = /```(?:tool_call|tool|json)?\s*\n?([\s\S]*?)```/gi;
  while ((m = fence.exec(raw))) candidates.push({ json: m[1], start: m.index, end: fence.lastIndex });
  // The upstream finish-summary limit can cut the closing fence away.
  const openFence = /```(?:tool_call|tool|json)?[ \t]*\r?\n([\s\S]+)$/i.exec(raw);
  if (openFence) candidates.push({ json: openFence[1], start: openFence.index, end: raw.length });
  const xml = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
  while ((m = xml.exec(raw))) candidates.push({ json: m[1], start: m.index, end: xml.lastIndex });
  const openXml = /<tool_call>\s*([\s\S]+)$/i.exec(raw);
  if (openXml) candidates.push({ json: openXml[1], start: openXml.index, end: raw.length });
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    candidates.push({ json: trimmed, start: raw.indexOf(trimmed), end: raw.length });
  }
  const fn = /\b([A-Za-z_][\w.-]*)\s*\(\s*(\{[\s\S]*?\})\s*\)/g;
  while ((m = fn.exec(raw))) {
    if (!resolveName(m[1])) continue;
    try {
      candidates.push({ json: JSON.stringify({ name: m[1], arguments: JSON.parse(m[2]) }), start: m.index, end: fn.lastIndex });
    } catch { /* not a JSON argument list */ }
  }
  for (const c of candidates) {
    const parsed = parseJsonLoose(c.json);
    if (!parsed) continue;
    const obj = parsed.value;
    const name = resolveName(obj.name || obj.tool || obj.tool_name || (obj.function && obj.function.name));
    if (!name) continue;
    let args = obj.arguments ?? obj.parameters ?? obj.args ?? obj.input ?? (obj.function && obj.function.arguments);
    let argsRepaired = false;
    let argsCut = false;
    if (args == null) {
      // Flattened form: {"name":"Bash","command":"..."}
      const reserved = new Set(["name", "tool", "tool_name", "type", "id", "function"]);
      const flat = {};
      for (const [k, v] of Object.entries(obj)) if (!reserved.has(k)) flat[k] = v;
      if (Object.keys(flat).length) args = flat;
    }
    if (args == null) args = {};
    if (typeof args === "string") {
      const ap = parseJsonLoose(args);
      args = ap ? ap.value : {};
      argsRepaired = !!(ap && ap.repaired);
      argsCut = !!(ap && ap.cutInsideString);
    }
    if (parsed.repaired || argsRepaired) {
      // A repaired tail is only safe if no string was cut and every required
      // argument survived; otherwise we would execute a half-written command.
      const missing = requiredParams(tools, name).filter((k) => !(k in args));
      if (parsed.cutInsideString || argsCut || missing.length) continue;
    }
    const before = raw.slice(0, c.start).trim();
    const after = raw.slice(c.end).trim();
    return {
      call: {
        id: "call_" + randomUUID().replace(/-/g, "").slice(0, 24),
        type: "function",
        function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
      },
      text: [before, after].filter(Boolean).join("\n").trim(),
    };
  }
  return null;
}

/**
 * Streaming gate for emulated tools. Forwards prose deltas immediately but
 * holds back anything that could open a tool call, so the fenced block never
 * leaks to the client. `finish(hasToolCall)` flushes the hold when the reply
 * turned out to be ordinary prose.
 */
const TRUNCATED_TOOL_MSG = "[trae-relay] 模型返回的工具调用不完整（可能被上游截断），本次未执行。请重试，或改用 glm-5.1 等工具兼容模型。";

function createToolGate(onDelta, tools) {
  const names = normalizeToolSpecs(tools).map((t) => t.name).filter(Boolean);
  const markers = ["```tool", "```json", "<tool_call", ...names.map((n) => n + "(")];
  const maxHold = Math.max(24, ...markers.map((m) => m.length + 1));
  let buf = "";
  let sent = "";
  let locked = false;

  const emit = (text) => {
    if (!text) return;
    sent += text;
    if (onDelta) onDelta(text);
  };

  const suspectIndex = () => {
    if (!sent.trim()) {
      const trimmed = buf.replace(/^\s+/, "");
      if (trimmed.startsWith("{")) return buf.length - trimmed.length;
    }
    let best = -1;
    for (const m of markers) {
      const i = buf.indexOf(m);
      if (i >= 0 && (best < 0 || i < best)) best = i;
    }
    return best;
  };

  return {
    push(delta) {
      if (!delta) return;
      buf += delta;
      if (locked) return;
      const i = suspectIndex();
      if (i >= 0) {
        emit(buf.slice(0, i));
        buf = buf.slice(i);
        locked = true;
        return;
      }
      if (buf.length > maxHold) {
        emit(buf.slice(0, buf.length - maxHold));
        buf = buf.slice(-maxHold);
      }
    },
    finish(hasToolCall, discard = false) {
      if (!hasToolCall && !discard) emit(buf);
      buf = "";
      locked = false;
    },
  };
}

function parseSessionError(raw) {
  let v = raw;
  if (typeof raw === "string") {
    try { v = JSON.parse(raw); } catch { /* keep string */ }
  }
  if (v && typeof v === "object") {
    const inner = v.error && typeof v.error === "object" ? v.error : v;
    return {
      code: String(inner.code ?? inner.error_code ?? ""),
      message: String(inner.message || inner.msg || raw || "unknown error"),
    };
  }
  return { code: String(raw?.code ?? ""), message: String(raw || "unknown error") };
}

function functionForModel(info) {
  const groups = (info && info.groups) || [];
  for (const g of ["solo_work_lite", "solo_coder", "solo_agent_lite", "solo_agent", "chat_v3"]) {
    if (groups.includes(g)) return g;
  }
  return "solo_work_lite";
}

function parseToolCalls(map) {
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => ({
      id: v.id || "call_" + Math.random().toString(36).slice(2, 10),
      type: "function",
      function: { name: v.name || "", arguments: v.args || "{}" },
    }));
}

/**
 * Drive one `llm_utils_chat` turn. Always streams upstream; aggregates when the
 * caller does not pass callbacks. Throws LlmUnavailableError on the account /
 * config errors that mean "this channel cannot serve us right now".
 */
async function runLlmTurn({
  messages, model, modelInfo, tools, toolChoice, maxTokens, temperature, reasoningEffort,
  onDelta, onReasoning, signal, timeoutMs = 600000,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const relayAbort = () => controller.abort();
  if (signal) signal.addEventListener("abort", relayAbort, { once: true });
  const body = {
    messages: toTraeMessages(messages),
    function: functionForModel(modelInfo),
    config_name: model,
    model,
    model_name: model,
    config_source: 1,
    is_custom_model: false,
    provider: "",
    stream: true,
    request_id: randomUUID(),
    session_id: randomUUID(),
  };
  if (tools && tools.length) {
    body.tools = toTraeTools(tools);
    body.tool_choice = typeof toolChoice === "string" ? toolChoice : "auto";
  }
  if (Number.isFinite(Number(maxTokens))) body.max_tokens = Number(maxTokens);
  if (Number.isFinite(Number(temperature))) body.temperature = Number(temperature);
  if (typeof reasoningEffort === "string" && reasoningEffort) body.reasoning_effort = reasoningEffort;

  let res;
  try {
    res = await fetchSse("/api/agent/v3/llm_utils_chat", {
      method: "POST",
      headers: llmHeaders(),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", relayAbort);
    throw err;
  }

  const ctype = res.headers.get("content-type") || "";
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", relayAbort);
    throw new LlmUnavailableError("HTTP " + res.status, text.slice(0, 400));
  }
  if (ctype.includes("application/json")) {
    const data = await res.json().catch(() => null);
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", relayAbort);
    const code = data && (data.code ?? (data.ResponseMetadata && data.ResponseMetadata.Error && data.ResponseMetadata.Error.Code));
    const msg = data && (data.message || (data.ResponseMetadata && data.ResponseMetadata.Error && data.ResponseMetadata.Error.Message) || JSON.stringify(data));
    throw new LlmUnavailableError(code, String(msg).slice(0, 400));
  }

  let text = "";
  let reasoning = "";
  let usage = null;
  let finished = false;
  let finishReason = null;
  const toolMap = new Map();
  let event = null;
  let buffer = "";
  const decoder = new TextDecoder("utf-8");

  const mergeTool = (tc) => {
    const idx = Number.isInteger(tc.index) ? tc.index : toolMap.size;
    const prev = toolMap.get(idx) || { id: "", name: "", args: "" };
    const fn = tc.function_call || tc.function || {};
    const name = fn.name || tc.name || "";
    let args = tc.partial_arguments ?? fn.arguments ?? tc.arguments ?? "";
    if (typeof args !== "string") args = JSON.stringify(args);
    const next = {
      id: prev.id || tc.id || "",
      name: name || prev.name,
      args: prev.args + args,
    };
    // `arguments` is sometimes a cumulative snapshot; avoid duplicating it.
    if (args.startsWith(prev.args)) next.args = args;
    toolMap.set(idx, next);
  };

  const handle = (ev, payload) => {
    if (payload && payload.error) {
      const e = payload.error;
      throw new LlmUnavailableError(e.code ?? e.error_code, e.message || e.msg || JSON.stringify(e).slice(0, 300));
    }
    const name = ev || payload?.event_name || "";
    if (name === "error") {
      throw new LlmUnavailableError(payload?.code ?? payload?.error_code, payload?.message || payload?.msg || JSON.stringify(payload).slice(0, 300));
    }
    if (/usage/i.test(name) || (payload && (payload.prompt_tokens != null || payload.completion_tokens != null))) {
      usage = (payload && payload.usage) || payload;
      return;
    }
    if (name === "done") {
      finished = true;
      finishReason = payload?.finish_reason || payload?.stop_reason || finishReason;
      return;
    }
    const src = payload && payload.output && typeof payload.output === "object" ? payload.output : payload;
    if (!src || typeof src !== "object") return;
    const dText = src.content ?? src.response ?? src.text ?? (src.delta && src.delta.content) ?? "";
    if (typeof dText === "string" && dText) {
      text += dText;
      onDelta?.(dText);
    }
    const dReason = src.reasoning ?? src.reasoning_content ?? (src.delta && src.delta.reasoning_content) ?? "";
    if (typeof dReason === "string" && dReason) {
      reasoning += dReason;
      onReasoning?.(dReason);
    }
    const tcs = src.tool_calls || (src.delta && src.delta.tool_calls);
    if (Array.isArray(tcs)) for (const tc of tcs) mergeTool(tc);
  };

  try {
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) {
          const raw = line.slice(5).trim();
          if (!raw) continue;
          if (raw === "[DONE]") { finished = true; continue; }
          let payload;
          try { payload = JSON.parse(raw); } catch { continue; }
          handle(event, payload);
        }
      }
      if (finished) break;
    }
  } catch (err) {
    if (err instanceof LlmUnavailableError) throw err;
    if (err.name === "AbortError" && !finished) throw err;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", relayAbort);
    controller.abort();
  }

  const toolCalls = parseToolCalls(toolMap);
  return {
    text,
    reasoning,
    toolCalls,
    usage,
    finishReason: toolCalls.length ? "tool_calls" : (finishReason || "stop"),
    status: "completed",
  };
}

// --------------------------------------------------------------- session API

// 客户端 bundle 里 model.listModels 的实参：不带 functions 时云端只回默认的
// solo_coder 一组（12 个模型），带上 IDE 用的这些分组才会返回全量目录。
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
// 返回 200 但 content 为空（自定义条目缺自己的 provider 凭证），直接不暴露。
const MODEL_EXCLUDE = new Set(["z-ai/glm-5.2"]);

let modelCache = { at: 0, data: [] };
async function listModels(force = false) {
  if (!force && modelCache.data.length && Date.now() - modelCache.at < MODEL_CACHE_MS) {
    return modelCache.data;
  }
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
  modelCache = { at: Date.now(), data: [...byName.values()] };
  return modelCache.data;
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
  // The service windows long thoughts from the front, so `next` may be
  // `prev` minus a prefix plus a new tail. Find the longest suffix of `prev`
  // that prefixes `next` and emit only what follows it; a blind prefix diff
  // would either lose the tail or replay already-sent text.
  const max = Math.min(prev.length, next.length);
  for (let k = max; k > 0; k--) {
    if (prev.slice(prev.length - k) === next.slice(0, k)) {
      if (next.length > k) onDelta(next.slice(k), next);
      return;
    }
  }
  // No overlap at all: the window jumped. Staying silent is safer than
  // duplicating a chunk the client already has.
}

/** Drive one session turn and stream answer/reasoning deltas out of SSE. */
async function runTurn(sid, { onDelta, onReasoning, signal, timeoutMs = 600000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const relayAbort = () => controller.abort();
  if (signal) signal.addEventListener("abort", relayAbort, { once: true });
  let usage = null;
  let finished = false;
  const itemState = new Map();
  try {
    const res = await fetchSse(`/api/remote/v1/chat_sessions/${sid}/events`, {
      headers: authHeaders("text/event-stream"),
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
  const status = last ? last.status : "unknown";
  if (status === "failed") {
    const info = parseSessionError(last.error);
    const err = new Error(
      `trae session failed${info.code ? " (" + info.code + ")" : ""}: ${info.message}`,
    );
    err.code = info.code;
    err.sessionStatus = status;
    throw err;
  }
  if (status === "completed" && !answer.text && !answer.reasoning) {
    const err = new Error("trae session completed with an empty answer");
    err.code = "EMPTY";
    err.sessionStatus = status;
    throw err;
  }
  return { ...answer, usage, status, items };
}

// --------------------------------------------------------------- stateless
// 对齐 AutoClaw relay 的无状态语义：不再维护会话池，每次请求都新建一个
// Trae 远端会话并把完整历史拍平进去，用完即弃。回答只取决于本次请求。
// 代价：每轮都付 Trae agent system prompt 的固定 token 开销（无复用摊薄），
// 且 Trae 账号里的会话列表增长更快。

const contentText = (content) =>
  typeof content === "string" || content == null ? String(content || "") : JSON.stringify(content);

const convKey = (messages) => {
  const first = messages.find((m) => m.role === "user");
  const system = messages.find((m) => m.role === "system");
  return createHash("sha1")
    .update(contentText(system && system.content) + "\u0000" + contentText(first && first.content))
    .digest("hex");
};

/** Flatten an OpenAI/Anthropic message list into one Trae prompt. */
function flatten(messages) {
  const parts = [];
  const textOf = (content) => {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return content == null ? "" : String(content);
    return content.map((p) => {
      if (!p) return "";
      if (p.type === "image_url" || p.type === "image") return "[image]";
      if (p.type === "tool_result") {
        const inner = typeof p.content === "string"
          ? p.content
          : (p.content || []).map((x) => x.text || "").join("");
        return `[Tool result${p.tool_use_id ? " " + p.tool_use_id : ""}] ${inner}`;
      }
      return p.text || "";
    }).join("");
  };
  for (const m of messages) {
    const text = textOf(m.content);
    if (m.role === "tool") {
      parts.push("[Tool result" + (m.tool_call_id ? " " + m.tool_call_id : "") + "]\n" + text);
      continue;
    }
    let calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
    if (!calls.length && Array.isArray(m.content)) {
      calls = m.content
        .filter((p) => p && p.type === "tool_use")
        .map((p) => ({ function: { name: p.name, arguments: JSON.stringify(p.input || {}) } }));
    }
    if (m.role === "assistant" && calls.length) {
      const callText = calls
        .map((tc) => `${(tc.function && tc.function.name) || tc.name}(${(tc.function && tc.function.arguments) || "{}"})`)
        .join(", ");
      parts.push("[Assistant]\n" + (text.trim() ? text + "\n" : "") + "[Tool calls] " + callText);
      continue;
    }
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

// -------------------------------------------------------------- generation

/**
 * Pick a channel and produce one answer. `llm` failures that mean "this account
 * cannot use llm_utils_chat" fall back to `session` in auto mode; once a delta
 * has been emitted there is no fallback (it would duplicate text).
 */
async function generate(opts) {
  if (llmAvailable()) {
    let emitted = false;
    const wrap = (fn) => (d, full) => { if (d) emitted = true; if (fn) fn(d, full); };
    try {
      const r = await runLlmTurn({
        ...opts,
        onDelta: wrap(opts.onDelta),
        onReasoning: wrap(opts.onReasoning),
      });
      return { channel: "llm", ...r };
    } catch (err) {
      const retryable = LLM_ERROR_CODES.has(String(err.code || ""))
        || /app config|record not found/i.test(String(err.message || ""));
      if (UPSTREAM === "llm" || !retryable || emitted) throw err;
      disableLlm(err);
    }
  }
  return sessionWithFallback(opts);
}

async function runSession(opts) {
  const tools = Array.isArray(opts.tools) ? opts.tools : [];
  const emulate = tools.length > 0 && opts.toolChoice !== "none";
  const messages = emulate ? withToolProtocol(opts.messages, tools, opts.toolChoice) : opts.messages;
  const sessionId = await createSession(flatten(messages), opts.model);
  log(`session channel model=${opts.model} sid=${sessionId}${emulate ? " tools=emulated" : ""}`);
  const gate = emulate ? createToolGate(opts.onDelta, tools) : null;
  const result = await runTurn(sessionId, {
    // Emulated tools stream through a gate: prose goes out immediately, the
    // potential tool block is held until the reply is complete and parsed.
    onDelta: gate ? (d) => gate.push(d) : opts.onDelta,
    onReasoning: opts.onReasoning,
    signal: opts.signal,
  });
  if (!emulate) return { channel: "session", sessionId, ...result, toolCalls: [] };
  const parsed = parseToolCall(result.text, tools);
  // Unparseable but tool-shaped: the upstream summary limit cut it. Never leak
  // the raw block and never execute a half-written call.
  const looksLikeTool = /```tool|```json|<tool_call|^\s*\{/.test(result.text.trim());
  const truncated = !parsed && looksLikeTool;
  gate.finish(!!parsed, truncated);
  if (truncated && opts.onDelta) opts.onDelta(TRUNCATED_TOOL_MSG);
  return {
    channel: "session",
    sessionId,
    text: parsed ? parsed.text : truncated ? TRUNCATED_TOOL_MSG : result.text,
    reasoning: result.reasoning,
    usage: result.usage,
    status: result.status,
    toolCalls: parsed ? [parsed.call] : [],
    finishReason: parsed ? "tool_calls" : "stop",
  };
}

async function sessionWithFallback(opts) {
  try {
    return await runSession(opts);
  } catch (err) {
    const unprovisioned = err.code === "4001" || /config item is empty/i.test(err.message);
    // Trae's catalog can list the same model under two spellings with different
    // provisioning (e.g. DeepSeek-V4-Flash works, deepseek-v4-flash is 4001).
    // Retry the other spelling before giving up.
    if (unprovisioned && Array.isArray(opts.alternateModels)) {
      for (const alt of opts.alternateModels) {
        if (!alt || alt === opts.model || modelIsBad(alt)) continue;
        try {
          log(`model ${opts.model} failed; retrying alternate spelling ${alt}`);
          const r = await runSession({ ...opts, model: alt, modelInfo: null, alternateModels: undefined });
          return { ...r, requestedModel: opts.model, modelAlias: alt };
        } catch (e2) {
          const alsoUnprovisioned = e2.code === "4001" || /config item is empty/i.test(e2.message);
          if (!alsoUnprovisioned) throw e2;
          markModelBad(alt, e2);
        }
      }
    }
    if (unprovisioned) markModelBad(opts.model, err);
    if (unprovisioned && MODEL_FALLBACK && MODEL_FALLBACK !== opts.model) {
      log(`model ${opts.model} not provisioned; falling back to ${MODEL_FALLBACK}`);
      const r = await runSession({ ...opts, model: MODEL_FALLBACK, modelInfo: null, alternateModels: undefined });
      return { ...r, requestedModel: opts.model, modelFallback: true };
    }
    throw err;
  }
}

function usageOf(u, kind) {
  if (!u) return undefined;
  const p = Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0;
  const c = Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0;
  const t = Number(u.total_tokens) || p + c;
  return kind === "anthropic" ? { input_tokens: p, output_tokens: c } : { prompt_tokens: p, completion_tokens: c, total_tokens: t };
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

function findModel(requested, catalog) {
  if (!requested) return catalog.find((m) => m.name === DEFAULT_MODEL) || null;
  const clean = String(requested).replace(/^trae\//, "");
  // 先精确命中（TitleCase 变体仍可解析），再忽略大小写（规范名/旧名都收）；
  // 未知名字返回 null，由上游给准确错误。
  return catalog.find((m) => m.name === clean)
    || catalog.find((m) => m.name.toLowerCase() === clean.toLowerCase())
    || null;
}

function modelNameOf(requested, info) {
  if (info) return info.name;
  return String(requested || DEFAULT_MODEL).replace(/^trae\//, "");
}

/** Other catalog spellings of the same model id (case variants only). */
function caseAlternates(model, catalog) {
  const low = String(model || "").toLowerCase();
  return catalog
    .filter((m) => m.name.toLowerCase() === low && m.name !== model)
    .map((m) => m.name);
}

function friendlyError(err, model) {
  if (err.code === "4001" || /config item is empty/i.test(String(err.message || ""))) {
    return `Trae model "${model}" is not provisioned for this account (4001: config item is empty). `
      + "Working models include glm-5.1, glm-5.2, glm-5, kimi-k2.6, qwen-3.6-plus.";
  }
  if (err.code === "EMPTY") {
    return `Trae model "${model}" completed without an answer. Try another model.`;
  }
  return "Trae relay error: " + err.message;
}

async function handleChatCompletions(req, res) {
  const body = await readBody(req);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const catalog = await listModels().catch(() => []);
  const info = findModel(body.model, catalog);
  const model = modelNameOf(body.model, info);
  const alternateModels = caseAlternates(model, catalog);
  const turns = messages.filter((m) => m.role === "user").length;
  const key = convKey(messages);

  const stream = body.stream === true;
  const id = "chatcmpl-" + createHash("sha1").update(key + turns + Date.now()).digest("hex").slice(0, 24);
  const created = Math.floor(Date.now() / 1000);

  let started = false;
  let sentText = "";
  let sentReason = "";
  const ensureStream = () => {
    if (started) return;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    sse(res, "chat.completion.chunk", chunkOf(id, created, model, { role: "assistant" }));
    started = true;
  };
  const emitText = (delta) => {
    if (!delta) return;
    ensureStream();
    sentText += delta;
    sse(res, "chat.completion.chunk", chunkOf(id, created, model, { content: delta }));
  };
  const emitReason = (delta) => {
    // Upstream sometimes interleaves a late thought after the answer started.
    // Forwarding it creates a second thinking block below the reply in ZCode,
    // so drop it instead of breaking the part order.
    if (!delta || !REASONING || sentText) return;
    ensureStream();
    sentReason += delta;
    sse(res, "chat.completion.chunk", chunkOf(id, created, model, { reasoning_content: delta }));
  };

  try {
    const result = await generate({
      messages,
      model,
      modelInfo: info,
      tools: body.tools,
      toolChoice: body.tool_choice,
      alternateModels,
      maxTokens: body.max_tokens,
      temperature: body.temperature,
      reasoningEffort: body.reasoning_effort,
      onDelta: stream ? emitText : undefined,
      onReasoning: stream ? emitReason : undefined,
    });
    const toolCalls = result.toolCalls || [];
    const reasoning = result.reasoning || "";
    let text = result.text || "";
    // Reasoning is a separate channel. Copying it into content duplicates the
    // thinking block, and replaying it after the answer puts that duplicate at
    // the bottom of the turn (parts render in arrival order). Only fall back
    // when this client would otherwise receive no reasoning at all.
    const promoteReasoning = !text && reasoning && !toolCalls.length
      && (stream ? !sentReason : !REASONING);
    if (promoteReasoning) text = reasoning;
    const usage = usageOf(result.usage, "openai");

    if (stream) {
      ensureStream();
      // Never flush reasoning after content: a late tail becomes a second
      // "thinking" block under the reply. Emit it first only when the answer
      // itself has not started yet.
      if (reasoning && !sentText && !promoteReasoning) {
        const tail = reasoning.startsWith(sentReason) ? reasoning.slice(sentReason.length) : (sentReason ? "" : reasoning);
        if (tail) emitReason(tail);
      }
      if (text) {
        const tail = text.startsWith(sentText) ? text.slice(sentText.length) : (sentText ? "" : text);
        if (tail) emitText(tail);
      }
      if (toolCalls.length) {
        sse(res, "chat.completion.chunk", chunkOf(id, created, model, {
          tool_calls: toolCalls.map((tc, i) => ({
            index: i, id: tc.id, type: "function", function: tc.function,
          })),
        }));
      }
      sse(res, "chat.completion.chunk", chunkOf(id, created, model, {}, toolCalls.length ? "tool_calls" : "stop", usage));
      res.write("data: [DONE]\n\n");
      return res.end();
    }

    const message = {
      role: "assistant",
      content: toolCalls.length && !text ? null : text,
    };
    if (reasoning && REASONING) message.reasoning_content = reasoning;
    if (toolCalls.length) message.tool_calls = toolCalls;
    return json(res, 200, {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message, finish_reason: toolCalls.length ? "tool_calls" : "stop" }],
      usage,
      trae: {
        channel: result.channel,
        session_id: result.sessionId,
        status: result.status,
        mode: "stateless",
        ...(result.modelFallback ? { requested_model: result.requestedModel, model_fallback: true } : {}),
        ...(result.modelAlias ? { requested_model: result.requestedModel, model_alias: result.modelAlias } : {}),
      },
    });
  } catch (err) {
    log("chat error:", err.message);
    const message = friendlyError(err, model);
    if (stream) {
      ensureStream();
      sse(res, "chat.completion.chunk", chunkOf(id, created, model, { content: "\n[relay error] " + message }));
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      json(res, 502, { error: { message, type: "trae_relay_error", code: err.code || null } });
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
  if (body.system) {
    const sys = Array.isArray(body.system)
      ? body.system.map((p) => p.text || "").join("\n")
      : String(body.system);
    messages.push({ role: "system", content: sys });
  }
  for (const m of body.messages || []) messages.push({ role: m.role, content: m.content });

  const catalog = await listModels().catch(() => []);
  const info = findModel(body.model, catalog);
  const model = modelNameOf(body.model, info);
  const alternateModels = caseAlternates(model, catalog);
  const turns = messages.filter((m) => m.role === "user").length;
  const key = convKey(messages);
  const id = "msg_" + createHash("sha1").update(key + turns + Date.now()).digest("hex").slice(0, 24);
  const stream = body.stream === true;
  const thinkingEnabled = REASONING && !!(body.thinking && body.thinking.type === "enabled");

  let blockIndex = -1;
  let blockType = null;
  let sentText = "";
  let sentReason = "";
  const startBlock = (type) => {
    if (blockType === type) return;
    if (blockType) {
      res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: blockIndex })}\n\n`);
    }
    blockIndex++;
    blockType = type;
    const content_block = type === "thinking"
      ? { type: "thinking", thinking: "", signature: "" }
      : { type: "text", text: "" };
    res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: blockIndex, content_block })}\n\n`);
  };
  const emitText = (delta) => {
    if (!delta || !stream) return;
    startBlock("text");
    sentText += delta;
    res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: blockIndex, delta: { type: "text_delta", text: delta } })}\n\n`);
  };
  const emitReason = (delta) => {
    // Never open a thinking block after the answer: ZCode renders parts in
    // arrival order, which would put the thought under the reply.
    if (!delta || !stream || !thinkingEnabled || sentText) return;
    startBlock("thinking");
    sentReason += delta;
    res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: blockIndex, delta: { type: "thinking_delta", thinking: delta } })}\n\n`);
  };

  if (stream) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`);
  }

  try {
    const result = await generate({
      messages,
      model,
      modelInfo: info,
      tools: body.tools,
      toolChoice: body.tool_choice,
      alternateModels,
      maxTokens: body.max_tokens,
      temperature: body.temperature,
      reasoningEffort: body.thinking?.type,
      onDelta: stream ? emitText : undefined,
      onReasoning: stream ? emitReason : undefined,
    });
    const toolCalls = result.toolCalls || [];
    const reasoning = result.reasoning || "";
    let text = result.text || "";
    // Same rule as the OpenAI endpoint: a thinking block already carries the
    // reasoning, so promoting it to text duplicates it. For tool-call turns the
    // content must stay empty so the thinking is not replayed as the reply.
    const promoteReasoning = !text && reasoning && !toolCalls.length
      && (stream ? !sentReason : !thinkingEnabled);
    if (promoteReasoning) text = reasoning;
    const usage = usageOf(result.usage, "anthropic") || { input_tokens: 0, output_tokens: 0 };
    const stopReason = toolCalls.length ? "tool_use" : "end_turn";

    if (stream) {
      // Reasoning must precede text; see the note in the OpenAI handler.
      if (reasoning && !sentText && !promoteReasoning && thinkingEnabled) {
        const tail = reasoning.startsWith(sentReason) ? reasoning.slice(sentReason.length) : (sentReason ? "" : reasoning);
        if (tail) emitReason(tail);
      }
      if (text) {
        const tail = text.startsWith(sentText) ? text.slice(sentText.length) : (sentText ? "" : text);
        if (tail) emitText(tail);
      }
      if (blockType) {
        res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: blockIndex })}\n\n`);
      }
      for (const tc of toolCalls) {
        blockIndex++;
        res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: blockIndex, content_block: { type: "tool_use", id: tc.id, name: tc.function.name, input: {} } })}\n\n`);
        res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: blockIndex, delta: { type: "input_json_delta", partial_json: tc.function.arguments || "{}" } })}\n\n`);
        res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: blockIndex })}\n\n`);
      }
      res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: stopReason }, usage })}\n\n`);
      res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
      return res.end();
    }

    const content = [];
    if (thinkingEnabled && reasoning) content.push({ type: "thinking", thinking: reasoning, signature: "" });
    if (text) content.push({ type: "text", text });
    for (const tc of toolCalls) {
      let input = {};
      try { input = JSON.parse(tc.function.arguments || "{}"); } catch { input = {}; }
      content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
    }
    if (!content.length) content.push({ type: "text", text: "" });
    return json(res, 200, {
      id,
      type: "message",
      role: "assistant",
      model,
      content,
      stop_reason: stopReason,
      usage,
      trae: {
        channel: result.channel,
        session_id: result.sessionId,
        status: result.status,
        ...(result.modelFallback ? { requested_model: result.requestedModel, model_fallback: true } : {}),
        ...(result.modelAlias ? { requested_model: result.requestedModel, model_alias: result.modelAlias } : {}),
      },
    });
  } catch (err) {
    log("messages error:", err.message);
    const message = friendlyError(err, model);
    if (stream) {
      res.write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "trae_relay_error", message } })}\n\n`);
      res.end();
    } else {
      json(res, 502, { type: "error", error: { type: "trae_relay_error", message, code: err.code || null } });
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
        upstream: activeHost,
        upstreams: HOSTS,
        upstream_mode: UPSTREAM,
        credential: credInfo,
        mode: "stateless",
        channels: {
          llm_utils_chat: {
            available: llmAvailable(),
            disabled_until: llmDisabledUntil ? new Date(llmDisabledUntil).toISOString() : null,
            last_error: llmLastError,
          },
          chat_sessions: { available: true },
        },
        model_cache_age_ms: modelCache.at ? Date.now() - modelCache.at : null,
        model_fallback: MODEL_FALLBACK || null,
        model_health: [...modelHealth.entries()].map(([model, h]) => ({
          model,
          active: h.badUntil > Date.now(),
          until: new Date(h.badUntil).toISOString(),
          code: h.code,
          message: h.message,
          at: h.at,
        })),
        models,
      });
    }
    // 入站闸门：/health 与 / 之上的所有模型端点都要钥匙（OPTIONS 不经过本处理分支）
    if (INBOUND_AUTH && INBOUND_MODEL_PATHS.includes(url.pathname) && !inboundKeyOk(req)) {
      const isAnthropic = url.pathname === "/v1/messages";
      const body = isAnthropic
        ? { type: "error", error: { type: "authentication_error", message: "unauthorized: missing or invalid api key (x-api-key or Authorization: Bearer)" } }
        : { error: { message: "unauthorized: missing or invalid api key (x-api-key or Authorization: Bearer)" } };
      return json(res, 401, body);
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      const catalog = await listModels();
      // 对外 id 一律规范名（见 models-catalog.json 命名规范）：统一小写、无大小写混排。
      // 撞名时保留本就是小写拼写的那条（上游的规范形态，且覆盖组更全），
      // TitleCase 重复条目并入；旧名仍可在 chat 侧解析（findModel 先精确后忽略大小写）。
      // 目录仍完整保留给 findModel 解析；只把整族拼写都失败的模型从对外清单里摘掉，
      // 避免 ZCode 选到必然失败的条目（同族只要有一个拼写可用就保留）。
      const familyBad = (m) => {
        const low = m.name.toLowerCase();
        return catalog.filter((x) => x.name.toLowerCase() === low).every((x) => modelIsBad(x.name));
      };
      const visible = HIDE_BAD_MODELS ? catalog.filter((m) => !familyBad(m)) : catalog;
      const byCanon = new Map();
      for (const m of visible) {
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
  log(`upstream mode: ${UPSTREAM}; hosts: ${HOSTS.join(", ")}`);
  try {
    const c = cred();
    log(`trae account: ${c.account && c.account.username} (${c.userId}) expires ${c.expiredAt}`);
  } catch (err) {
    log("credential load failed: " + err.message);
  }
});
