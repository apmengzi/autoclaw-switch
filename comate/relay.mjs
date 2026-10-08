#!/usr/bin/env node
/**
 * Comate(文心快码) agent -> OpenAI/Anthropic compatible relay.
 *
 * Shape of the upstream (reversed 2026-10-06 from the zulu-cli bundle; the
 * live behaviour is documented by comate/probe_stream.mjs and pinned offline
 * by comate/test_stream.mjs against a fake upstream):
 * Comate's Zulu agent runs SERVER-SIDE. The IDE/CLI drives it through
 * three calls against https://comate.baidu.com, auth = the license UUID the
 * IDE stores in %APPDATA%\Comate\User\settings.json (baidu.comate.license;
 * NOT the legacy 32-hex secret in state.vscdb — /api/key/valid rejects it):
 *
 *   GET  /api/key/valid/:license                              preflight
 *   POST /api/aidevops/autocomate/rest/autowork/v2/conversation  -> data.id
 *   POST /api/aidevops/autocomate/rest/autowork/v2/task          -> data.taskId
 *   POST /api/aidevops/autocomate/rest/autowork/v2/execute       -> text/event-stream
 *   POST /api/aidevops/autocomate/rest/autowork/v2/execute-sync  -> {frames:[...]}
 *
 * Two execution endpoints, same body, same frame vocabulary (the CLI has
 * `execute` and `executeNonStream` for exactly this pair):
 *   execute-sync  whole answer in one JSON array of stringified "frames";
 *                 ANSWER frames carry detail.delta / reasoningDelta, the last
 *                 ends with end:true, a TOKEN_USAGE frame carries usage.
 *   execute       SSE. One JSON frame per `data:` line (heartbeat lines start
 *                 with ":heartbeat"); frames are pushed as the agent produces
 *                 them. Content types EXCEPTION / DOWNGRADE / QUOTA_EXCEED /
 *                 NEED_RETRY_EXCEPTION are terminal errors; NOTIFICATION
 *                 frames are progress chatter the CLI drops on the floor.
 * We stream by default and only fall back to execute-sync when the streaming
 * call cannot be established, so the client sees reasoning and text at the
 * pace the agent produces them instead of a finished blob cut into pieces.
 *
 * Transport matters: Baidu's WAF 406s python-urllib TLS fingerprints. The
 * CLI is Node/axios, so we speak node:https with the same header set
 * (User-Agent axios/1.16.1, Accept-Encoding with br, Connection keep-alive).
 * Responses can be brotli/gzip'd; both the JSON and the SSE readers decode
 * that themselves.
 *
 * Stateless like trae/ and doubao/: every NEW question creates a fresh
 * conversation+task, the caller re-sends the full history flattened into
 * `query`. The one exception is the tool loop (below): it is bounded and
 * transparent, nothing session-shaped is ever reused across user turns.
 *
 * Tools: the agent runs its own toolset SERVER-SIDE — FUNCTION_CALL_START /
 * _PARAMS_APPEND / _END frames carry `toolUse:[{id,name,input}]` (params
 * stream in as per-key string fragments, concatenated, see
 * appendParamContent in dist/zulu-cli). We translate those into OpenAI
 * `tool_calls` / Anthropic `tool_use`, and the results the client executes
 * come back in the request's `toolUseResults` field — the upstream's own
 * channel, on the SAME conversation+task with query:"" and isFirstQuery:false
 * (that is what the IDE kernel does). Frame names are Claude vocabulary
 * (Write/Read/Bash); TOOL_ALIASES below maps them to the canonical snake_case
 * names the CLI uses when reporting results (V10_TOOL_ALIASES in the bundle).
 *
 *   node relay.mjs [--port 18774] [--host 127.0.0.1]
 */
import { request as httpsRequest } from "node:https";
import { request as httpRequest, createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  gunzipSync, inflateSync, inflateRawSync, brotliDecompressSync,
  createGunzip, createInflate, createBrotliDecompress,
} from "node:zlib";

// Overridable so offline tests can point the whole chain at a local fake
// upstream (comate/test_stream.mjs); production always talks to Baidu.
const BASE = process.env.COMATE_RELAY_BASE || "https://comate.baidu.com";
const API = BASE + "/api/aidevops/autocomate/rest/autowork";
const CLI_VERSION = "1.8.1";
const PLUGIN_VERSION = "4.13.0";

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(name + "="));
  return eq ? eq.slice(name.length + 1) : fallback;
};
const PORT = Number(process.env.COMATE_RELAY_PORT || argOf("--port", 18774));
const HOST = process.env.COMATE_RELAY_HOST || argOf("--host", "127.0.0.1");
// What the cloud agent is told about the caller's workspace (sysInfo). The
// tools run CLIENT-side, so this is cosmetic — but a wrong root makes the
// agent probe with absolute paths it cannot know. Point it at the ZCode
// workspace when that differs from the relay's own cwd.
const WORKSPACE = process.env.COMATE_RELAY_WORKSPACE || argOf("--workspace", process.cwd());

const SETTINGS_FILE = join(
  process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
  "Comate", "User", "settings.json",
);
const STATE_DIR = join(homedir(), ".comate-relay");

// ---------------- 入站 api_key 闸门（A/B 档反代，2026-10-07） ----------------
// 此前本机任何进程都能匿名打推理；现在注册的 access.apiKey（comate-local）
// 真正当成入站钥匙：/v1/models、/v1/messages、/v1/chat/completions 必须带
// x-api-key 或 Authorization: Bearer，常数时间比对。/health 豁免（控制台
// comate:start 起来就探活，不带钥匙）。默认开启；COMATE_RELAY_KEY="" 或
// COMATE_INBOUND_AUTH=0 关闭（离线纯函数测试与 test_stream 用 0）。
// 轮换：COMATE_RELAY_KEY=新钥，或 COMATE_INBOUND_KEYS=逗号追加多把并存。
const INBOUND_AUTH = process.env.COMATE_INBOUND_AUTH !== "0";
const INBOUND_KEYS = new Set(
  ["comate-local", process.env.COMATE_RELAY_KEY || ""]
    .concat((process.env.COMATE_INBOUND_KEYS || "").split(","))
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
const INBOUND_MODEL_PATHS = ["/v1/models", "/models", "/v1/messages", "/messages",
  "/v1/chat/completions", "/chat/completions"];

function log(...a) {
  console.log(new Date().toISOString().slice(11, 19), ...a);
}

// ------------------------------------------------------------------ credentials
let credCache = { mtime: 0, license: "", username: "" };

function readCredentials() {
  let mtime = 0;
  try { mtime = statSync(SETTINGS_FILE).mtimeMs; } catch {}
  if (mtime && mtime === credCache.mtime && credCache.license) return credCache;
  const settings = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
  const license = settings["baidu.comate.license"];
  const username = settings["baidu.comate.username"] || "";
  if (!license) throw new Error("settings.json missing baidu.comate.license (Comate not logged in?)");
  credCache = { mtime, license, username };
  return credCache;
}

function deviceId() {
  // The CLI derives a stable device id; keep ours stable per install too.
  const f = join(STATE_DIR, "device.json");
  try { return JSON.parse(readFileSync(f, "utf8")).device; } catch {}
  const device = randomUUID();
  try { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(f, JSON.stringify({ device })); } catch {}
  return device;
}

// ------------------------------------------------------------------- transport
// The same header set on every outbound call: the WAF fingerprints the client
// (axios), so a diff here is what turns a 200 into a 406.
const BASE_HEADERS = {
  "Content-Type": "application/json",
  "X-Source": "COMATE",
  "User-Agent": "axios/1.16.1",
  "Accept-Encoding": "gzip, compress, deflate, br",
  Connection: "keep-alive",
  "Accept-Language": "zh-CN,zh",
};

function transportFor(url) {
  return url.startsWith("http://") ? httpRequest : httpsRequest;
}

function decodeBody(buf, headers) {
  const enc = String(headers?.["content-encoding"] || "").toLowerCase();
  const tries = enc.includes("br") ? [brotliDecompressSync]
    : enc.includes("gzip") ? [gunzipSync]
    : enc.includes("deflate") ? [inflateSync, inflateRawSync] : [];
  for (const fn of tries) {
    try { return fn(buf); } catch {}
  }
  return buf;
}

function decodeStream(res) {
  const enc = String(res.headers["content-encoding"] || "").toLowerCase();
  if (enc.includes("br")) return res.pipe(createBrotliDecompress());
  if (enc.includes("gzip")) return res.pipe(createGunzip());
  if (enc.includes("deflate")) return res.pipe(createInflate());
  return res;
}

function httpsJson(method, url, body, headers = {}, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body), "utf8");
    const req = transportFor(url)(url, {
      method,
      headers: {
        ...BASE_HEADERS,
        Accept: "application/json, text/plain, */*",
        ...(data ? { "Content-Length": data.length } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = decodeBody(Buffer.concat(chunks), res.headers).toString("utf8");
        resolve({ status: res.statusCode, text, headers: res.headers });
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`comate upstream timeout after ${timeoutMs}ms`)));
    if (data) req.write(data);
    req.end();
  });
}

// POST that expects a `text/event-stream` back. Resolves as soon as the
// headers are in — the body is consumed by parseSseFrames() below, so the
// caller sees frames while the agent is still producing them.
function ssePost(url, body, headers = {}, timeoutMs = 3_600_000) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body), "utf8");
    const req = transportFor(url)(url, {
      method: "POST",
      headers: {
        ...BASE_HEADERS,
        Accept: "text/event-stream",
        "Content-Length": data.length,
        ...headers,
      },
    }, (res) => {
      resolve({
        status: res.statusCode,
        headers: res.headers,
        stream: decodeStream(res),
        abort: () => { try { res.destroy(); } catch {} try { req.destroy(); } catch {} },
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`comate stream timeout after ${timeoutMs}ms`)));
    req.write(data);
    req.end();
  });
}

// The CLI's SSEProcessor: split on "\n", drop ":heartbeat" keep-alives, strip
// the "data:" prefix, JSON.parse each remaining line. One deliberate
// difference: the CLI aborts the whole stream on a line it cannot parse, we
// skip that line — a bad frame must not cost the caller the rest of an answer
// (same rule the offline tests pin for the sync path).
async function* parseSseFrames(stream) {
  const dec = new TextDecoder();
  let buf = "";
  const drain = function* (line) {
    const s = line.trim();
    if (!s || s.startsWith(":") || !s.startsWith("data:")) return;
    const payload = s.slice(5).trim();
    if (!payload) return;
    try { yield JSON.parse(payload); } catch {}
  };
  for await (const chunk of stream) {
    buf += dec.decode(chunk, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) yield* drain(line);
  }
  yield* drain(buf);
}

function cliHeaders(license) {
  return {
    "login-name": license,
    "Uuap-login-name": license,
    "plugin-version": "zulucli-" + PLUGIN_VERSION,
    "x-skip-fcnap": "yes",
  };
}

// ------------------------------------------------------------------ tool loop
// Frame tool names are the Claude-style vocabulary the cloud agent speaks;
// results are reported back under the canonical names below (mirrors
// V10_TOOL_ALIASES for agentVersion>=10 in the IDE's zulu-cli bundle).
const TOOL_ALIASES = {
  Bash: "run_command", Read: "read_file", Write: "write_file", Edit: "edit_file",
  Grep: "grep_content", Glob: "glob_path", Agent: "delegate_subagent", Skill: "skill",
  WebFetch: "web_fetch", WebSearch: "web_search", RealtimeSearch: "web_search",
  TodoWrite: "todo_write", ListDir: "list_dir", Delete: "delete_file",
  CodebaseSearch: "codebase_search", UseMcpTool: "use_mcp_tool", StopTask: "stop_task",
  AskUserQuestion: "ask_user_question", SendUserMessage: "send_user_message",
  CreatePlan: "create_plan", DocRead: "doc_read", DocList: "doc_list", DocSearch: "doc_search",
  GetGoal: "get_goal", CreateGoal: "create_goal", UpdateGoal: "update_goal",
  TaskCreate: "create_task", TaskUpdate: "update_task", TaskGet: "get_task", TaskList: "list_task",
  SetVMEnv: "setup_vm_environment",
};
function canonicalToolName(name) {
  return TOOL_ALIASES[name] || name || "";
}

// The IDE kernel answers these itself and never bothers the model caller
// (buildMergedParams filters them out of toolUseResults). Same here: they are
// answered relay-side so they never reach the client, which has no handler.
const INTERNAL_TOOL_NAMES = new Set(["compress_message", "task_complete", "memory_extract"]);

// Tool results must go back to the SAME conversation+task that produced the
// call, so the mapping call-id -> conversation/task has to survive between two
// HTTP requests. Bounded + TTL'd + only ever holds ids this relay handed out:
// a routing table, not a conversation pool. A miss (restart, expiry) degrades
// to the plain stateless path instead of failing.
const TOOL_ROUTING_TTL_MS = 30 * 60 * 1000;
const TOOL_ROUTING_MAX = 256;
const toolRouting = new Map();

function rememberToolRouting(calls, conversationId, taskId) {
  const now = Date.now();
  for (const [k, v] of toolRouting) if (now - v.at > TOOL_ROUTING_TTL_MS) toolRouting.delete(k);
  while (toolRouting.size + calls.length > TOOL_ROUTING_MAX && toolRouting.size)
    toolRouting.delete(toolRouting.keys().next().value);
  for (const c of calls) {
    const prev = toolRouting.get(c.id);
    toolRouting.set(c.id, {
      conversationId, taskId, at: now,
      name: c.name || prev?.name || "",
      params: c.params || prev?.params,
      internal: !!c.internal,
      internalResult: c.internalResult || prev?.internalResult,
    });
  }
}
function lookupToolRouting(ids) {
  for (const id of ids) {
    const e = toolRouting.get(id);
    if (e) return e;
  }
  return null;
}
function forgetToolRouting(ids) {
  for (const id of ids) toolRouting.delete(id);
}

// PARAMS_APPEND frames carry per-key FRAGMENTS: strings concatenate, anything
// else replaces/merges (appendParamContent in the CLI bundle only handles the
// string case and drops the rest; keeping the rest beats losing parameters).
function mergeToolParams(params, patch) {
  for (const [k, v] of Object.entries(patch || {})) {
    const prev = params[k];
    if (typeof prev === "string" && typeof v === "string") params[k] = prev + v;
    else if (v && typeof v === "object" && !Array.isArray(v) && prev && typeof prev === "object" && !Array.isArray(prev))
      params[k] = { ...prev, ...v };
    else params[k] = v;
  }
  return params;
}

// ------------------------------------------------------------------- catalog
let catalogCache = { at: 0, models: [] };

// 对外 id 一律规范名（见 models-catalog.json 的命名规范）：去 Comate 上游的
// _<hash> 后缀、去 -fc / -oneapi 工具标记。目录条目同时保留 key（上游 modelKey），
// chat 侧两种拼写都收，向上游只发 key。
function canonicalComateId(raw) {
  return String(raw).replace(/_[0-9a-f]{8,}$/i, "").replace(/-(?:fc|oneapi)$/i, "").toLowerCase();
}

// 请求里的模型名（规范名 / 上游原名 / 旧配置里的任意拼写）→ 上游 modelKey。
// 目录未就绪时原样透传，让上游给准确错误，而不是 relay 编一个。
function resolveComateModel(requested) {
  if (!requested) return "auto";
  const list = catalogCache.models;
  if (!list.length) return requested;
  const req = String(requested);
  const hit = list.find((m) => m.id === req) || list.find((m) => m.key === req)
    || list.find((m) => canonicalComateId(m.key) === canonicalComateId(req));
  return hit ? hit.key : req;
}

async function fetchModels(license, username) {
  if (catalogCache.models.length && Date.now() - catalogCache.at < 600_000) return catalogCache.models;
  const r = await httpsJson("POST", BASE + "/api/v2/api/models/available",
    { username: license, key: license }, cliHeaders(license));
  let models = [];
  try {
    const j = JSON.parse(r.text);
    const seen = new Map();   // 规范名 -> 上游 modelId；撞名时后到者保留完整原名
    for (const m of j?.data?.models || []) {
      if (!m?.modelId) continue;
      const canon = canonicalComateId(m.modelId);
      const id = seen.has(canon) ? m.modelId : canon;
      seen.set(id, m.modelId);
      models.push({ id, key: m.modelId, name: m.displayName || m.modelId });
    }
  } catch {}
  if (models.length) catalogCache = { at: Date.now(), models };
  return models;
}

// ------------------------------------------------------------- upstream chain
async function createConversation(license, trace) {
  const r = await httpsJson("POST", API + "/v2/conversation", {
    username: license, ide: "zulucli", ideVersion: CLI_VERSION, pluginVersion: PLUGIN_VERSION, agentId: 1,
  }, { ...cliHeaders(license), "X-Trace-Id": trace });
  const j = JSON.parse(r.text);
  if (j?.code !== 200 || !j?.data?.id) throw new Error(`conversation create failed: ${r.status} ${r.text.slice(0, 200)}`);
  return j.data.id;
}

async function createTask(license, conversationId, trace) {
  const r = await httpsJson("POST", API + "/v2/task", {
    username: license, ide: "zulucli", ideVersion: CLI_VERSION, pluginVersion: PLUGIN_VERSION,
    agentId: 1, conversationId, agentInfo: { agentName: "Agent", isProjectAgent: false, canInvokeAgents: true, isCustomAgent: false },
  }, { ...cliHeaders(license), "X-Trace-Id": trace });
  const j = JSON.parse(r.text);
  if (j?.code !== 200 || !j?.data?.taskId) throw new Error(`task create failed: ${r.status} ${r.text.slice(0, 200)}`);
  return j.data.taskId;
}

function flattenQuery(messages) {
  // Stateless flatten, same spirit as trae/: system becomes a bracketed
  // transcript header so the agent sees it as instructions, not its own.
  // Tool turns from the caller's history are rendered as readable lines so a
  // replay (or a fallback after the routing cache misses) still makes sense.
  const parts = [];
  for (const m of messages) {
    const role = m?.role === "assistant" ? "Assistant" : m?.role === "system" ? "System instructions" : m?.role === "tool" ? "Tool result" : "User";
    const text = typeof m?.content === "string" ? m.content : "";
    if (text.trim()) parts.push(`[${role}]\n${text.trim()}`);
    if (m?.toolCalls?.length) {
      parts.push("[Assistant tool call]\n" + m.toolCalls.map((c) => `${c.name}(${c.arguments || "{}"})`).join("\n"));
    }
    if (m?.toolResult) {
      const body = String(m.toolResult.text || "").trim();
      parts.push(`[Tool result${m.toolResult.name ? " " + m.toolResult.name : ""}]\n${body || "(empty)"}`);
    }
  }
  return parts.join("\n\n") || "hello";
}

// The body both execution endpoints take — `execute` and `execute-sync` are
// the same call with a different delivery (the CLI passes one arg object to
// both), so building it once keeps the two paths from drifting apart.
function buildExecuteBody({ license, conversationId, taskId, query, modelKey, toolUseResults, isFirstQuery, isUserQuery }) {
  return {
    username: license, ide: "zulucli", ideVersion: CLI_VERSION, pluginVersion: PLUGIN_VERSION,
    taskId, conversationId, agentId: 1,
    uploadBaseInfo: {
      os: "Windows 10", osVersion: "Windows 10", extName: "zulucli", extVersion: PLUGIN_VERSION,
      ideType: "zulucli", ideName: "zulucli", ideVersion: CLI_VERSION, vcsRepo: "", vcsBranchName: "",
      username: license, license, pluginVersion: PLUGIN_VERSION, device: deviceId(), triggerSource: "Agent",
    },
    query, modelKey,
    sysInfo: {
      os: "Windows 10", defaultShell: "cmd.exe", homeDir: homedir(),
      installedCommands: ["node", "npm", "python"], notInstalledCommands: [],
      workspacePath: WORKSPACE, workspaceRoots: [WORKSPACE],
    },
    skillInfos: [], hasMcp: false, isUserQuery: isUserQuery !== false, isMockQuery: false,
    localIndex: false, contexts: [], toolUseResults: toolUseResults || [], subAgents: [],
    agentVersion: "12", isFirstQuery: isFirstQuery !== false, enableMemory: false, systemReminder: "",
    extendUserQueryInfo: { commands: [], skills: [], subagents: [], rules: [] },
    extend: { isMultiWorkspace: false, useWorkflow: false },
    sendMode: "normal", queryId: randomUUID(), langfuseTraceId: "", langfuseTraceparent: "",
    agentInfo: { agentName: "Agent", isProjectAgent: false, canInvokeAgents: true, isCustomAgent: false },
  };
}

// Thrown when the streaming endpoint cannot be used (not SSE, HTTP error,
// transport refusal). The caller then degrades to execute-sync — but only if
// nothing has been emitted yet, which is why the check happens before the
// first frame is read.
class StreamUnavailable extends Error {}

async function executeSync(license, conversationId, taskId, query, modelKey, opts = {}) {
  const body = buildExecuteBody({
    license, conversationId, taskId, query, modelKey,
    toolUseResults: opts.toolUseResults, isFirstQuery: opts.isFirstQuery, isUserQuery: opts.isUserQuery,
  });
  const r = await httpsJson("POST", API + "/v2/execute-sync", body,
    { ...cliHeaders(license), "X-Trace-Id": randomUUID() }, 240000);
  let j;
  try { j = JSON.parse(r.text); } catch { throw new Error(`execute-sync non-JSON (${r.status}): ${r.text.slice(0, 200)}`); }
  if (Array.isArray(j?.detail) || j?.detail?.exceptionMsg || j?.type === "EXCEPTION") {
    throw new Error(`execute-sync rejected: ${r.text.slice(0, 240)}`);
  }
  return reduceFrames(j?.frames);
}

// One upstream turn over SSE. Yields raw frames; terminal frame types raise
// (a "the agent gave up" notice must not look like an empty answer).
async function* executeStreamHop({ license, conversationId, taskId, query, modelKey,
  toolUseResults, isFirstQuery, isUserQuery, registerAbort }) {
  const body = buildExecuteBody({ license, conversationId, taskId, query, modelKey, toolUseResults, isFirstQuery, isUserQuery });
  const up = await ssePost(API + "/v2/execute", body, { ...cliHeaders(license), "X-Trace-Id": randomUUID() });
  registerAbort?.(up.abort);
  const ctype = String(up.headers["content-type"] || "");
  if (up.status !== 200 || !ctype.includes("text/event-stream")) {
    let seen = "";
    try { for await (const c of up.stream) seen += Buffer.from(c).toString("utf8"); } catch {}
    throw new StreamUnavailable(`execute stream unavailable (${up.status} ${ctype || "no content-type"}): ${seen.slice(0, 200)}`);
  }
  for await (const frame of parseSseFrames(up.stream)) {
    const c = frame?.content || {};
    const d = detailOf(c);
    if (c.type === "EXCEPTION") throw new Error(`comate exception: ${d?.exceptionMsg || JSON.stringify(d).slice(0, 200)}`);
    if (c.type === "DOWNGRADE" || c.type === "QUOTA_EXCEED") throw new Error(`comate quota exceeded: ${JSON.stringify(d).slice(0, 200)}`);
    if (c.type === "NEED_RETRY_EXCEPTION") throw new Error(`comate retry requested: ${d?.exceptionMsg || "no detail"}`);
    if (c.type === "NOTIFICATION") continue;   // progress chatter, same as the CLI
    yield frame;
  }
}

// content.detail is the frame payload (content.text is the same object
// stringified); toolUse rides on FUNCTION_CALL_* AND on ANSWER frames.
function detailOf(c) {
  if (c && typeof c.detail === "object" && c.detail) return c.detail;
  try { const d = JSON.parse(c?.text || "{}"); return d.detail || d; } catch { return {}; }
}

function newTurnState() {
  return { text: "", reasoning: "", end: false, usage: null, rollbackMessageId: "", toolMap: new Map() };
}

// One frame in, one delta out. Mutates `state`; the returned {text, reasoning}
// are the pieces that just arrived, which is what lets the streaming paths
// forward them the moment the upstream produces them instead of slicing a
// finished string.
function applyFrame(state, frame) {
  let f = frame;
  if (typeof f === "string") { try { f = JSON.parse(f); } catch { return {}; } }
  const c = f?.content || {};
  const d = detailOf(c);
  const out = {};
  if (c.type === "ANSWER") {
    if (d.delta) { state.text += d.delta; out.text = d.delta; }
    if (d.reasoningDelta) { state.reasoning += d.reasoningDelta; out.reasoning = d.reasoningDelta; }
    if (d.end || c.end) state.end = true;
  } else if (c.type === "TOKEN_USAGE") {
    try {
      const u = (typeof c.detail === "object" && c.detail) || JSON.parse(c.text || "{}");
      const src = u?.usage || u?.data || u;
      const num = (...keys) => { for (const k of keys) { const v = src?.[k]; if (Number.isFinite(v)) return v; } return undefined; };
      state.usage = {
        input_tokens: num("input_tokens", "prompt_tokens", "inputTokens", "promptTokens") ?? 0,
        output_tokens: num("output_tokens", "completion_tokens", "outputTokens", "completionTokens") ?? 0,
        raw: u,
      };
    } catch {}
  }
  if (d.rollbackMessageId) state.rollbackMessageId = d.rollbackMessageId;
  for (const tu of d.toolUse || []) {
    if (!tu || !tu.id) continue;
    let cur = state.toolMap.get(tu.id);
    if (!cur) { cur = { id: tu.id, name: tu.name || "", params: {} }; state.toolMap.set(tu.id, cur); }
    if (tu.name && !cur.name) cur.name = tu.name;
    mergeToolParams(cur.params, tu.input);
    out.call = cur;
  }
  return out;
}

// Pure frame reduction (split out so it can be regression-tested offline).
function reduceFrames(frames) {
  const state = newTurnState();
  for (const raw of frames || []) applyFrame(state, raw);
  return {
    text: state.text, reasoning: state.reasoning, end: state.end,
    usage: state.usage, rollbackMessageId: state.rollbackMessageId,
    toolCalls: [...state.toolMap.values()].filter((t) => t.name),
  };
}

// The agent sometimes ends a turn on a control tool the caller has no handler
// for (compress_message / task_complete / ...). The IDE kernel answers those
// itself; we do the same, which costs one extra upstream hop (bounded to 2).
function splitCalls(calls) {
  const internal = calls.filter((t) => INTERNAL_TOOL_NAMES.has(canonicalToolName(t.name)));
  const client = calls.filter((t) => !INTERNAL_TOOL_NAMES.has(canonicalToolName(t.name)));
  return { internal, client, allInternal: internal.length > 0 && client.length === 0 };
}
function internalAnswers(calls) {
  return calls.map((t) => ({
    id: t.id, name: canonicalToolName(t.name), success: true, params: t.params, message: "ok",
  }));
}

// Record where each call's result has to be delivered. Client calls: so the
// next request can continue the same conversation+task. Internal ones (mixed
// into a batch with client calls): with a pre-built result, so that
// continuation hands both over together.
function routeCalls(clientCalls, internalCalls, conversationId, taskId) {
  rememberToolRouting(
    clientCalls.map((t) => ({ id: t.id, name: canonicalToolName(t.name), params: t.params })),
    conversationId, taskId,
  );
  if (internalCalls.length) {
    rememberToolRouting(internalCalls.map((t) => ({
      id: t.id, internal: true,
      internalResult: { id: t.id, name: canonicalToolName(t.name), success: true, params: t.params, message: "ok" },
    })), conversationId, taskId);
  }
}

// One upstream turn, plus the relay-side answer loop for control tools the
// client cannot execute (bounded: at most 2 extra hops per client request).
async function runTurn({ license, conversationId, taskId, query, toolUseResults, isFirstQuery, isUserQuery, modelKey }) {
  let out = await executeSync(license, conversationId, taskId, query, modelKey, { toolUseResults, isFirstQuery, isUserQuery });
  for (let hop = 0; hop < 2; hop++) {
    const { internal, allInternal } = splitCalls(out.toolCalls);
    if (!allInternal) break;
    log(`internal call answered relay-side: ${internal.map((t) => t.name).join(",")}`);
    out = await executeSync(license, conversationId, taskId, "", modelKey, {
      toolUseResults: internalAnswers(internal), isFirstQuery: false, isUserQuery: false,
    });
  }
  const { internal, client } = splitCalls(out.toolCalls);
  routeCalls(client, internal, conversationId, taskId);
  return { ...out, toolCalls: client };
}

// Everything a turn needs, resolved the same way for the streaming and the
// non-streaming path: which conversation+task to talk to, what to send, and
// whether this is a first query (a tool continuation is not).
async function planTurn({ messages, modelKey, pending }) {
  const license = readCredentials().license;
  const model = modelKey || "auto";
  if (pending?.results?.length) {
    // The client is answering tool calls: continue the SAME conversation+task
    // (upstream keeps the agent state; query stays empty, like the IDE).
    const route = lookupToolRouting(pending.results.map((r) => r.id));
    if (route) {
      const ids = pending.results.map((r) => r.id);
      const results = pending.results.map((r) => {
        const e = toolRouting.get(r.id);
        return {
          id: r.id,
          name: canonicalToolName(r.name) || e?.name || "",
          success: r.isError ? false : true,
          params: r.params || e?.params || {},
          message: String(r.text ?? ""),
        };
      });
      const internal = ids.map((id) => toolRouting.get(id)).filter((e) => e?.internalResult).map((e) => e.internalResult);
      forgetToolRouting(ids);
      const all = [...results, ...internal];
      log(`tool-loop continue conv=${route.conversationId} task=${route.taskId} results=${all.length} (${all.map((r) => r.name).join(",")})`);
      return {
        license, model, modelKey: model, conversationId: route.conversationId, taskId: route.taskId,
        query: "", toolUseResults: all, isFirstQuery: false, isUserQuery: false,
      };
    }
    log(`tool-loop miss for [${pending.results.map((r) => r.id).join(",")}] — cache expired or relay restarted, flattening instead`);
  }
  const trace = randomUUID();
  const conversationId = await createConversation(license, trace);
  const taskId = await createTask(license, conversationId, trace);
  return {
    license, model, modelKey: model, conversationId, taskId,
    query: flattenQuery(messages), toolUseResults: [], isFirstQuery: true, isUserQuery: true,
  };
}

// Streaming turn: same hop logic as runTurn, but every delta is yielded the
// moment it arrives, so the caller can forward it immediately.
async function* streamTurn(plan, { registerAbort } = {}) {
  const total = newTurnState();
  let query = plan.query, toolUseResults = plan.toolUseResults;
  let isFirstQuery = plan.isFirstQuery, isUserQuery = plan.isUserQuery;
  let calls = [];
  for (let hop = 0; hop <= 2; hop++) {
    const state = newTurnState();
    for await (const frame of executeStreamHop({
      license: plan.license, conversationId: plan.conversationId, taskId: plan.taskId,
      query, modelKey: plan.modelKey, toolUseResults, isFirstQuery, isUserQuery, registerAbort,
    })) {
      const d = applyFrame(state, frame);
      if (d.reasoning) { total.reasoning += d.reasoning; yield { type: "reasoning", text: d.reasoning }; }
      if (d.text) { total.text += d.text; yield { type: "text", text: d.text }; }
    }
    total.usage = state.usage || total.usage;
    total.rollbackMessageId = state.rollbackMessageId || total.rollbackMessageId;
    calls = [...state.toolMap.values()].filter((t) => t.name);
    const { internal, allInternal } = splitCalls(calls);
    if (!allInternal || hop === 2) break;
    log(`internal call answered relay-side: ${internal.map((t) => t.name).join(",")}`);
    query = ""; toolUseResults = internalAnswers(internal);
    isFirstQuery = false; isUserQuery = false;
  }
  const { internal, client } = splitCalls(calls);
  routeCalls(client, internal, plan.conversationId, plan.taskId);
  log(`chat(stream) model=${plan.model} conv=${plan.conversationId} task=${plan.taskId} chars=${total.text.length} think=${total.reasoning.length} tools=${client.length}${client.length ? " [" + client.map((t) => t.name).join(",") + "]" : ""}`);
  yield { type: "tool_calls", calls: client };
  yield { type: "done", usage: total.usage, text: total.text, reasoning: total.reasoning };
}

async function comateChat({ messages, modelKey, pending }) {
  const plan = await planTurn({ messages, modelKey, pending });
  const out = await runTurn(plan);
  log(`chat model=${plan.model} conv=${plan.conversationId} task=${plan.taskId} chars=${out.text.length} tools=${out.toolCalls.length}${out.toolCalls.length ? " [" + out.toolCalls.map((t) => t.name).join(",") + "]" : ""}`);
  return out;
}


// -------------------------------------------------------------------- flatten helpers for OpenAI/Anthropic
// Normalized message shape: {role, content, toolCalls?:[{id,name,arguments,params}],
// toolResult?:{id,name,text,isError}}. Only text + tool bookkeeping survives —
// images etc. have nowhere to go in the upstream's text `query`.
function textOfContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.filter((p) => p && (p.type === "text" || typeof p.text === "string"))
      .map((p) => p.text || "").join("\n");
  return "";
}

function normalizeOpenAIMessages(messages) {
  const out = [];
  for (const m of messages || []) {
    if (!m || !m.role) continue;
    const text = textOfContent(m.content);
    if (m.role === "tool") {
      out.push({ role: "tool", content: "", toolResult: {
        id: m.tool_call_id || "", name: m.name || "", text,
      } });
      continue;
    }
    const toolCalls = Array.isArray(m.tool_calls)
      ? m.tool_calls.map((c) => ({
          id: c?.id || "",
          name: c?.function?.name || c?.name || "",
          arguments: typeof c?.function?.arguments === "string" ? c.function.arguments
            : JSON.stringify(c?.function?.arguments ?? {}),
        })).filter((c) => c.id || c.name)
      : [];
    if (!text.trim() && !toolCalls.length) continue;
    out.push({ role: m.role, content: text, ...(toolCalls.length ? { toolCalls } : {}) });
  }
  return out;
}

function normalizeAnthropicMessages(body) {
  const out = [];
  if (body?.system) {
    const s = typeof body.system === "string" ? body.system
      : Array.isArray(body.system) ? body.system.map((b) => b?.text || "").join("\n") : "";
    if (s.trim()) out.push({ role: "system", content: s });
  }
  for (const m of body?.messages || []) {
    const role = m?.role === "assistant" ? "assistant" : "user";
    if (typeof m?.content === "string") {
      if (m.content.trim()) out.push({ role, content: m.content });
      continue;
    }
    const blocks = Array.isArray(m?.content) ? m.content : [];
    const text = blocks.filter((b) => b?.type === "text").map((b) => b.text || "").join("\n");
    const toolCalls = blocks.filter((b) => b?.type === "tool_use")
      .map((b) => ({ id: b.id || "", name: b.name || "", arguments: JSON.stringify(b.input ?? {}), params: b.input }))
      .filter((c) => c.id || c.name);
    if (text.trim() || toolCalls.length) out.push({ role, content: text, ...(toolCalls.length ? { toolCalls } : {}) });
    for (const b of blocks.filter((b) => b?.type === "tool_result")) {
      const c = Array.isArray(b.content) ? b.content.map((p) => (typeof p === "string" ? p : p?.text || "")).join("\n")
        : typeof b.content === "string" ? b.content : "";
      out.push({ role: "tool", content: "", toolResult: { id: b.tool_use_id || "", name: "", text: c, isError: !!b.is_error } });
    }
  }
  return out;
}

// A request is a tool continuation iff it ENDS with tool results (the batch
// the client just executed for the assistant turn right before them).
function extractPending(msgs) {
  const results = [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.toolResult) { results.unshift(msgs[i].toolResult); continue; }
    break;
  }
  if (!results.length) return null;
  const calls = msgs[msgs.length - results.length - 1]?.toolCalls || [];
  return { results, calls };
}


// ---------------------------------------------------------------------- SSE
function writeSse(res, payload) {
  if (res.writableEnded || res.destroyed) return false;
  try { res.write(payload); return true; } catch { return false; }
}
function sseChunk(res, model, text, reasoning, opts) {
  const d = { id: "chatcmpl-" + randomUUID(), object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: null }] };
  if (opts?.role) d.choices[0].delta.role = "assistant";
  if (reasoning) d.choices[0].delta.reasoning_content = reasoning;
  if (text) d.choices[0].delta.content = text;
  if (opts?.toolCalls) d.choices[0].delta.tool_calls = opts.toolCalls;
  if (opts?.usage) d.usage = opts.usage;
  if (opts?.finish) { d.choices[0].delta = {}; d.choices[0].finish_reason = opts.finishReason || "stop"; }
  writeSse(res, `data: ${JSON.stringify(d)}\n\n`);
}

// Upstream can think for a while before the first frame; without traffic the
// client may time out on a stream that is actually healthy. SSE comments are
// ignored by every parser.
function startHeartbeat(res, line = ": ping\n\n", ms = 15000) {
  const t = setInterval(() => writeSse(res, line), ms);
  if (t.unref) t.unref();
  return () => clearInterval(t);
}

// Client hung up? Kill the upstream call too — a zombie agent turn still
// burns the account's quota.
function bindAbort(res) {
  let fn = null;
  res.on("close", () => {
    if (!res.writableEnded && fn) { try { fn(); } catch {} }
  });
  return (f) => { fn = f; };
}

// Protocol-neutral event stream for a turn: reasoning / text as they arrive,
// then the tool calls the client has to execute, then done. When the SSE
// upstream cannot be established, this degrades to the execute-sync path —
// legal because nothing has been emitted yet at that point.
let streamFallbacks = 0;
async function* turnEvents(plan, { registerAbort } = {}) {
  let started = false;
  try {
    for await (const ev of streamTurn(plan, { registerAbort })) { started = true; yield ev; }
    return;
  } catch (e) {
    if (!(e instanceof StreamUnavailable) || started) throw e;
    streamFallbacks++;
    log(`stream unavailable (${e.message}) — degrading to execute-sync for this turn`);
  }
  const out = await runTurn(plan);
  if (out.reasoning) yield { type: "reasoning", text: out.reasoning };
  for (const piece of splitChunks(out.text)) yield { type: "text", text: piece };
  yield { type: "tool_calls", calls: out.toolCalls };
  yield { type: "done", usage: out.usage, text: out.text, reasoning: out.reasoning };
}

async function anthropicStream(res, { model, clientTools, plan, registerAbort }) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const stopBeat = startHeartbeat(res, ": ping\n\n");
  const w = (o) => writeSse(res, `data: ${JSON.stringify(o)}\n\n`);
  w({ type: "message_start", message: { id: "msg_" + randomUUID(), type: "message", role: "assistant", model, content: [], usage: { input_tokens: 0, output_tokens: 0 } } });
  let index = -1, open = null, calls = [], usage = null, textLen = 0;
  const closeBlock = () => { if (open) { w({ type: "content_block_stop", index }); open = null; } };
  const openBlock = (kind, start) => {
    if (open === kind) return;
    closeBlock(); index++;
    w({ type: "content_block_start", index, content_block: start });
    open = kind;
  };
  try {
    for await (const ev of turnEvents(plan, { registerAbort })) {
      if (ev.type === "reasoning") {
        openBlock("thinking", { type: "thinking", thinking: "" });
        w({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: ev.text } });
      } else if (ev.type === "text") {
        openBlock("text", { type: "text", text: "" });
        textLen += ev.text.length;
        w({ type: "content_block_delta", index, delta: { type: "text_delta", text: ev.text } });
      } else if (ev.type === "tool_calls") calls = ev.calls;
      else if (ev.type === "done") usage = ev.usage;
    }
  } finally { stopBeat(); }
  closeBlock();
  if (index < 0 && !calls.length) {   // never leave the caller with zero blocks
    index = 0;
    w({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
    w({ type: "content_block_stop", index });
  }
  for (const c0 of calls) {
    const c = clientToolCall(c0, clientTools);
    index++;
    w({ type: "content_block_start", index, content_block: { type: "tool_use", id: c.id, name: c.name, input: {} } });
    w({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(c.params) } });
    w({ type: "content_block_stop", index });
  }
  const outTokens = usage?.output_tokens || Math.ceil(textLen / 4);
  w({ type: "message_delta", delta: { stop_reason: calls.length ? "tool_use" : "end_turn" }, usage: { output_tokens: outTokens } });
  w({ type: "message_stop" });
  writeSse(res, "data: [DONE]\n\n");
  res.end();
}

async function openaiStream(res, { model, clientTools, plan, registerAbort }) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const stopBeat = startHeartbeat(res, ": keep-alive\n\n");
  sseChunk(res, model, "", "", { role: true });
  let calls = [], usage = null, textLen = 0;
  try {
    for await (const ev of turnEvents(plan, { registerAbort })) {
      if (ev.type === "reasoning") sseChunk(res, model, "", ev.text);
      else if (ev.type === "text") { textLen += ev.text.length; sseChunk(res, model, ev.text, ""); }
      else if (ev.type === "tool_calls") calls = ev.calls;
      else if (ev.type === "done") usage = ev.usage;
    }
  } finally { stopBeat(); }
  if (calls.length) sseChunk(res, model, "", "", { toolCalls: openaiToolCalls({ toolCalls: calls }, clientTools) });
  const completion = usage?.output_tokens || Math.ceil(textLen / 4);
  sseChunk(res, model, "", "", {
    finish: true, finishReason: calls.length ? "tool_calls" : "stop",
    usage: {
      prompt_tokens: usage?.input_tokens || 0,
      completion_tokens: completion,
      total_tokens: (usage?.input_tokens || 0) + completion,
    },
  });
  writeSse(res, "data: [DONE]\n\n");
  res.end();
}


// Caller's declared tools -> Map(name -> Set(property names) | null). The
// property set lets us drop upstream-only extras (e.g. Bash's prefix_rule /
// description) that a strict client schema would reject.
function clientToolIndex(tools, shape) {
  const idx = new Map();
  for (const t of tools || []) {
    const name = shape === "anthropic" ? t?.name : t?.function?.name || t?.name;
    const schema = shape === "anthropic" ? t?.input_schema : t?.function?.parameters || t?.parameters;
    const props = Object.keys(schema?.properties || {});
    if (name) idx.set(name, props.length ? new Set(props) : null);
  }
  return idx;
}

// Upstream frame names (Claude vocabulary) vs. the names the caller declared.
// Prefer the caller's own spelling so its tool router recognises the call;
// fall back to the upstream name when the canonical forms don't match either.
function toolNameForClient(rawName, clientTools) {
  if (!clientTools || !clientTools.size) return rawName;
  if (clientTools.has(rawName)) return rawName;
  const canon = canonicalToolName(rawName);
  for (const n of clientTools.keys()) if (canonicalToolName(n) === canon) return n;
  return rawName;
}

function clientToolCall(c, clientTools) {
  const name = toolNameForClient(c.name, clientTools);
  const props = clientTools?.get?.(name);
  if (!props) return { id: c.id, name, params: c.params || {} };
  const kept = {};
  for (const [k, v] of Object.entries(c.params || {})) if (props.has(k)) kept[k] = v;
  return { id: c.id, name, params: Object.keys(kept).length ? kept : c.params || {} };
}

function clientToolCalls(out, clientTools) {
  return out.toolCalls.map((c) => clientToolCall(c, clientTools));
}

function openaiToolCalls(out, clientTools) {
  return clientToolCalls(out, clientTools).map((c, i) => ({
    index: i, id: c.id, type: "function",
    function: { name: c.name, arguments: JSON.stringify(c.params) },
  }));
}

function splitChunks(text, n = 24) {
  if (!text) return [];
  const size = Math.max(8, Math.ceil(text.length / n));
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

// --------------------------------------------------------------------- server
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  try {
    // 入站 api_key 闸门（模型路径才校验；/health 等豁免）
    if (INBOUND_AUTH && INBOUND_MODEL_PATHS.includes(p) && !inboundKeyOk(req)) {
      const msg = "unauthorized: missing or invalid api key (x-api-key or Authorization: Bearer)";
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify(p.endsWith("/messages")
        ? { type: "error", error: { type: "authentication_error", message: msg } }
        : { error: { message: msg, type: "invalid_request_error" } }));
      return;
    }
    if (p === "/health" || p === "/") {
      let ok = false, user = "";
      try { const c = readCredentials(); ok = !!c.license; user = c.username; } catch {}
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok, service: "comate-relay", mode: "stateless",
        upstream: "v2/execute (text/event-stream), execute-sync fallback",
        stream_fallbacks: streamFallbacks,
        tool_loop: "conversation-continuation (bounded routing cache)",
        tool_routing_cached: toolRouting.size,
        credential: ok ? `ok (${user})` : "missing (Comate not logged in)",
        models_cached: catalogCache.models.length,
      }));
      return;
    }
    if (p === "/v1/models") {
      const cred = readCredentials();
      const models = await fetchModels(cred.license, cred.username);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: models.map((m) => ({ id: m.id, object: "model", owned_by: "comate", display_name: m.name, upstream_key: m.key })) }));
      return;
    }

    let body = "";
    req.on("data", (c) => (body += c));
    await new Promise((r) => req.on("end", r));
    const payload = body ? JSON.parse(body) : {};

    if (p === "/v1/messages" || p === "/messages") {
      // Anthropic shape
      const model = resolveComateModel(payload.model);
      const msgs = normalizeAnthropicMessages(payload);
      const clientTools = clientToolIndex(payload.tools, "anthropic");
      const pending = extractPending(msgs);
      if (payload.stream) {
        await anthropicStream(res, {
          model, clientTools, registerAbort: bindAbort(res),
          plan: await planTurn({ messages: msgs, modelKey: model, pending }),
        });
        return;
      }
      const out = await comateChat({ messages: msgs, modelKey: model, pending });
      const outTokens = out.usage?.output_tokens || Math.ceil(out.text.length / 4);
      const stopReason = out.toolCalls.length ? "tool_use" : "end_turn";
      const content = [];
      if (out.reasoning) content.push({ type: "thinking", thinking: out.reasoning, signature: "" });
      if (out.text) content.push({ type: "text", text: out.text });
      for (const c of clientToolCalls(out, clientTools)) {
        content.push({ type: "tool_use", id: c.id, name: c.name, input: c.params });
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "msg_" + randomUUID(), type: "message", role: "assistant", model,
        content: content.length ? content : [{ type: "text", text: "" }],
        stop_reason: stopReason,
        usage: { input_tokens: out.usage?.input_tokens || 0, output_tokens: outTokens },
      }));
      return;
    }

    if (p === "/v1/chat/completions" || p === "/chat/completions") {
      const model = resolveComateModel(payload.model);
      const msgs = normalizeOpenAIMessages(payload.messages);
      const clientTools = clientToolIndex(payload.tools, "openai");
      const pending = extractPending(msgs);
      if (payload.stream) {
        await openaiStream(res, {
          model, clientTools, registerAbort: bindAbort(res),
          plan: await planTurn({ messages: msgs, modelKey: model, pending }),
        });
        return;
      }
      const out = await comateChat({ messages: msgs, modelKey: model, pending });
      const usage = {
        prompt_tokens: out.usage?.input_tokens || 0,
        completion_tokens: out.usage?.output_tokens || Math.ceil(out.text.length / 4),
        total_tokens: (out.usage?.input_tokens || 0) + (out.usage?.output_tokens || Math.ceil(out.text.length / 4)),
      };
      const message = { role: "assistant", content: out.text || (out.toolCalls.length ? null : "") };
      if (out.reasoning) message.reasoning_content = out.reasoning;
      if (out.toolCalls.length) message.tool_calls = openaiToolCalls(out, clientTools).map(({ index, ...c }) => c);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl-" + randomUUID(), object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, message, finish_reason: out.toolCalls.length ? "tool_calls" : "stop" }],
        usage,
        comate: { mode: "stateless" },
      }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `no route ${p}` } }));
  } catch (e) {
    log("error:", e.message);
    // Upstream refusals keep their meaning: an exhausted account is a 402 to
    // the caller, not an opaque 502 (the console's 401/402/406 cheat-sheet).
    const status = /quota|额度|积分|QUOTA_EXCEED/i.test(e.message) ? 402
      : /license|login-name|unauthor|forbidden|credential/i.test(e.message) ? 401 : 502;
    if (res.headersSent) {
      // Streaming already started: end it in a shape the client can parse.
      if (p.includes("chat/completions")) writeSse(res, `data: ${JSON.stringify({ error: { message: `comate-relay: ${e.message}` } })}\n\ndata: [DONE]\n\n`);
      try { res.end(); } catch {}
      return;
    }
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `comate-relay: ${e.message}` } }));
  }
});

const LISTEN = !process.env.COMATE_RELAY_NO_LISTEN;
if (LISTEN) server.listen(PORT, HOST, () => {
  log(`comate-relay listening on http://${HOST}:${PORT} (mode: stateless, tool loop: relay-side continuation)`);
  try {
    const c = readCredentials();
    log(`credential ok: ${c.username}`);
  } catch (e) {
    log(`credential MISSING: ${e.message}`);
  }
});

export {
  server, TOOL_ALIASES, INTERNAL_TOOL_NAMES, canonicalToolName, mergeToolParams,
  toolRouting, rememberToolRouting, lookupToolRouting, forgetToolRouting,
  reduceFrames, applyFrame, newTurnState, detailOf, extractPending, flattenQuery,
  normalizeOpenAIMessages, normalizeAnthropicMessages, buildExecuteBody, splitCalls, internalAnswers,
  clientToolIndex, toolNameForClient, clientToolCall, clientToolCalls, openaiToolCalls,
  parseSseFrames, StreamUnavailable,
};
