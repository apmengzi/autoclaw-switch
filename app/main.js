// AutoClaw → ZCode 反代控制台 — Electron 主进程
// 职责：relay 与凭证同步器的生命周期、状态聚合、按需查询（积分/注册/日志）。
// 设计约束：所有对上游的出站请求仅由用户在界面点击触发（无固定节奏轮询）。
const { app, BrowserWindow, ipcMain } = require("electron");
const { spawn, spawnSync, execSync } = require("child_process");const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const ZC = require("./zcode-config.js");   // ZCode 供应商配置的读写闸门（纯 Node，回归测试见 app/test_zcode_config.js）
const IK = require("./inbound-keys.js");   // 入站 api_key 的生成/存档（纯 Node，回归测试见 app/test_inbound_keys.js）
const CX = require("./codex-config.js");   // Codex 配置（~/.codex/config.toml）的托管区读写闸门（纯 Node，回归测试见 app/test_codex_config.js）

const HOME = os.homedir();
const RELAY_DIR = path.join(HOME, ".autoclaw-relay");
const INBOUND_KEYS_FILE = IK.storePath(HOME);   // 「生成 api_key」的档案（0600，runtime 数据不进仓库）
const RELAY_SERVER = path.join(RELAY_DIR, "server.mjs");
const RELAY_LOG = path.join(RELAY_DIR, "relay.log");
const RELAY_PERSONA = path.join(RELAY_DIR, "persona.txt");
const WATCH_LOG = path.join(RELAY_DIR, "watch_auth.log");
const AUTH_COMPAT = path.join(RELAY_DIR, "auth-compat", "auth.json");
const STATE_DIR = path.join(HOME, ".openclaw-autoclaw");
const REQ_HEADERS = path.join(STATE_DIR, "request-headers.json");
const ZCODE_CFG = process.env.ASWITCH_ZCODE_CFG || path.join(HOME, ".zcode", "v2", "provider_config.json");
const PROVIDER_ID = "autoclaw-glm-provider";
const WB_PROVIDER_ID = "workbuddy-openai-provider";
// 资源根：打包态（exe）由 electron-builder 的 extraResources 放进 resources/，
// 开发态用工作区的兄弟目录。两种形态保持同名目录层级，Python 片段里的相对路径
// `../autoclaw-switch/a_switch.py`（cwd=bridge/）在两种形态下都成立；直接 clone
// 本仓库当工作区时该文件在仓库根，片段里会退到 `../a_switch.py`（见 PY_LOAD_A_SWITCH）。
const IS_PACKAGED = app.isPackaged;
const RES_ROOT = IS_PACKAGED ? process.resourcesPath : path.join(__dirname, "..");
// A-SWITCH 1.x 后端：一键注册 / 余额查询 / 凭证同步都要加载它
const A_SWITCH_PY = [
  path.join(RES_ROOT, "autoclaw-switch", "a_switch.py"),
  path.join(RES_ROOT, "a_switch.py"),
].find((p) => fs.existsSync(p)) || path.join(RES_ROOT, "autoclaw-switch", "a_switch.py");
const WB_BIN_DIR = IS_PACKAGED
  ? path.join(RES_ROOT, "workbuddy")
  : path.join(RES_ROOT, "workbuddy", "workbuddy-manager-v1.0.79", "upstream");
// wb2api 用相对路径读写 ./auths 与 ./data，安装目录（如 Program Files）又可能不可写，
// 所以打包态固定用用户目录当工作目录，首次启动从资源里播种 config.json
const WB_WORK_DIR = IS_PACKAGED ? path.join(HOME, ".workbuddy-gateway") : WB_BIN_DIR;
const WB_EXE = path.join(WB_BIN_DIR, "wb2api.exe");
const WB_LOGIN_EXE = path.join(WB_BIN_DIR, "wb2api-login.exe");
const WB_CONFIG = path.join(WB_WORK_DIR, "config.json");
const WB_LOG = path.join(WB_WORK_DIR, "server.log");
const WB_PORT = 7863;
const WB_MODELS = ["glm-5.3", "glm-5.2", "cn:auto", "cn:fast-model"];
const TRAE_PROVIDER_ID = "trae-openai-provider";
const TRAE_RELAY = path.join(RES_ROOT, "trae", "relay.mjs");
// 日志放在用户目录而不是项目里：relay 的启动日志会打印 Trae 账号名与到期时间，
// 放在仓库树内有被一起提交的风险
const TRAE_LOG = path.join(HOME, ".trae-relay", "relay.log");
const TRAE_PORT = 18768;
const DOUBAO_PROVIDER_ID = "doubao-openai-provider";
const DOUBAO_RELAY = path.join(RES_ROOT, "doubao", "relay.mjs");
// 同 Trae：日志落在用户目录；cookie 快照与 relay 配置都在 ~/.doubao-relay/，不进仓库
const DOUBAO_LOG = path.join(HOME, ".doubao-relay", "relay.log");
const DOUBAO_COOKIES = path.join(HOME, ".doubao-relay", "cookies-cdp.json");
const DOUBAO_CDP = path.join(RES_ROOT, "doubao", "cdp.js");
const DOUBAO_CDP_PORT = 9222;
const DOUBAO_PORT = 18770;
// --- Comate（文心快码，comate/relay.mjs）：凭证由 relay 自行从 Comate IDE settings.json 读取 ---
const COMATE_PROVIDER_ID = "comate-openai-provider";
const COMATE_RELAY = path.join(RES_ROOT, "comate", "relay.mjs");
const COMATE_LOG = path.join(HOME, ".comate-relay", "relay.log");
const COMATE_PORT = 18774;
const COMATE_SETTINGS = path.join(process.env.APPDATA || path.join(HOME, "AppData", "Roaming"),
  "Comate", "User", "settings.json");
// --- Qoder CN（vendored 社区网关 qoder/qoder_proxy.py，COSY 签名；另含千问办公 qworkcn 区）---
const QODER_PROVIDER_ID = "qoder-openai-provider";
const QODER_PROXY = path.join(RES_ROOT, "qoder", "qoder_proxy.py");
const QODER_LOG = path.join(HOME, ".qoder-relay", "gateway.log");
const QODER_PORT = 8791;
const QODER_PANEL_PASSWORD = "admin";   // 社区网关面板默认密码，仅绑定 127.0.0.1 使用
// --- 千问办公（QwenWork CN）：与 Qoder CN 共用上面这个网关进程（同一端口、
// 同一账号池），靠「绑定出口的 API Key」把请求分流到 qworkcn 账号池。
// ZCode 的供应商配置没有自定义请求头字段，绑 Key 是官方设计的出口选择方式 ---
const QWENWORK_PROVIDER_ID = "qwenwork-openai-provider";
const QODER_REALM_KEYS = path.join(RELAY_DIR, "qoder-realm-keys.json");
const BRIDGE_DIR = path.join(RES_ROOT, "bridge");
const RELAY_SRC = path.join(BRIDGE_DIR, "server_2x.mjs");   // relay 源码随项目走，首次运行部署到 RELAY_DIR
// --- Codex（Codex CLI）：只讲 chat completions 的链路走 bridge/codex_front.mjs 翻译，
// relay 自带 /v1/responses 的链路由 Codex 直连；配置写进 ~/.codex/config.toml 的托管区 ---
const CODEX_FRONT = path.join(BRIDGE_DIR, "codex_front.mjs");
const CODEX_FRONT_PORT = CX.FRONT_PORT;                     // 18776（与 codex-config.js 的唯一口径一致）
const CODEX_FRONT_LOG = path.join(RELAY_DIR, "codex-front.log");
// 顶层键旧值快照（0600，runtime 数据不进仓库）；自测会把它指到临时目录，免得动到用户真实快照
const codexStatePath = () => process.env.ASWITCH_CODEX_STATE || path.join(RELAY_DIR, "codex-state.json");
let codexFrontProc = null;
/** config.toml 的落点：尊重 CODEX_HOME（Codex 自己的口径），没有就是 ~/.codex */
const codexCfgPath = () => path.join(process.env.CODEX_HOME || path.join(HOME, ".codex"), "config.toml");
const PERSONA_SRC = path.join(BRIDGE_DIR, "persona.txt");    // 种子（老版本随包；新版本由提取器生成，见下）
const PERSONA_EXTRACTOR = path.join(BRIDGE_DIR, "extract_persona.py");  // 从已装客户端提取 persona（厂商文本不入库）
const PYTHON = "python";
// 与 trae/relay.mjs 保持一致：Trae 客户端把登录态写在这里，relay 离线解密它
const TRAE_STORAGE = path.join(process.env.APPDATA || path.join(HOME, "AppData", "Roaming"),
  "TRAE SOLO CN", "User", "globalStorage", "storage.json");

const RELAY_ENV = {
  ...process.env,
  AUTOCLAW_CONTRACT: "2x",
  AUTOCLAW_CLOUD_LANE: "cn",
  AUTOCLAW_CLIENT_VERSION: "2.0.1",
  AUTOCLAW_X_CHANNEL: "official",
  AUTOCLAW_X_TRACE_ID: "autoclaw-desktop",
  AUTOCLAW_HARNESS_MARKER: "0",
  AUTOCLAW_MAX_OUTPUT_TOKENS: "0",
};

let relayProc = null;
let watchProc = null;
let mainWindow = null;

function log(...args) {
  const line = `[console ${new Date().toISOString()}] ${args.join(" ")}`;
  console.log(line);
  try { fs.appendFileSync(path.join(RELAY_DIR, "console.log"), line + "\n"); } catch {}
}

function relayAlive() {
  try {
    const out = execSync("netstat -ano | findstr :18766 | findstr LISTENING", { shell: "cmd.exe", timeout: 8000 }).toString();
    return /LISTENING/.test(out);
  } catch { return false; }
}

/**
 * 首次运行自举：relay 运行在 ~/.autoclaw-relay/，源码随项目走（bridge/）。
 * 两个文件都必须到位：server.mjs 是反代本体；persona.txt 是 2.x 闸门的硬要求
 * （system 必须与应用 persona 逐字一致，relay 自带的兜底文案会被判 406）。
 * 返回 null 表示可用，返回字符串表示失败原因。
 */
function ensureRelayServer() {
  try { fs.mkdirSync(RELAY_DIR, { recursive: true }); } catch {}
  if (!fs.existsSync(RELAY_SRC)) return `未找到 relay 源码（${RELAY_SRC}），请确认在完整项目目录内运行控制台`;
  try {
    // 缺失或内容不同都（重）部署——历史上只在缺失时复制，升级控制台后 ~/.autoclaw-relay/
    // 里的旧 server.mjs 永远不会被替换，relay 一直跑旧代码（表现为“重装了但模型名没变”）。
    const srcBuf = fs.readFileSync(RELAY_SRC);
    const serverExists = fs.existsSync(RELAY_SERVER);
    if (!serverExists || !srcBuf.equals(fs.readFileSync(RELAY_SERVER))) {
      fs.copyFileSync(RELAY_SRC, RELAY_SERVER);
      log(serverExists ? "updated relay server.mjs from" : "deployed relay server.mjs from", RELAY_SRC);
    }
    // persona：厂商文本不入库（PR#4 维护者建议），由 extract_persona.py 从已安装客户端
    // 提取。每次启动都跑一次 --if-stale（客户端更新后自动跟进）；提取失败时若运行时已有
    // 旧文件继续用（好过没有），都没有才退回随包种子（老版本包里还有 bridge/persona.txt）。
    const ex = extractPersonaTo(true);
    if (ex) log("persona 提取器:", ex);
    if (!fs.existsSync(RELAY_PERSONA)) {
      if (fs.existsSync(PERSONA_SRC)) fs.copyFileSync(PERSONA_SRC, RELAY_PERSONA);
      else return `未找到 persona（提取失败：${ex || "未知原因"}）。安装并登录一次 AutoClaw 2.x 后再点「启动」；缺 persona 时 2.x 闸门会拒绝所有请求`;
    }
    return null;
  } catch (e) { return `部署 relay 失败：${String((e && e.message) || e)}`; }
}

/**
 * 跑 bridge/extract_persona.py 把应用 persona 提取到运行时目录。
 * 返回 null=成功（含 kept/unchanged），否则为错误描述。python/node 缺失按失败处理。
 */
function extractPersonaTo(ifStale) {
  if (!fs.existsSync(PERSONA_EXTRACTOR)) return "未找到 bridge/extract_persona.py";
  const args = [PERSONA_EXTRACTOR, "--out", RELAY_PERSONA];
  if (ifStale) args.push("--if-stale");
  try {
    const r = spawnSync(PYTHON, args, { encoding: "utf8", timeout: 90000, windowsHide: true });
    const line = (r.stdout || "").trim().split("\n").filter((l) => l.startsWith("{")).pop();
    let res = {};
    try { res = JSON.parse(line || "{}"); } catch {}
    if (r.status !== 0 || res.ok === false) return (res.error || r.stderr || `python 退出码 ${r.status}`).slice(0, 200);
    log("persona:", res.action || "checked", `(${res.chars || "?"} chars)`);
    return null;
  } catch (e) {
    return String((e && e.message) || e).slice(0, 200);
  }
}

/**
 * 打包态：WorkBuddy 网关的工作目录固定在用户目录（~/.workbuddy-gateway/），
 * 首次启动播种 config.json 并建好 auths/ 与 data/（wb2api 以相对路径读写它们）。
 * 开发态直接复用工作区 upstream 目录，无需播种。返回 null 表示可用。
 */
function ensureWbWorkDir() {
  if (!IS_PACKAGED) return null;
  try {
    fs.mkdirSync(path.join(WB_WORK_DIR, "auths"), { recursive: true });
    fs.mkdirSync(path.join(WB_WORK_DIR, "data"), { recursive: true });
    if (!fs.existsSync(WB_CONFIG)) {
      const src = path.join(WB_BIN_DIR, "config.json");
      if (!fs.existsSync(src)) return `未找到随包的 config.json（${src}）`;
      fs.copyFileSync(src, WB_CONFIG);
      log("seeded workbuddy config.json ->", WB_CONFIG);
    }
    return null;
  } catch (e) { return `准备 WorkBuddy 工作目录失败：${String((e && e.message) || e)}`; }
}

/**
 * spawn 包装：命令不存在时（没装 python / node）Node 会抛未捕获的 'error' 事件，
 * 在 Electron 主进程里表现为 “A JavaScript error occurred in the main process” 模态弹窗，
 * 且弹窗会阻塞主进程事件循环——整个控制台卡死。所有 spawn 都必须挂 error 监听，
 * 把失败降级成可以展示给用户的错误字符串。
 */
function trySpawn(cmd, args, opts) {
  const st = { proc: null, error: null };
  try {
    const p = spawn(cmd, args, opts);
    p.on("error", (e) => {
      st.error = e && e.code === "ENOENT" ? `未找到可执行文件：${cmd}（PATH 中不存在）` : String((e && e.message) || e);
      log("[spawn error]", cmd, st.error);
    });
    st.proc = p;
  } catch (e) {
    st.error = String((e && e.message) || e);
    log("[spawn throw]", cmd, st.error);
  }
  return st;
}

function spawnDetached(cmd, args, opts = {}) {
  // detached：控制台关闭后同步器等后台服务继续存活
  const st = trySpawn(cmd, args, {
    cwd: opts.cwd || RELAY_DIR,
    env: { ...process.env, ...(opts.env || {}) },
    windowsHide: true,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!st.proc) return st;
  const p = st.proc;
  p.unref();
  p.stdout.on("data", () => {});
  p.stderr.on("data", (d) => log("[stderr]", String(d).slice(0, 200)));
  return st;
}

/** 跑一条命令取首行输出（环境体检用来探测 node / python 是否可用） */
function probeCmd(cmd, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const st = trySpawn(cmd, args, { windowsHide: true });
    if (!st.proc) return resolve({ ok: false, error: st.error || "无法启动" });
    let out = "";
    st.proc.stdout.on("data", (c) => (out += c));
    st.proc.stderr.on("data", (c) => (out += c));
    const tm = setTimeout(() => { try { st.proc.kill(); } catch {} resolve({ ok: false, error: `超时（${timeoutMs / 1000}s）` }); }, timeoutMs);
    st.proc.on("error", (e) => { clearTimeout(tm); resolve({ ok: false, error: st.error || String((e && e.message) || e) }); });
    st.proc.on("close", (code) => { clearTimeout(tm); resolve({ ok: code === 0, out: out.trim().split(/\r?\n/)[0] || "" }); });
  });
}

/**
 * Node 运行时发现：exe 客户端不能假设用户装了 Node（relay 与 Trae 网关都是 .mjs）。
 * 顺序：PATH（≥18）→ AutoClaw 自带 node（装了客户端就有）→ 控制台自身
 * （Electron 以 ELECTRON_RUN_AS_NODE 当纯 node 跑，版本随 Electron，等同 Node 20）。
 */
function findNode() {
  const probe = (cmd) => {
    try {
      const out = execSync(`"${cmd}" -v`, { timeout: 5000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
      const m = out.match(/^v?(\d+)\./);
      return m && Number(m[1]) >= 18 ? out : null;
    } catch { return null; }
  };
  const sys = probe("node");
  if (sys) return { cmd: "node", env: {}, source: `PATH · ${sys}` };
  const roots = [process.env.AUTOCLAW_HOME, "C:\\AutoClaw", "D:\\AutoClaw", "E:\\AutoClaw", "F:\\AutoClaw",
    path.join(HOME, "AppData", "Local", "AutoClaw")].filter(Boolean);
  for (const r of roots) {
    const p = path.join(r, "resources", "node", "node.exe");
    if (fs.existsSync(p)) { const v = probe(p); if (v) return { cmd: p, env: {}, source: `AutoClaw 自带 · ${v}` }; }
  }
  return { cmd: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" },
    source: `控制台自带运行时 · Node ${process.versions.node}` };
}

function healthOnce(timeoutMs = 4000) {
  return new Promise((resolve) => {
    const req = http.get("http://127.0.0.1:18766/health", { timeout: timeoutMs }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve({ ok: res.statusCode === 200, ...JSON.parse(d) }); } catch { resolve({ ok: false }); } });
    });
    req.on("error", () => resolve({ ok: false }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false }); });
  });
}

function watcherRunning() {
  if (watchProc) return true;
  try {
    const pid = Number(fs.readFileSync(path.join(RELAY_DIR, "watch_auth.pid"), "utf8").trim());
    if (!pid) return false;
    process.kill(pid, 0);  // 探测存活，不杀
    return true;
  } catch { return false; }
}

function readTokenExp() {
  try {
    const a = JSON.parse(fs.readFileSync(AUTH_COMPAT, "utf8"));
    const tok = (a.token || "").replace(/^Bearer\s+/i, "");
    const payload = JSON.parse(Buffer.from(tok.split(".")[1], "base64").toString("utf8"));
    return { exp: payload.exp || 0, iat: payload.iat || 0, uid: payload.user_id || "" };
  } catch { return { exp: 0, iat: 0, uid: "" }; }
}

let wbProc = null;
let wbCreditsCache = null;

function wbAlive() {
  try {
    const out = execSync(`netstat -ano | findstr :${WB_PORT} | findstr LISTENING`, { shell: "cmd.exe", timeout: 8000 }).toString();
    return /LISTENING/.test(out);
  } catch { return false; }
}

function wbHttp(method, apiPath, body, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: "127.0.0.1", port: WB_PORT, path: apiPath, method,
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${linkApiKey("workbuddy")}`,
                 ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}) },
      timeout: timeoutMs,
    }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve({ ok: res.statusCode === 200, status: res.statusCode, j: JSON.parse(d) }); } catch { resolve({ ok: res.statusCode < 400, status: res.statusCode, raw: d.slice(0, 200) }); } });
    });
    req.on("error", () => resolve({ ok: false, status: 0 }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, status: 0 }); });
    if (data) req.write(data);
    req.end();
  });
}

async function wbHealth() {
  if (!wbAlive()) return { running: false, ok: false };
  const m = await wbHttp("GET", "/v1/models");
  return { running: true, ok: m.ok, models: (m.j?.data || []).map((x) => x.id) };
}

// --- Trae 平台（trae/relay.mjs，同时提供 openai + anthropic 两套协议）---
let traeProc = null;

function traeAlive() {
  try {
    const out = execSync(`netstat -ano | findstr :${TRAE_PORT} | findstr LISTENING`, { shell: "cmd.exe", timeout: 8000 }).toString();
    return /LISTENING/.test(out);
  } catch { return false; }
}

function traeHttp(method, apiPath, body, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: "127.0.0.1", port: TRAE_PORT, path: apiPath, method,
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${linkApiKey("trae")}`,
                 ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}) },
      timeout: timeoutMs,
    }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve({ ok: res.statusCode === 200, status: res.statusCode, j: JSON.parse(d) }); } catch { resolve({ ok: res.statusCode < 400, status: res.statusCode, raw: d.slice(0, 200) }); } });
    });
    req.on("error", () => resolve({ ok: false, status: 0 }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, status: 0 }); });
    if (data) req.write(data);
    req.end();
  });
}

/** 一次拿全：运行状态 + 凭证 + 模型目录（relay 的 /health 已聚合，sessions 也在里面） */
async function traeHealth() {
  if (!traeAlive()) return { running: false, ok: false };
  const h = await traeHttp("GET", "/health", null, 20000);
  if (!h.j) return { running: true, ok: false };
  return { running: true, ok: h.ok && h.j.credential?.ok === true, ...h.j };
}

/** Trae 的 openai 兼容模型目录（状态展示与 ZCode 注册共用） */
async function traeModels() {
  const m = await traeHttp("GET", "/v1/models", null, 20000);
  return m.j?.data || [];
}

// --- 豆包工作（doubao/relay.mjs；登录态来自客户端 cookie 快照）---
let doubaoProc = null;

function doubaoAlive() {
  try {
    const out = execSync(`netstat -ano | findstr :${DOUBAO_PORT} | findstr LISTENING`, { shell: "cmd.exe", timeout: 8000 }).toString();
    return /LISTENING/.test(out);
  } catch { return false; }
}

function doubaoHttp(method, apiPath, body, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: "127.0.0.1", port: DOUBAO_PORT, path: apiPath, method,
      headers: { "Content-Type": "application/json", "x-api-key": linkApiKey("doubao"),
                 ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}) },
      timeout: timeoutMs,
    }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve({ ok: res.statusCode === 200, status: res.statusCode, j: JSON.parse(d) }); } catch { resolve({ ok: res.statusCode < 400, status: res.statusCode, raw: d.slice(0, 200) }); } });
    });
    req.on("error", () => resolve({ ok: false, status: 0 }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, status: 0 }); });
    if (data) req.write(data);
    req.end();
  });
}

/** relay 的 /health 已聚合 cookie 体检；ok 以“有 sessionid/ttwid 且没有缺失”为准 */
async function doubaoHealth() {
  if (!doubaoAlive()) return { running: false, ok: false };
  const h = await doubaoHttp("GET", "/health", null, 10000);
  if (!h.j) return { running: true, ok: false };
  return { running: true, ok: h.ok && h.j.cookies?.ok === true, ...h.j };
}

async function doubaoModels() {
  const m = await doubaoHttp("GET", "/v1/models", null, 10000);
  return m.j?.data || [];
}

// --- Comate（comate/relay.mjs；登录态 = Comate IDE settings.json 里的 license，relay 运行时自行读取）---
let comateProc = null;

function comateAlive() {
  try {
    const out = execSync(`netstat -ano | findstr :${COMATE_PORT} | findstr LISTENING`, { shell: "cmd.exe", timeout: 8000 }).toString();
    return /LISTENING/.test(out);
  } catch { return false; }
}

function comateHttp(method, apiPath, body, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: "127.0.0.1", port: COMATE_PORT, path: apiPath, method,
      headers: { "Content-Type": "application/json", "x-api-key": linkApiKey("comate"),
                 ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}) },
      timeout: timeoutMs,
    }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve({ ok: res.statusCode === 200, status: res.statusCode, j: JSON.parse(d) }); } catch { resolve({ ok: res.statusCode < 400, status: res.statusCode, raw: d.slice(0, 200) }); } });
    });
    req.on("error", () => resolve({ ok: false, status: 0 }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, status: 0 }); });
    if (data) req.write(data);
    req.end();
  });
}

async function comateHealth() {
  if (!comateAlive()) return { running: false, ok: false };
  const h = await comateHttp("GET", "/health", null, 10000);
  if (!h.j) return { running: true, ok: false };
  return { running: true, ok: h.ok && h.j.credential?.startsWith?.("ok"), ...h.j };
}

async function comateModels() {
  const m = await comateHttp("GET", "/v1/models", null, 20000);
  return m.j?.data || [];
}

// --- Qoder CN（vendored 社区网关 qoder/qoder_proxy.py；Python 长驻进程，双区+千问办公账号池）---
let qoderProc = null;

function qoderAlive() {
  try {
    const out = execSync(`netstat -ano | findstr :${QODER_PORT} | findstr LISTENING`, { shell: "cmd.exe", timeout: 8000 }).toString();
    return /LISTENING/.test(out);
  } catch { return false; }
}

function qoderHttp(method, apiPath, body, timeoutMs = 8000, headers = {}) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: "127.0.0.1", port: QODER_PORT, path: apiPath, method,
      headers: { "Content-Type": "application/json", ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}), ...headers },
      timeout: timeoutMs,
    }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve({ ok: res.statusCode === 200, status: res.statusCode, j: JSON.parse(d) }); } catch { resolve({ ok: res.statusCode < 400, status: res.statusCode, raw: d.slice(0, 200) }); } });
    });
    req.on("error", () => resolve({ ok: false, status: 0 }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, status: 0 }); });
    if (data) req.write(data);
    req.end();
  });
}

async function qoderHealth() {
  if (!qoderAlive()) return { running: false, ok: false };
  const h = await qoderHttp("GET", "/health", null, 10000);
  if (!h.j) return { running: true, ok: false };
  const realm = h.j.realm || "cn";
  const p = (h.j.realms || {})[realm];   // 老网关没有分区明细，退回总量
  return {
    running: true,
    ok: p ? (p.ready || 0) > 0 : (h.j.accounts_ready || 0) > 0,
    accounts: p ? (p.accounts || 0) : (h.j.accounts || 0),
    ready: p ? (p.ready || 0) : (h.j.accounts_ready || 0),
    realm,
  };
}

async function qoderModels(timeoutMs = 20000) {
  // 网关开启入站鉴权后 /v1/models 同样查 Key：带 cn 出口 Key（与 ZCode 注册同值）
  const key = qoderRealmKey("cn") || "qoder-local";
  const m = await qoderHttp("GET", "/v1/models", null, timeoutMs, { Authorization: `Bearer ${key}` });
  return (m.j?.data || []).filter((x) => x && x.id && x.enabled !== false);
}

/** 千问办公的模型目录：同一个网关，换成 qworkcn 出口的 Key 再问一次 */
async function qwenworkModels(timeoutMs = 20000) {
  const key = qoderRealmKey("qworkcn");
  const m = await qoderHttp("GET", "/v1/models", null, timeoutMs, key ? { Authorization: `Bearer ${key}` } : { "X-Realm": "qworkcn" });
  return (m.j?.data || []).filter((x) => x && x.id && x.enabled !== false);
}

/** 千问办公的登录态：网关 /health 的分区明细里取 qworkcn 一栏 */
async function qwenworkHealth() {
  if (!qoderAlive()) return { running: false, ok: false };
  const h = await qoderHttp("GET", "/health", null, 10000);
  if (!h.j) return { running: true, ok: false };
  const r = (h.j.realms || {}).qworkcn || {};
  return { running: true, ok: (r.ready || 0) > 0, accounts: r.accounts || 0, realm: "qworkcn" };
}

/** 控制台自己生成并保管的两个出口 Key（明文只在本地文件里，网关侧存副本） */
function readRealmKeys() {
  try { return JSON.parse(fs.readFileSync(QODER_REALM_KEYS, "utf8")) || {}; } catch { return {}; }
}

function qoderRealmKey(realm) { return readRealmKeys()[realm] || ""; }

/**
 * 「现在该用哪把钥」的唯一口径：ZCode 注册值、控制台自己发请求的 header、
 * 盘点列表第一位（= keys:probe 的带钥探针）都用它，三者不能各拿各的。
 * 优先级：控制台生成钥（~/.autoclaw-relay/inbound-keys.json）> 链路自有配置
 * （workbuddy 读 wb2api config.json 的 api_key；qoder/千问办公读网关出口 Key）
 * > 各链路内置常量（须与 relay 源码逐字一致，见 app/inbound-keys.js）。
 */
function linkApiKey(linkId) {
  if (linkId === "workbuddy") {
    try {
      const k = JSON.parse(fs.readFileSync(WB_CONFIG, "utf8")).api_key;
      if (typeof k === "string" && k.trim()) return k.trim();
    } catch {}
    return IK.BUILTIN.workbuddy;
  }
  if (linkId === "qoder" || linkId === "qwenwork") {
    return qoderRealmKey(linkId === "qoder" ? "cn" : "qworkcn") || IK.BUILTIN[linkId];
  }
  return IK.activeKey(IK.readStore(INBOUND_KEYS_FILE), linkId) || IK.BUILTIN[linkId];
}

/**
 * 让网关里存在「绑定到本机两个出口」的 Key，并把明文留一份给控制台注册用。
 *
 * ZCode 供应商配置没有自定义请求头字段，出口只能靠 Key 绑定来选（网关
 * _request_realm：显式参数 > Key 绑定 > X-Realm 头 > 全局开关）。写入走面板
 * 的 /settings/save 全量替换语义——别人在面板里建的 Key 用空值占位保留原值，
 * 只增改控制台自己那两条（id = aswitch-<realm>）。
 *
 * 入站鉴权保持开启（auth_disabled:false）：/v1 全部路径要求带 Key，
 * 本机任何进程不能再匿名打推理。控制台自己的调用（qoderModels / smoke）
 * 都带上对应的 cn / qworkcn 出口 Key，注册的 ZCode 供应商也用同一把。
 */
async function qoderEnsureRealmKeys() {
  const l = await qoderHttp("POST", "/panel/login", { password: QODER_PANEL_PASSWORD }, 10000);
  const token = l.j?.token || "";
  if (!token) return { ok: false, error: "面板登录失败（默认密码 admin 被改过？在网关看板里改回，或同步此处的密码）" };
  const st = await qoderHttp("GET", "/panel/status", null, 10000, { "X-Panel-Token": token });
  const existing = st.j?.api_keys || [];
  const store = readRealmKeys();
  const payload = existing.map((e) => ({ id: e.id, name: e.name, realm: e.realm, enabled: e.enabled !== false, key: "" }));
  let changed = false;
  for (const [realm, label] of [["cn", "Qoder CN"], ["qworkcn", "千问办公"]]) {
    if (!store[realm]) { store[realm] = "qd-" + require("crypto").randomBytes(18).toString("hex"); changed = true; }
    const id = `aswitch-${realm}`;
    const row = { id, name: `A-SWITCH ${label}`, realm, enabled: true, key: store[realm] };
    const i = payload.findIndex((e) => e.id === id);
    if (i >= 0) payload[i] = row; else payload.push(row);
  }
  try { fs.writeFileSync(QODER_REALM_KEYS, JSON.stringify(store, null, 1), { mode: 0o600 }); } catch (e) { return { ok: false, error: `出口 Key 落盘失败：${e.message}` }; }
  const save = await qoderHttp("POST", "/settings/save", { api_keys: payload, auth_disabled: false }, 15000, { "X-Panel-Token": token });
  if (!save.ok) return { ok: false, error: `出口 Key 写入网关失败：${save.j?.error?.message || ("HTTP " + save.status)}` };
  return { ok: true, generated: changed, realms: Object.keys(store) };
}

/** 把本机已登录的 Qoder/千问办公桌面凭证导入网关账号池（面板两步确认流程的自动化） */
async function qoderSyncAccounts() {
  const l = await qoderHttp("POST", "/panel/login", { password: QODER_PANEL_PASSWORD }, 10000);
  const token = l.j?.token || "";
  if (!token) return { ok: false, error: "面板登录失败（默认密码 admin 被改过？在网关看板里改回或同步此处的密码）" };
  const scan = await qoderHttp("POST", "/accounts/import/desktop", {}, 60000, { "X-Panel-Token": token });
  const detected = scan.j?.detected || [];
  const valid = detected.filter((c) => c.valid);
  if (!valid.length) {
    return { ok: false, error: "本机未发现已登录的 Qoder/千问办公凭证（先装客户端并登录一次）", detected: detected.map((d) => d.realm) };
  }
  const imp = await qoderHttp("POST", "/accounts/import/desktop", { all: true }, 120000, { "X-Panel-Token": token });
  if (imp.j?.error) return { ok: false, error: typeof imp.j.error === "string" ? imp.j.error : JSON.stringify(imp.j.error).slice(0, 200) };
  const imported = (imp.j?.imported || []).map((a) => `${a.nickname || a.uid?.slice(0, 8)}(${a.realm})`);
  return { ok: imported.length > 0, imported, validRealms: valid.map((v) => v.realm) };
}

/** 豆包工作客户端的可执行文件：默认装在 D:\DoubaoWork，也认 %LOCALAPPDATA% 下的用户级安装 */
function findDoubaoExe() {
  const candidates = [
    "D:\\DoubaoWork\\DoubaoWork.exe",
    path.join(process.env.LOCALAPPDATA || "", "Programs", "DoubaoWork", "DoubaoWork.exe"),
    path.join(process.env.LOCALAPPDATA || "", "DoubaoWork", "DoubaoWork.exe"),
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || "";
}

/** 客户端是否带着调试端口在跑（cookie 快照只能从 CDP 抓） */
function doubaoClientDebug() {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port: DOUBAO_CDP_PORT, path: "/json/version", method: "GET", timeout: 2500 }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve({ ok: res.statusCode === 200, browser: JSON.parse(d).Browser }); } catch { resolve({ ok: false }); } });
    });
    req.on("error", () => resolve({ ok: false }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false }); });
    req.end();
  });
}

function readZcodeRegistration() {
  try {
    const cfg = JSON.parse(fs.readFileSync(ZCODE_CFG, "utf8"));
    const conf = cfg.config || {};
    const rules = conf.providerConfigRules?.providerRules || [];
    const rule = rules.find((r) => r.providerId === PROVIDER_ID);
    // 卡片要显示的是“ZCode 侧已注册多少模型”（配置文件为准），不是网关当前存活多少
    const countOf = (pid) => (rules.find((r) => r.providerId === pid)?.config?.personalModelIds || []).length;
    const counts = { wbModels: countOf(WB_PROVIDER_ID), traeModels: countOf(TRAE_PROVIDER_ID), doubaoModels: countOf(DOUBAO_PROVIDER_ID),
      comateModels: countOf(COMATE_PROVIDER_ID), qoderModels: countOf(QODER_PROVIDER_ID),
      qwenworkModels: countOf(QWENWORK_PROVIDER_ID) };
    if (!rule) return { registered: false, ...counts };
    return {
      registered: true,
      enabled: !!rule.enabled,
      baseUrl: rule.config?.api?.baseUrl || "",
      models: rule.config?.personalModelIds || [],
      inOrder: (conf.providerOrder || []).includes(PROVIDER_ID),
      ...counts,
    };
  } catch (e) { return { registered: false, error: String(e) }; }
}

function pythonOneShot(script, extraEnv = {}, timeoutMs = 90000) {
  // 用 importlib 加载 a_switch.py 并执行片段；单次按需调用，非固定节奏。
  return new Promise((resolve) => {
    let out = "", err = "", settled = false, timer = null;
    const done = (v) => { if (!settled) { settled = true; if (timer) clearTimeout(timer); resolve(v); } };
    const st = trySpawn(PYTHON, ["-c", script], {
      cwd: BRIDGE_DIR,
      env: { ...process.env, AUTOCLAW_AUTH_DIR: path.join(RELAY_DIR, "auth-compat"), PYTHONIOENCODING: "utf-8", ...extraEnv },
      windowsHide: true,
    });
    const p = st.proc;
    if (!p) {
      done({ ok: false, error: `${st.error || "无法启动 python"}；一键注册 / 余额查询 / 凭证同步依赖本机 Python（a_switch.py）` });
      return;
    }
    timer = setTimeout(() => { try { p.kill(); } catch {} done({ ok: false, error: `python 调用超时（${Math.round(timeoutMs / 1000)} 秒）`, out, err }); }, timeoutMs);
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (err += c));
    p.on("error", (e) => done({ ok: false, error: st.error || String((e && e.message) || e), out, err }));
    p.on("close", (code) => done({ ok: code === 0, code, out, err }));
  });
}

// a_switch.py（A-SWITCH 1.x 后端）在两种开发树里位置不同：工作区的仓库镜像目录是
// ../autoclaw-switch/，而"直接 clone 本仓库当工作区"时它就在仓库根（../）。两个候选
// 都试一遍，clone 下来就能用；打包态的 resources/autoclaw-switch/ 命中第一个。
const PY_LOAD_A_SWITCH = `
import sys, json, os
import importlib.util
_p = next((q for q in ('../autoclaw-switch/a_switch.py', '../a_switch.py') if os.path.exists(q)), None)
if not _p:
    print(json.dumps({"ok": False, "error": "找不到 a_switch.py：../autoclaw-switch/ 与 ../ 都没有"}))
    sys.exit(0)
sys.argv=['x']
spec=importlib.util.spec_from_file_location('a', _p)
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
`;

const POINTS_SNIPPET = PY_LOAD_A_SWITCH + `
m.BASE = "https://autoglm-api.zhipuai.cn"  # CN 账号余额在 CN identity 网关
accs=m.discover_accounts()
if not accs:
    print(json.dumps({"ok": False, "error": "no account"}))
else:
    a=accs[0]
    pts=a.points() or {}
    exp=a.access_expires_at()
    print(json.dumps({"ok": True, "nickname": a.nickname, "user_id": a.user_id,
                      "total": pts.get("total"), "wallets": pts.get("wallets"),
                      "expiring": pts.get("expiring"), "token_exp": exp}))
`;

const REGISTER_SNIPPET = PY_LOAD_A_SWITCH + `
import subprocess
m.subprocess=subprocess
r=m.zcode_register_provider()
# 模型目录以 a_switch 自己的 ZCODE_MODELS 为准（含逐路由实测的视觉矩阵）。
# 这里刻意不再做“统一修正”：历史上那段代码会把 a_switch 注册的模型删掉、
# 并把上下文长度与视觉声明改回旧值。并集、闸门与落盘统一在 JS 侧完成。
# 注意：zcode_register_provider() 内部固定写 ~/.zcode/v2/provider_config.json，
# ASWITCH_ZCODE_CFG 只能重定向控制台自己的写入——定点自测 zcode:register 会真实改动配置。
r["catalog"] = [{"modelId": d, "route": rt, "vision": bool(v), "contextWindow": c} for d, rt, v, c in m.ZCODE_MODELS]
print(json.dumps(r, ensure_ascii=False))
`;

const SYNC_SNIPPET = PY_LOAD_A_SWITCH + `
ok=m.write_single_credential()
print(json.dumps({"ok": bool(ok)}))
`;

function tailFile(file, n = 200) {
  try {
    const data = fs.readFileSync(file, "utf8");
    const lines = data.split("\n").filter(Boolean);
    return lines.slice(-n).join("\n");
  } catch { return "(日志文件不存在或为空)"; }
}

// ---------------------------------------------------------------- ZCode 配置写入
// 枚举校验、结构丢失断言、原子写/回滚、只读体检全部在 ./zcode-config.js 里实现
// （纯 Node 模块，可脱离 Electron 跑回归测试）。这里只做常量与薄封装。
const ZCODE_API_TYPES = ZC.ZCODE_API_TYPES;
const writeZcodeConfig = (next, prevRaw, opts) => ZC.writeZcodeConfig(ZCODE_CFG, next, prevRaw, opts);
const checkZcodeConfig = () => ZC.checkZcodeConfig(ZCODE_CFG);

/** 新注册的模型条目：默认文本输入输出，多模态模型额外声明图片输入。
 *  已存在的条目不会用这份默认值覆盖——见 zcode-config.js 的 OWNED_PROPERTY_KEYS。 */
function modelEntry(providerId, modelId, contextWindow, multimodal = false) {
  return { providerId, modelId, config: { enabled: true, properties: {
    contextWindow,
    inputFormat: { supportsText: true, supportsImage: !!multimodal, supportsVideo: false, supportsAudio: false, supportsPdf: false },
    outputFormat: { supportsText: true } } } };
}

const handlers = {};
function handle(channel, fn) { handlers[channel] = fn; ipcMain.handle(channel, (e, ...args) => fn(e, ...args)); }

function setupIpc() {
  handle("status:query", async () => {
    // 六条链路的健康探测 + WorkBuddy 账号查询彼此独立：并行跑，状态页的等待从「累加」变成「最慢的一条」
    const [health, wbH, traeH, doubaoH, comateH, qoderH, qwH, wbStatus] = await Promise.all([
      relayAlive() ? healthOnce().catch(() => ({ ok: false, running: false })) : Promise.resolve({ ok: false, running: false }),
      wbHealth().catch(() => ({ running: false, ok: false })),
      traeHealth().catch(() => ({ running: false, ok: false })),
      doubaoHealth().catch(() => ({ running: false, ok: false })),
      comateHealth().catch(() => ({ running: false, ok: false })),
      qoderHealth().catch(() => ({ running: false, ok: false })),
      qwenworkHealth().catch(() => ({ running: false, ok: false })),
      wbHttp("GET", "/status").catch(() => null),
    ]);
    const zcode = readZcodeRegistration();
    const token = readTokenExp();
    let credential = "缺失";
    try { credential = JSON.parse(fs.readFileSync(REQ_HEADERS, "utf8")).headers["X-Authorization"].slice(0, 16) + "…"; } catch {}
    let wbAccount = null;
    const wbAccs = (wbStatus && wbStatus.j && wbStatus.j.accounts) || [];
    if (wbAccs.length) wbAccount = { uid: wbAccs[0].uid, nickname: wbAccs[0].nickname, credits: wbAccs[0].credits };
    return {
      doubao: {
        running: doubaoH.running,
        ok: doubaoH.ok,
        models: (doubaoH.models || []).map((m) => (typeof m === "string" ? m : m.id)),
        cookies: doubaoH.cookies || null,
        conversation: doubaoH.conversation || "",
        mode: doubaoH.mode || "stateless",
        client: await doubaoClientDebug(),
      },
      trae: {
        running: traeH.running,
        ok: traeH.ok,
        models: traeH.models || [],
        credential: traeH.credential || null,
        mode: traeH.mode || "stateless",
      },
      comate: {
        running: comateH.running,
        ok: comateH.ok,
        credential: comateH.credential || null,
        mode: comateH.mode || "stateless",
        // relay 自报的工具体系：会话续跑（同 conversation+task 交付 toolUseResults）
        toolLoop: comateH.tool_loop || null,
        toolRoutingCached: comateH.tool_routing_cached || 0,
        // 上游取法：默认 /v2/execute（SSE 真流式），建不起来才降级 execute-sync
        upstream: comateH.upstream || null,
        streamFallbacks: comateH.stream_fallbacks || 0,
        modelsCached: comateH.models_cached || 0,
        models: comateH.running ? await comateModels().then((ms) => ms.map((m) => m.display_name || m.id)).catch(() => []) : [],
      },
      qoder: {
        running: qoderH.running,
        ok: qoderH.ok,
        accounts: qoderH.accounts || 0,
        ready: qoderH.ready || 0,
        realm: qoderH.realm || "",
        models: qoderH.running ? await qoderModels(8000).then((ms) => ms.map((m) => m.display_name || m.id)).catch(() => []) : [],
      },
      // 千问办公与 Qoder CN 共用 :8791 的网关进程，只是出口不同
      qwenwork: {
        running: qwH.running,
        ok: qwH.ok,
        accounts: qwH.accounts || 0,
        sharedPort: QODER_PORT,
        models: qwH.running ? await qwenworkModels(8000).then((ms) => ms.map((m) => m.display_name || m.id)).catch(() => []) : [],
      },
      workbuddy: {
        running: wbH.running,
        ok: wbH.ok,
        models: wbH.models || [],
        account: wbAccount,
        creditsCache: wbCreditsCache,
      },
      relay: {
        running: !!health.running || relayAlive(),
        ok: health.ok,
        status: health.status || "-",
        upstream: health.upstream || null,
        uptimeS: health.uptime_s || 0,
        models: health.aliases || [],
      },
      watcher: { running: watcherRunning() },
      zcode: { ...zcode, zcodeSync: lastZcodeSync },
      // Codex 只报三件事：前门在不在、注册了哪几条链路、当前指向谁（详细体检走 codex:status）
      codex: (() => {
        let providers = [], current = null;
        try { const p = CX.parseToml(fs.readFileSync(codexCfgPath(), "utf8")); providers = CX.ourTables(p); current = CX.topValue(p, "model_provider"); } catch {}
        return { frontRunning: (() => { try { return /LISTENING/.test(execSync(`netstat -ano | findstr :${CODEX_FRONT_PORT} | findstr LISTENING`, { shell: "cmd.exe", timeout: 8000 }).toString()); } catch { return false; } })(),
          providers, current, configPath: codexCfgPath() };
      })(),
      token,
      credential,
    };
  });

  handle("relay:start", async () => {
    const boot = ensureRelayServer();   // 先补齐运行时文件（server.mjs / persona.txt），relay 已在跑时也要补
    if (boot) return { ok: false, error: boot };
    if (relayAlive()) return { ok: true, already: true };
    const nd = findNode();
    const st = trySpawn(nd.cmd, [RELAY_SERVER], {
      cwd: RELAY_DIR, env: { ...RELAY_ENV, ...nd.env }, windowsHide: true, detached: true,
      stdio: ["ignore", fs.openSync(RELAY_LOG, "a"), fs.openSync(RELAY_LOG, "a")],
    });
    if (!st.proc) return { ok: false, error: `${st.error || "无法启动 Node 运行时"}（${nd.source}）` };
    relayProc = st.proc;
    relayProc.unref();  // 关闭控制台后 relay 继续作为后台服务存活
    relayProc.on("exit", (code) => { log("relay exited", code); relayProc = null; });
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (relayAlive()) { queueZcodeSync({ upsert: ["autoclaw"] }); return { ok: true }; }
    }
    return { ok: false, error: st.error || `10 秒内未就绪（运行时：${nd.source}），查看 relay.log` };
  });

  handle("relay:stop", async () => {
    try {
      const out = execSync("netstat -ano | findstr :18766 | findstr LISTENING", { shell: "cmd.exe", timeout: 8000 }).toString();
      const pid = out.trim().split(/\s+/).pop();
      if (pid) execSync(`taskkill /F /PID ${pid}`, { shell: "cmd.exe" });
      if (relayProc) { try { relayProc.kill(); } catch {} relayProc = null; }
      queueZcodeSync({ remove: ["autoclaw"] });
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  });

  handle("watcher:start", async () => {
    if (watchProc) return { ok: true, already: true };
    const st = spawnDetached(PYTHON, [path.join(BRIDGE_DIR, "watch_auth.py")], { cwd: BRIDGE_DIR });
    if (!st.proc) return { ok: false, error: `${st.error || "无法启动 python"}；凭证同步器依赖本机 Python` };
    watchProc = st.proc;
    watchProc.on("exit", (code) => { log("watcher exited", code); watchProc = null; });
    await new Promise((r) => setTimeout(r, 800));
    if (!watchProc) return { ok: false, error: st.error || "python 启动后立即退出（缺 cryptography？见同步器日志）" };
    return { ok: true };
  });

  handle("watcher:stop", async () => {
    if (watchProc) { try { watchProc.kill(); } catch {} watchProc = null; }
    try {
      const pid = Number(fs.readFileSync(path.join(RELAY_DIR, "watch_auth.pid"), "utf8").trim());
      if (pid) {
        // 防 Windows PID 复用误杀：确认该 PID 的进程名是 python 才杀
        try {
          const img = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { shell: "cmd.exe", timeout: 8000 }).toString();
          if (/python/i.test(img)) process.kill(pid);
        } catch {}
        fs.unlinkSync(path.join(RELAY_DIR, "watch_auth.pid"));
      }
    } catch {}
    return { ok: true };
  });

  /** AutoClaw 积分快照（points:refresh 与「余额总览」共用同一份解析口径） */
  async function pointsSnapshot() {
    const r = await pythonOneShot(POINTS_SNIPPET);
    if (!r.ok && r.error) return { ok: false, error: r.error };   // python 缺失/超时等：直接说原因，别退化成“解析失败”
    try {
      const line = (r.out || "").trim().split("\n").filter((l) => l.startsWith("{")).pop();
      return JSON.parse(line || "{}");
    } catch { return { ok: false, error: r.err || r.out || "解析失败" }; }
  }
  handle("points:refresh", pointsSnapshot);

  // ===================== 余额 / 额度总览 =====================
  // 七条链路的「还能用多少」来源不一：AutoClaw 走 A-SWITCH 的积分接口，WorkBuddy 走
  // wb2api /status，Qoder CN 与千问办公共用网关账号池的额度接口（要面板会话）。Comate
  // 上游只回 license 有效性、Trae 的 183 个远程端点里没有计费、豆包是网页接口——这三条
  // 没有额度接口，如实标注并把能拿到的登录态事实一并给出，不编造数字。
  async function qoderPanelToken() {
    const l = await qoderHttp("POST", "/panel/login", { password: QODER_PANEL_PASSWORD }, 10000);
    return l.j?.token || "";
  }

  /** 一个出口（cn / qworkcn）的账号池额度汇总。实时刷新失败时上游仍回缓存额度，
   *  所以有数字就照给，只把「这次实时刷新为什么失败」记进 error，别把缓存当实时。 */
  async function qoderRealmBalance(realm) {
    if (!qoderAlive()) return { ok: false, error: "网关未运行" };
    const token = await qoderPanelToken();
    if (!token) return { ok: false, error: "面板登录失败（默认密码 admin 被改过？在网关看板里改回）" };
    const r = await qoderHttp("POST", "/accounts/credits", { realm }, 60000, { "X-Panel-Token": token });
    const results = r.j?.results || [];
    if (!results.length) return { ok: false, error: r.j?.error?.message || `账号池里没有 ${realm} 账号（点「同步账号」）` };
    let remain = 0, size = 0, exceeded = false, updatedAt = 0, live = 0;
    const plans = new Set();
    let liveError = "";
    for (const x of results) {
      const c = x.credits || {};
      if (c.remain != null) remain += Number(c.remain) || 0;
      if (c.size != null) size += Number(c.size) || 0;
      if (c.exceeded) exceeded = true;
      if (c.updated_at) updatedAt = Math.max(updatedAt, Number(c.updated_at) || 0);
      if (x.plan) plans.add(x.plan);
      if (x.ok) live++; else if (x.error && !liveError) liveError = String(x.error).slice(0, 120);
    }
    return { ok: true, remain, size, accounts: results.length, live, exceeded, updatedAt, plans: [...plans], error: liveError };
  }

  handle("balance:all", async () => {
    const [ac, wb, qd, qw, cm, tr, db] = await Promise.all([
      pointsSnapshot().catch((e) => ({ ok: false, error: String((e && e.message) || e) })),
      (async () => {
        try {
          const st = await wbHttp("GET", "/status");
          const a = (st.j?.accounts || [])[0];
          return a ? { ok: true, credits: a.credits, nickname: a.nickname || a.uid } : { ok: false, error: "无账号（WorkBuddy 未登录？）" };
        } catch { return { ok: false, error: "网关未运行" }; }
      })(),
      qoderRealmBalance("cn").catch((e) => ({ ok: false, error: String((e && e.message) || e) })),
      qoderRealmBalance("qworkcn").catch((e) => ({ ok: false, error: String((e && e.message) || e) })),
      comateHealth().catch(() => ({ running: false, ok: false })),
      traeHealth().catch(() => ({ running: false, ok: false })),
      doubaoHealth().catch(() => ({ running: false, ok: false })),
    ]);
    const quotaRow = (id, label, q) => ({
      id, label, unit: "额度", available: q.ok === true, noApi: false,
      value: q.ok ? `${q.remain} / ${q.size}` : "",
      detail: q.ok
        ? `账号 ${q.accounts} 个（实时刷到 ${q.live}）｜套餐 ${q.plans.join("/") || "-"}｜额度更新于 ${q.updatedAt ? new Date(q.updatedAt * 1000).toLocaleString("zh-CN") : "-"}`
        : "",
      error: q.error || "",
    });
    return {
      ok: true, at: new Date().toISOString(),
      links: [
        { id: "autoclaw", label: "AutoClaw", unit: "分", available: ac.ok === true && ac.total != null, noApi: false,
          value: ac.total != null ? String(ac.total) : "",
          detail: ac.ok
            ? (ac.total != null
              ? `账号 ${ac.nickname || ac.user_id || "-"}${Array.isArray(ac.wallets) ? `｜钱包 ${ac.wallets.length} 个` : ""}`
              : `账号 ${ac.nickname || ac.user_id || "-"}｜上游没返回钱包（账号欠费或未开通）`)
            : "A-SWITCH 积分接口（走本机 Python）",
          error: ac.error || "" },
        { id: "workbuddy", label: "WorkBuddy", unit: "分", available: wb.ok === true && wb.credits != null, noApi: false,
          value: wb.credits != null ? String(wb.credits) : "",
          detail: wb.ok ? `账号 ${wb.nickname}` : "wb2api /status", error: wb.error || "" },
        quotaRow("qoder", "Qoder CN", qd),
        quotaRow("qwenwork", "千问办公", qw),
        { id: "comate", label: "Comate", unit: "", available: false, noApi: true, value: "",
          detail: `上游无额度接口｜登录态 ${cm.credential || "未知"}｜模型 ${cm.models_cached ?? "-"} 个`,
          error: cm.running ? "" : "网关未运行" },
        { id: "trae", label: "Trae", unit: "", available: false, noApi: true, value: "",
          detail: `上游无额度接口（183 个远程端点无计费）｜凭证 ${tr.credential?.ok ? "有效" : "失效"}${tr.credential?.expiresAt ? `（到期 ${String(tr.credential.expiresAt).slice(0, 10)}）` : ""}`,
          error: tr.running ? "" : "网关未运行" },
        { id: "doubao", label: "豆包工作", unit: "", available: false, noApi: true, value: "",
          detail: `上游无额度接口（网页接口）｜登录态 ${db.cookies?.ok ? `有效（${db.cookies.count} 条 cookie）` : "缺失"}`,
          error: db.running ? "" : "网关未运行" },
      ],
    };
  });

  // ===================== ZCode 动态增删（链路开→注册，链路关→注销） =====================
  // 约定：ZCode 里能看到哪个供应商 = 对应平台链路此刻开启。qoder 与 qwenwork 同网关同生死。
  // 同步一律串行（一条 promise 链），且永远走 writeZcodeConfig 的四道闸门——
  // 注销靠 removeProviders + removedProviderAllowPaths 白名单放行“有意删除”的结构路径。
  const PLATFORM_KEYS = ["autoclaw", "workbuddy", "trae", "doubao", "comate", "qoder"];
  const PLATFORM_PROVIDER_IDS = {
    autoclaw: [PROVIDER_ID], workbuddy: [WB_PROVIDER_ID], trae: [TRAE_PROVIDER_ID],
    doubao: [DOUBAO_PROVIDER_ID], comate: [COMATE_PROVIDER_ID],
    qoder: [QODER_PROVIDER_ID, QWENWORK_PROVIDER_ID],
  };
  const PLATFORM_ALIVE = {
    autoclaw: relayAlive, workbuddy: wbAlive, trae: traeAlive,
    doubao: doubaoAlive, comate: comateAlive, qoder: qoderAlive,
  };
  let lastZcodeSync = null;
  let zcodeSyncChain = Promise.resolve();

  /** 把一个平台的注册素材落进 cfg（纯内存操作，落盘交给 writeZcodeConfig） */
  function applyPlatformReg(cfg, reg) {
    const conf = cfg.config;
    const rules = conf.providerConfigRules.providerRules;
    const entries = conf.modelConfigRules.providerModelRules;
    if (reg.kind === "autoclaw") {
      // 目录以 a_switch.py 的 ZCODE_MODELS 为准（含逐路由实测的视觉矩阵）。
      // personalModelIds 与 python 注册器同语义：整体替换而非并集——并集会把改名前的
      // 旧 TitleCase 名永久残留（统一命名规范要求目录里只出现规范名）；
      // 模型条目仍然只增不删（upsertModelEntries 的既有行为），能力声明保留。
      const acIds = reg.catalog.map((x) => x.modelId);
      let acRule = rules.find((r) => r.providerId === PROVIDER_ID);
      if (!acRule) {
        acRule = { providerId: PROVIDER_ID, providerName: "AutoClaw", enabled: true,
          config: { group: "standard-personal", access: { type: "api-key", apiKey: linkApiKey("autoclaw") },
            api: { type: ZC.ZCODE_API.ANTHROPIC, baseUrl: "http://127.0.0.1:18766" },
            personalModelIds: [] } };
        rules.push(acRule);
      }
      // python 注册器每次都把自己的 providerRule 直写回配置（apiKey 硬编码 autoclaw-local，
      // 见 a_switch.py zcode_register_provider）——这里显式盖回当前口径：控制台生成过钥匙时，
      // 最终落盘的必须是新钥（python 直写在前、JS 单次落盘在后，后写生效）。
      acRule.config.access = { ...(acRule.config.access || {}), type: "api-key", apiKey: linkApiKey("autoclaw") };
      acRule.config.personalModelIds = [...new Set(acIds)];
      ZC.upsertModelEntries(entries, PROVIDER_ID,
        reg.catalog.map((x) => modelEntry(PROVIDER_ID, x.modelId, x.contextWindow || 500000, !!x.vision)));
      return { ok: true, models: acIds };
    }
    ZC.upsertProviderRule(rules, reg.rule);
    ZC.upsertModelEntries(entries, reg.rule.providerId, reg.entries);
    return { ok: true, models: reg.rule.config.personalModelIds, providerId: reg.rule.providerId };
  }

  /** AutoClaw 目录：python 加载 a_switch.py 取 ZCODE_MODELS（顺带由 python 幂等直写自己的 providerRule） */
  async function autoclawReg() {
    const r = await pythonOneShot(REGISTER_SNIPPET, {}, 120000);
    try {
      if (!r.ok && r.error) throw new Error(r.error);
      const line = (r.out || "").trim().split("\n").filter((l) => l.startsWith("{")).pop();
      const res = JSON.parse(line || "{}");
      const catalog = Array.isArray(res.catalog) ? res.catalog : [];
      if (!catalog.length) return { ok: false, error: "注册器未返回模型目录（a_switch.py 未被加载？），目录未刷新" };
      return { ok: true, kind: "autoclaw", providerIds: [PROVIDER_ID], catalog };
    } catch (e) {
      return { ok: false, error: r.err || (e && e.message) || r.out || "解析失败" };
    }
  }

  /**
   * 平台注册素材：目录取自各网关（网关没启动只影响自己，报 error 不抛异常）。
   * qoder 一次带回两条出口（qoder + qwenwork），目录为空的出口单独报错。
   */
  async function platformCatalogs(key) {
    const out = [];
    try {
      if (key === "autoclaw") {
        out.push(["autoclaw", await autoclawReg()]);
      } else if (key === "workbuddy") {
        const list = ((await wbHttp("GET", "/v1/models", null, 15000)).j?.data || []).map((x) => [x.id, 200000]);
        out.push(["workbuddy", list.length ? {
          ok: true,
          rule: { providerId: WB_PROVIDER_ID, providerName: "WorkBuddy", enabled: true,
            config: { group: "standard-personal", access: { type: "api-key", apiKey: linkApiKey("workbuddy") },
              api: { type: ZC.ZCODE_API.OPENAI_CHAT, baseUrl: `http://127.0.0.1:${WB_PORT}/v1` },
              personalModelIds: list.map((m) => m[0]) } },
          entries: list.map(([id, ctx]) => modelEntry(WB_PROVIDER_ID, id, ctx)),
        } : { ok: false, error: "WorkBuddy 网关未运行，模型目录未刷新（已注册条目保持不变）" }]);
      } else if (key === "trae") {
        const list = await traeModels();
        out.push(["trae", list.length ? {
          ok: true,
          rule: { providerId: TRAE_PROVIDER_ID, providerName: "Trae", enabled: true,
            config: { group: "standard-personal", access: { type: "api-key", apiKey: linkApiKey("trae") },
              api: { type: ZC.ZCODE_API.OPENAI_CHAT, baseUrl: `http://127.0.0.1:${TRAE_PORT}/v1` },
              personalModelIds: list.map((m) => m.id) } },
          // Trae 目录里 max 常为 0（如 glm-5.3 = {dev:200000,max:0}），真实可用值在 dev
          entries: list.map((m) => modelEntry(TRAE_PROVIDER_ID, m.id,
            m.trae?.context_window?.dev || m.trae?.context_window?.max || 184000, !!m.trae?.multimodal)),
        } : { ok: false, error: "Trae 网关未运行，模型目录未刷新（已注册条目保持不变）" }]);
      } else if (key === "doubao") {
        const list = await doubaoModels();
        const ids = list.map((m) => m.id);
        out.push(["doubao", ids.length ? {
          ok: true,
          rule: { providerId: DOUBAO_PROVIDER_ID, providerName: "豆包工作", enabled: true,
            config: { group: "standard-personal", access: { type: "api-key", apiKey: linkApiKey("doubao") },
              api: { type: ZC.ZCODE_API.OPENAI_CHAT, baseUrl: `http://127.0.0.1:${DOUBAO_PORT}/v1` },
              personalModelIds: ids } },
          entries: list.map((m) => modelEntry(DOUBAO_PROVIDER_ID, m.id, 16000)),
        } : { ok: false, error: "豆包工作网关未运行，模型目录未刷新（已注册条目保持不变）" }]);
      } else if (key === "comate") {
        const list = await comateModels();
        const ids = list.map((m) => m.id);
        out.push(["comate", ids.length ? {
          ok: true,
          rule: { providerId: COMATE_PROVIDER_ID, providerName: "Comate 文心快码", enabled: true,
            config: { group: "standard-personal", access: { type: "api-key", apiKey: linkApiKey("comate") },
              api: { type: ZC.ZCODE_API.OPENAI_CHAT, baseUrl: `http://127.0.0.1:${COMATE_PORT}/v1` },
              personalModelIds: ids } },
          entries: list.map((m) => modelEntry(COMATE_PROVIDER_ID, m.id, 200000)),
        } : { ok: false, error: "Comate 网关未运行，模型目录未刷新（已注册条目保持不变）" }]);
      } else if (key === "qoder") {
        // 两把出口 Key 由控制台生成并写进网关（见 qoderEnsureRealmKeys），明文只在 ~/.autoclaw-relay/
        await qoderEnsureRealmKeys();
        const q = await qoderModels();
        const qIds = q.map((m) => m.id);
        out.push(["qoder", qIds.length ? {
          ok: true,
          rule: { providerId: QODER_PROVIDER_ID, providerName: "Qoder CN", enabled: true,
            config: { group: "standard-personal", access: { type: "api-key", apiKey: qoderRealmKey("cn") || "qoder-local" },
              api: { type: ZC.ZCODE_API.OPENAI_CHAT, baseUrl: `http://127.0.0.1:${QODER_PORT}/v1` },
              personalModelIds: qIds } },
          entries: q.map((m) => modelEntry(QODER_PROVIDER_ID, m.id, m.max_input_tokens || 200000)),
        } : { ok: false, error: "Qoder 网关未运行或账号池为空，模型目录未刷新（已注册条目保持不变）" }]);
        const qw = await qwenworkModels();
        const qwIds = qw.map((m) => m.id);
        out.push(["qwenwork", qwIds.length ? {
          ok: true,
          rule: { providerId: QWENWORK_PROVIDER_ID, providerName: "千问办公", enabled: true,
            config: { group: "standard-personal", access: { type: "api-key", apiKey: qoderRealmKey("qworkcn") || "qwenwork-local" },
              api: { type: ZC.ZCODE_API.OPENAI_CHAT, baseUrl: `http://127.0.0.1:${QODER_PORT}/v1` },
              personalModelIds: qwIds } },
          entries: qw.map((m) => modelEntry(QWENWORK_PROVIDER_ID, m.id, m.max_input_tokens || 1000000)),
        } : { ok: false, error: "千问办公目录为空：网关未运行或 qworkcn 账号未同步（已注册条目保持不变）" }]);
      }
    } catch (e) {
      out.push([key, { ok: false, error: String((e && e.message) || e) }]);
    }
    return out;
  }

  /**
   * 一次同步：remove 平台先摘除（结构放行白名单按被摘者生成），upsert 平台拉目录后合并，
   * 最后单次落盘。有 errors 但没有任何实际变更时不写盘（错误原样带回）。
   */
  async function zcodeSyncOnce({ upsert = [], remove = [], reconcile = false } = {}) {
    if (reconcile) {
      upsert = []; remove = [];
      for (const key of PLATFORM_KEYS) (PLATFORM_ALIVE[key]?.() ? upsert : remove).push(key);
    }
    if (!fs.existsSync(ZCODE_CFG)) return { ok: false, error: `未找到 ZCode 配置（${ZCODE_CFG}）` };
    const summary = { ok: true, upserted: [], removed: [], errors: {} };
    const prevRaw = fs.readFileSync(ZCODE_CFG, "utf8");
    let cfg;
    try { cfg = JSON.parse(prevRaw); } catch (e) { return { ok: false, error: "ZCode 配置无法解析：" + e.message }; }
    let allowRemoved = [];
    if (remove.length) {
      const ids = [...new Set(remove.flatMap((k) => PLATFORM_PROVIDER_IDS[k] || []))];
      const n = ZC.removeProviders(cfg, ids);
      if (n) { summary.removed = ids; allowRemoved = ZC.removedProviderAllowPaths(ids); }
    }
    for (const key of upsert) {
      for (const [name, reg] of await platformCatalogs(key)) {
        if (!reg.ok) { summary.errors[name] = reg.error; continue; }
        const ar = applyPlatformReg(cfg, reg);
        if (ar.ok) summary.upserted.push(name); else summary.errors[name] = ar.error;
      }
    }
    if (!summary.removed.length && !summary.upserted.length) {
      if (Object.keys(summary.errors).length) summary.ok = false;
      summary.note = "目录无变化，未写盘";
      return summary;
    }
    summary.backup = path.basename(writeZcodeConfig(cfg, prevRaw, { allowRemovedPaths: allowRemoved }));
    return summary;
  }

  /** 同步队列：任意时刻只有一个同步在跑，后到的排队；结果记进 lastZcodeSync 供状态页展示 */
  function queueZcodeSync(plan) {
    const run = zcodeSyncChain.then(() => zcodeSyncOnce(plan)).then(
      (r) => { lastZcodeSync = { at: new Date().toISOString(), ...plan, result: r }; log("zcode sync:", JSON.stringify(lastZcodeSync)); },
      (e) => { lastZcodeSync = { at: new Date().toISOString(), ...plan, error: String((e && e.message) || e) }; log("zcode sync failed:", lastZcodeSync.error); },
    );
    zcodeSyncChain = run.catch(() => {});
    return run;
  }

  handle("zcode:sync", async () => {
    await queueZcodeSync({ reconcile: true });
    return lastZcodeSync || { ok: false, error: "同步未执行" };
  });

  handle("zcode:register", async () => {
    // 全新机器上 ZCode 还没跑过、配置不存在时，先给可执行的指引（python 的注册器同样以该文件为落点）
    if (!fs.existsSync(ZCODE_CFG)) {
      return { ok: false, error: `未找到 ZCode 供应商配置（${ZCODE_CFG}）。请先安装并运行一次 ZCode（它会创建该文件），再回来点注册` };
    }
    const r = await pythonOneShot(REGISTER_SNIPPET, {}, 120000);
    let res = {};
    try {
      if (!r.ok && r.error) throw new Error(r.error);   // python 缺失/超时：把原因原样带给用户
      const line = (r.out || "").trim().split("\n").filter((l) => l.startsWith("{")).pop();
      res = JSON.parse(line || "{}");
    } catch (e) { res = { ok: false, error: r.err || (e && e.message) || r.out || "解析失败" }; }
    // [all-in-one] 三个平台共用一次读取、一次校验、一次写入。
    // provider_config.json 归 ZCode 自己所有：只允许增量修改自己的供应商，
    // 任何“整体重建”的写法都会丢字段（2026-10-05 丢掉 manualProviderModelRules 的教训），
    // 任何“统一修正目录”的写法都会删掉别人注册的模型（同日删掉两个 DeepSeek 的教训）。
    // 结构路径里的数组元素身份是 `providerId/modelId`（见 zcode-config.js 的 elementId）；
    // 缺 modelId 的坏条目只有 `providerId`，两种形态都要放行，否则这类条目永远改不掉
    const CATALOG_ALLOW = [PROVIDER_ID, WB_PROVIDER_ID, TRAE_PROVIDER_ID, DOUBAO_PROVIDER_ID, COMATE_PROVIDER_ID, QODER_PROVIDER_ID, QWENWORK_PROVIDER_ID]
      .flatMap((p) => [`config.modelConfigRules.providerModelRules[${p}]`,
                       `config.modelConfigRules.providerModelRules[${p}/`]);   // 模型目录由各家实时目录重写
    // 各平台目录统一走 platformCatalogs（网关没启动只影响自己）；AutoClaw 仍由 python
    // 直取 ZCODE_MODELS（上面的 REGISTER_SNIPPET 已顺带幂等直写自己的 providerRule）。
    try {
      const prevRaw = fs.readFileSync(ZCODE_CFG, "utf8");
      const cfg = JSON.parse(prevRaw);
      const conf = cfg.config || {};

      // ① AutoClaw：目录以 a_switch.py 的 ZCODE_MODELS 为准（它带逐路由实测的视觉矩阵），
      //    这里只做并集与补条目，绝不删条目——曾因“统一修正成 4 个模型”把两个可用的
      //    DeepSeek 注册项删掉过。上下文长度按注册器的声明刷新，其余属性保留。
      const acCatalog = Array.isArray(res.catalog) ? res.catalog : [];
      if (acCatalog.length) {
        applyPlatformReg(cfg, { kind: "autoclaw", catalog: acCatalog });
        res.models = acCatalog.map((x) => x.modelId);
        res.autoclaw = { registered: true, models: res.models };
      } else {
        res.autoclaw = { error: "注册器未返回模型目录（a_switch.py 未被加载？），目录未刷新" };
      }

      // ②-⑦ WorkBuddy / Trae / 豆包 / Comate / Qoder CN + 千问办公：共用动态注册的素材构建器
      for (const key of ["workbuddy", "trae", "doubao", "comate", "qoder"]) {
        for (const [name, reg] of await platformCatalogs(key)) {
          if (!reg.ok) { res[name] = { error: reg.error }; continue; }
          const ar = applyPlatformReg(cfg, reg);
          res[name] = ar.ok ? { registered: true, models: ar.models } : { error: ar.error };
        }
      }
      const realmKeys = await qoderEnsureRealmKeys();
      res.realmKeys = realmKeys.ok ? { generated: realmKeys.generated, realms: realmKeys.realms }
        : { error: realmKeys.error };

      const order = conf.providerOrder || (conf.providerOrder = []);
      for (const p of [WB_PROVIDER_ID, TRAE_PROVIDER_ID, DOUBAO_PROVIDER_ID, COMATE_PROVIDER_ID, QODER_PROVIDER_ID, QWENWORK_PROVIDER_ID]) if (!order.includes(p)) order.push(p);

      // 单次落盘：枚举 + 结构丢失 + 原子写 + 读回校验，任一道不过就整体拒绝
      res.backup = path.basename(writeZcodeConfig(cfg, prevRaw, { allowRemovedPaths: CATALOG_ALLOW }));
    } catch (e) {
      res.registerError = String((e && e.message) || e);
      res.zcode = checkZcodeConfig();
    }
    return res;
  });

  // 只读体检：报告配置是否健康（供应商枚举、必需字段、模型条目数），不改文件
  handle("zcode:check", async () => {
    try { return checkZcodeConfig(); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  // 环境体检：新机器上先点这个——缺什么、影响哪块功能、怎么补，一眼看清（只读，不启动任何服务）
  handle("env:check", async () => {
    const items = [];
    const add = (name, ok, detail, hint) => items.push({ name, ok: !!ok, detail: detail || "", hint: hint || "" });
    const rel = (p) => String(p).replace(HOME, "~");
    const nd = findNode();
    add("Node 运行时", !!nd, nd ? nd.source : "未找到", "relay 与 Trae 网关由它启动；exe 版自带兜底运行时（PATH → AutoClaw 自带 → 控制台自身），缺了才会报错");
    const py = await probeCmd(PYTHON, ["--version"]);
    add("Python", py.ok, py.ok ? py.out : py.error, "一键注册 / 余额查询 / 凭证同步依赖它（加载 a_switch.py，见下一项）");
    if (py.ok) {
      // 同步器要解密 2.x 登录态，没这个包 spawn 能成功但进程会立刻崩，症状是「同步器点了没反应」
      const cr = await probeCmd(PYTHON, ["-c", "import cryptography;print('cryptography',cryptography.__version__)"]);
      add("Python 包 cryptography", cr.ok, cr.ok ? cr.out : cr.error, "凭证同步器用它解密 AutoClaw 2.x 登录态：pip install cryptography");
    }
    const file = (name, p, hint) => add(name, fs.existsSync(p), rel(p), hint);
    file("relay 源码", RELAY_SRC, "随控制台分发（bridge/）；缺失说明安装包不完整，重装一次即可");
    file("relay 运行时", RELAY_SERVER, "点「启动」会自动从 bridge/server_2x.mjs 部署，无需手工准备");
    file("relay persona", RELAY_PERSONA, "2.x 闸门要求 system 与应用 persona 一致；点「启动」自动从已安装客户端提取（厂商文本不入库），提取失败会退回随包种子；缺了会全部 406");
    file("WorkBuddy 网关", WB_EXE, "上游 Go 二进制，随包分发；开发态在 workbuddy/…/upstream/");
    file("WorkBuddy 配置", WB_CONFIG, "打包版点「启动」自动播种；登录用 wb2api-login.exe");
    file("Trae 网关", TRAE_RELAY, "项目自带（trae/relay.mjs）");
    file("Trae 登录态", TRAE_STORAGE, "需安装并登录 Trae SOLO CN 客户端；relay 离线解密它，无需重开 IDE");
    file("豆包工作网关", DOUBAO_RELAY, "项目自带（doubao/relay.mjs）");
    file("豆包登录态", DOUBAO_COOKIES, "需安装并登录豆包工作客户端；点「同步登录态」从客户端抓 cookie（客户端需带调试端口，控制台可代重启）");
    file("豆包工作客户端", findDoubaoExe(), "默认装在 D:\\DoubaoWork，装好后登录一次即可");
    file("Comate 网关", COMATE_RELAY, "项目自带（comate/relay.mjs）");
    file("Comate 登录态", COMATE_SETTINGS, "需安装并登录 Comate IDE（文心快码）；relay 从 settings.json 读 license，重新登录后无需重启");
    file("Qoder 网关", QODER_PROXY, "项目自带（qoder/qoder_proxy.py，社区 COSY 网关，需 Python）");
    file("Qoder 登录态", path.join(process.env.APPDATA || "", "com.qodercn.app.stable", "auth.v1.dat"), "需安装并登录 Qoder CN 客户端；点「同步账号」把本机凭证导入网关账号池");
    file("千问办公登录态", path.join(process.env.APPDATA || "", "QwenWorkCN", "auth-v2.dat"), "需安装并登录千问办公客户端（QwenWorkCN）；与 Qoder 共用同一个网关，点「同步账号」一次导入两条出口");
    file("AutoClaw 凭证", REQ_HEADERS, "需安装并登录 AutoClaw 桌面客户端；同步器把登录态搬成反代凭证");
    file("ZCode 配置", ZCODE_CFG, "需先安装并运行过一次 ZCode，注册才有落点");
    // Codex：CLI 决定能不能用（配置由我们写，缺失不算错——首次注册会创建并在同目录留备份）
    const cxVer = codexVersion();
    add("Codex CLI", !!cxVer, cxVer || "未找到", "想接 Codex 才需要它（npm i -g @openai/codex）；注册写的 config.toml 由它读取");
    add("Codex 配置", true, `${String(codexCfgPath()).replace(HOME, "~")}（${fs.existsSync(codexCfgPath()) ? `已注册 ${(() => { try { return CX.ourTables(CX.parseToml(fs.readFileSync(codexCfgPath(), "utf8"))).length; } catch { return 0; } })()} 条 A-SWITCH 链路` : "尚无，首次注册自动创建"}）`,
      "只写自己的托管区（[model_providers.aswitch-*] + 顶层指针键），别人的表与注释一个字节不动");
    file("A-SWITCH 后端", A_SWITCH_PY, "一键注册 / 余额查询 / 凭证同步加载它（a_switch.py）；随本仓库分发，打包态在 resources/autoclaw-switch/");
    return { ok: items.every((i) => i.ok), items };
  });

  // 一键启动：按依赖顺序拉起三家网关与凭证同步器；某个平台缺前置只影响它自己，不阻塞其它
  handle("all:start", async () => {
    const steps = [];
    const run = async (name, ch) => {
      let r = null;
      try { r = await handlers[ch]({}); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
      const ok = !!(r && r.ok);
      steps.push({ name, ok, detail: ok ? (r.already ? "已在运行" : "已启动") : (r && r.error) || "失败" });
    };
    await run("AutoClaw relay", "relay:start");
    await run("WorkBuddy 网关", "workbuddy:start");
    await run("Trae 网关", "trae:start");
    await run("豆包工作网关", "doubao:start");
    await run("Comate 网关", "comate:start");
    await run("Qoder 网关", "qoder:start");
    await run("Codex 前门", "codex:front-start");   // 只绑 127.0.0.1 的翻译层，给 Codex 用（不接也没人打它）
    await run("凭证同步器", "watcher:start");
    return { ok: steps.every((s) => s.ok), steps };
  });

  handle("credential:sync", async () => {
    const r = await pythonOneShot(SYNC_SNIPPET, {}, 120000);
    if (!r.ok && r.error) return { ok: false, error: r.error };
    try {
      const line = (r.out || "").trim().split("\n").filter((l) => l.startsWith("{")).pop();
      return JSON.parse(line || "{}");
    } catch { return { ok: false, error: r.err || r.out || "解析失败" }; }
  });

  handle("smoke:test", async () => {
    return new Promise((resolve) => {
      const body = JSON.stringify({ model: "GLM-5.3-Flash", max_tokens: 64, stream: false,
        messages: [{ role: "user", content: "请只回复OK" }] });
      const req = http.request({
        host: "127.0.0.1", port: 18766, path: "/v1/messages", method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "autoclaw-local", "anthropic-version": "2023-06-01",
                   "content-length": Buffer.byteLength(body) },
        timeout: 180000,
      }, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          let reply = "", stop = "";
          try {
            const j = JSON.parse(d);
            reply = (j.content || []).map((b) => b.text || (b.thinking ? "[thinking]" : "")).join("").slice(0, 120);
            stop = j.stop_reason || "";
          } catch { reply = d.slice(0, 120); }
          resolve({ ok: res.statusCode === 200, status: res.statusCode, reply, stop });
        });
      });
      req.on("error", (e) => resolve({ ok: false, status: 0, reply: e.message }));
      req.write(body); req.end();
    });
  });

  handle("workbuddy:start", async () => {
    if (wbAlive()) return { ok: true, already: true };
    const seed = ensureWbWorkDir();
    if (seed) return { ok: false, error: seed };
    if (!fs.existsSync(WB_EXE)) return { ok: false, error: `未找到 wb2api.exe（${WB_EXE}）；该网关是上游 Go 二进制，需随包分发或按 workbuddy/…/UPSTREAM-SRC.txt 自行编译` };
    if (!fs.existsSync(WB_CONFIG)) return { ok: false, error: `未找到 config.json（${WB_CONFIG}）；开发版先用 wb2api-login.exe 登录一次生成` };
    const st = trySpawn(WB_EXE, ["-config", WB_CONFIG], {
      cwd: WB_WORK_DIR, windowsHide: true, detached: true,
      stdio: ["ignore", fs.openSync(WB_LOG, "a"), fs.openSync(WB_LOG, "a")],
    });
    if (!st.proc) return { ok: false, error: st.error || "无法启动 wb2api.exe" };
    wbProc = st.proc;
    wbProc.unref();
    wbProc.on("exit", (code) => { log("workbuddy gateway exited", code); wbProc = null; });
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (wbAlive()) { queueZcodeSync({ upsert: ["workbuddy"] }); return { ok: true }; }
    }
    return { ok: false, error: st.error || "10 秒内未就绪，查看 server.log" };
  });

  handle("workbuddy:stop", async () => {
    try {
      const out = execSync(`netstat -ano | findstr :${WB_PORT} | findstr LISTENING`, { shell: "cmd.exe", timeout: 8000 }).toString();
      const pid = out.trim().split(/\s+/).pop();
      if (pid) execSync(`taskkill /F /PID ${pid}`, { shell: "cmd.exe" });
      if (wbProc) { try { wbProc.kill(); } catch {} wbProc = null; }
      queueZcodeSync({ remove: ["workbuddy"] });
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  });

  handle("workbuddy:smoke", async () => {
    const r = await wbHttp("POST", "/v1/chat/completions", {
      model: "glm-5.3", max_tokens: 64,
      messages: [{ role: "user", content: "请只回复OK" }],
    }, 180000);
    let reply = "", stop = "";
    try {
      const j = r.j;
      const msg = j.choices?.[0]?.message || {};
      reply = (msg.content || (msg.reasoning_content ? "[thinking] " + msg.reasoning_content : "")).slice(0, 120);
      stop = j.choices?.[0]?.finish_reason || "";
    } catch { reply = r.raw || ""; }
    // 推理模型可能只输出 reasoning（content 为空但结构合法）：以 200 + choices 判定
    return { ok: r.ok && Array.isArray(r.j?.choices) && r.j.choices.length > 0, status: r.status, reply, stop };
  });

  handle("workbuddy:credits", async () => {
    const st = await wbHttp("GET", "/status");
    const accs = st.j?.accounts || [];
    if (!accs.length) return { ok: false, error: "无账号" };
    wbCreditsCache = accs[0].credits;
    return { ok: true, credits: accs[0].credits, nickname: accs[0].nickname };
  });

  // --- 豆包工作：relay 在项目目录内（doubao/relay.mjs），登录态用 doubao/cdp.js 从客户端抓快照 ---
  handle("doubao:start", async () => {
    if (doubaoAlive()) return { ok: true, already: true };
    if (!fs.existsSync(DOUBAO_RELAY)) return { ok: false, error: `未找到 doubao/relay.mjs（${DOUBAO_RELAY}）` };
    fs.mkdirSync(path.dirname(DOUBAO_LOG), { recursive: true });
    const nd = findNode();
    const st = trySpawn(nd.cmd, [DOUBAO_RELAY], {
      cwd: path.dirname(DOUBAO_RELAY), env: { ...process.env, ...nd.env }, windowsHide: true, detached: true,
      stdio: ["ignore", fs.openSync(DOUBAO_LOG, "a"), fs.openSync(DOUBAO_LOG, "a")],
    });
    if (!st.proc) return { ok: false, error: `${st.error || "无法启动 Node 运行时"}（${nd.source}）` };
    doubaoProc = st.proc;
    doubaoProc.unref();
    doubaoProc.on("exit", (code) => { log("doubao relay exited", code); doubaoProc = null; });
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (doubaoAlive()) {
        const h = await doubaoHealth();
        // 网关起来了但 cookie 过期/缺失：不算启动成功，把原因带出去让用户点「同步登录态」
        if (h.cookies && h.cookies.ok === false) {
          queueZcodeSync({ upsert: ["doubao"] });
          return { ok: true, warn: `网关已启动，但豆包登录态不可用（${h.cookies.error || "缺少 " + (h.cookies.missing || []).join(",")}）` };
        }
        queueZcodeSync({ upsert: ["doubao"] });
        return { ok: true };
      }
    }
    return { ok: false, error: st.error || `10 秒内未就绪（运行时：${nd.source}），查看 ~/.doubao-relay/relay.log` };
  });

  handle("doubao:stop", async () => {
    try {
      const out = execSync(`netstat -ano | findstr :${DOUBAO_PORT} | findstr LISTENING`, { shell: "cmd.exe", timeout: 8000 }).toString();
      const pid = out.trim().split(/\s+/).pop();
      if (pid) execSync(`taskkill /F /PID ${pid}`, { shell: "cmd.exe" });
      if (doubaoProc) { try { doubaoProc.kill(); } catch {} doubaoProc = null; }
      queueZcodeSync({ remove: ["doubao"] });
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  });

  // 登录态同步：客户端必须带 --remote-debugging-port=9222 启动（控制台可代为重启客户端）
  handle("doubao:sync-cookies", async (_e, opts) => {
    const wantRestart = !!(opts && opts.restart);
    const dbg = await doubaoClientDebug();
    if (!dbg.ok) {
      if (!wantRestart) {
        return { ok: false, error: "豆包工作客户端没有开启调试端口。点「重启客户端并同步」由控制台代劳，或手动加 --remote-debugging-port=9222 后重试" };
      }
      const exe = findDoubaoExe();
      if (!exe) return { ok: false, error: "未找到 DoubaoWork.exe（默认安装目录 D:\\DoubaoWork），无法代重启" };
      try { execSync('taskkill /IM DoubaoWork.exe /F', { shell: "cmd.exe", timeout: 15000 }); } catch {}
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const st = trySpawn(exe, ["--remote-debugging-port=" + DOUBAO_CDP_PORT], { cwd: path.dirname(exe), detached: true, stdio: "ignore", windowsHide: false });
        if (st.proc) st.proc.unref();
      } catch (e) { return { ok: false, error: "重启客户端失败：" + String((e && e.message) || e) }; }
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const d = await doubaoClientDebug();
        if (d.ok) break;
      }
      const d2 = await doubaoClientDebug();
      if (!d2.ok) return { ok: false, error: "客户端已重启但调试端口未就绪（可能需要重新登录）" };
    }
    if (!fs.existsSync(DOUBAO_CDP)) return { ok: false, error: `未找到 doubao/cdp.js（${DOUBAO_CDP}）` };
    const nd = findNode();
    const r = await probeCmd(nd.cmd, [DOUBAO_CDP, "cookies"], 60000);
    if (!fs.existsSync(DOUBAO_COOKIES)) return { ok: false, error: "抓取失败：" + (r.out || r.error || "未生成 cookie 快照").slice(-200) };
    await doubaoHttp("POST", "/admin/reload-cookies", {}, 8000);   // 网关在线则立即热加载
    const h = await doubaoHealth();
    return { ok: true, cookies: h.cookies || null };
  });

  handle("doubao:smoke", async () => {
    const model = (await doubaoModels())[0]?.id || "doubao";
    const r = await doubaoHttp("POST", "/v1/chat/completions", {
      model, max_tokens: 64, messages: [{ role: "user", content: "请只回复OK" }],
    }, 120000);
    let reply = "", stop = "";
    try {
      const j = r.j;
      const msg = j.choices?.[0]?.message || {};
      reply = (msg.content || "").slice(0, 120);
      stop = j.choices?.[0]?.finish_reason || "";
    } catch { reply = r.raw || ""; }
    return { ok: r.ok && Array.isArray(r.j?.choices) && r.j.choices.length > 0, status: r.status, reply, stop, model };
  });

  // --- Trae：relay 在项目目录内（trae/relay.mjs），凭证由 relay 自行从 Trae 客户端解密读取 ---
  handle("trae:start", async () => {
    if (traeAlive()) return { ok: true, already: true };
    if (!fs.existsSync(TRAE_RELAY)) return { ok: false, error: `未找到 trae/relay.mjs（${TRAE_RELAY}）` };
    fs.mkdirSync(path.dirname(TRAE_LOG), { recursive: true });
    const nd = findNode();
    const st = trySpawn(nd.cmd, [TRAE_RELAY], {
      cwd: path.dirname(TRAE_RELAY), env: { ...process.env, ...nd.env }, windowsHide: true, detached: true,
      stdio: ["ignore", fs.openSync(TRAE_LOG, "a"), fs.openSync(TRAE_LOG, "a")],
    });
    if (!st.proc) return { ok: false, error: `${st.error || "无法启动 Node 运行时"}（${nd.source}）` };
    traeProc = st.proc;
    traeProc.unref();
    traeProc.on("exit", (code) => { log("trae relay exited", code); traeProc = null; });
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (traeAlive()) { queueZcodeSync({ upsert: ["trae"] }); return { ok: true }; }
    }
    return { ok: false, error: st.error || `10 秒内未就绪（运行时：${nd.source}），查看 trae/relay.log` };
  });

  handle("trae:stop", async () => {
    try {
      const out = execSync(`netstat -ano | findstr :${TRAE_PORT} | findstr LISTENING`, { shell: "cmd.exe", timeout: 8000 }).toString();
      const pid = out.trim().split(/\s+/).pop();
      if (pid) execSync(`taskkill /F /PID ${pid}`, { shell: "cmd.exe" });
      if (traeProc) { try { traeProc.kill(); } catch {} traeProc = null; }
      queueZcodeSync({ remove: ["trae"] });
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  });

  handle("trae:smoke", async () => {
    // Trae 每次提问都要在远端拉起沙箱会话，首字延迟通常 5-30 秒，这里给足超时
    const model = (await traeModels())[0]?.id || "Doubao-Seed-Code";
    const r = await traeHttp("POST", "/v1/chat/completions", {
      model, max_tokens: 64,
      messages: [{ role: "user", content: "请只回复OK" }],
    }, 240000);
    let reply = "", stop = "";
    try {
      const j = r.j;
      const msg = j.choices?.[0]?.message || {};
      reply = (msg.content || (msg.reasoning_content ? "[thinking] " + msg.reasoning_content : "")).slice(0, 120);
      stop = j.choices?.[0]?.finish_reason || "";
    } catch { reply = r.raw || ""; }
    return { ok: r.ok && Array.isArray(r.j?.choices) && r.j.choices.length > 0, status: r.status, reply, stop, model };
  });

  // --- Comate（文心快码）：relay 在项目目录内（comate/relay.mjs），凭证由 relay 自行读取 Comate IDE settings.json ---
  handle("comate:start", async () => {
    if (comateAlive()) return { ok: true, already: true };
    if (!fs.existsSync(COMATE_RELAY)) return { ok: false, error: `未找到 comate/relay.mjs（${COMATE_RELAY}）` };
    fs.mkdirSync(path.dirname(COMATE_LOG), { recursive: true });
    const nd = findNode();
    const st = trySpawn(nd.cmd, [COMATE_RELAY], {
      cwd: path.dirname(COMATE_RELAY), env: { ...process.env, ...nd.env }, windowsHide: true, detached: true,
      stdio: ["ignore", fs.openSync(COMATE_LOG, "a"), fs.openSync(COMATE_LOG, "a")],
    });
    if (!st.proc) return { ok: false, error: `${st.error || "无法启动 Node 运行时"}（${nd.source}）` };
    comateProc = st.proc;
    comateProc.unref();
    comateProc.on("exit", (code) => { log("comate relay exited", code); comateProc = null; });
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (comateAlive()) {
        const h = await comateHealth();
        if (!h.ok) { queueZcodeSync({ upsert: ["comate"] }); return { ok: true, warn: `网关已启动，但 Comate 登录态不可用（${h.credential || "settings.json 缺 license"}）；安装并登录 Comate IDE 后即可用` }; }
        queueZcodeSync({ upsert: ["comate"] });
        return { ok: true };
      }
    }
    return { ok: false, error: st.error || `10 秒内未就绪（运行时：${nd.source}），查看 ~/.comate-relay/relay.log` };
  });

  handle("comate:stop", async () => {
    try {
      const out = execSync(`netstat -ano | findstr :${COMATE_PORT} | findstr LISTENING`, { shell: "cmd.exe", timeout: 8000 }).toString();
      const pid = out.trim().split(/\s+/).pop();
      if (pid) execSync(`taskkill /F /PID ${pid}`, { shell: "cmd.exe" });
      if (comateProc) { try { comateProc.kill(); } catch {} comateProc = null; }
      queueZcodeSync({ remove: ["comate"] });
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  });

  handle("comate:smoke", async () => {
    // Comate 走云端 agent 三步链（conversation→task→execute-sync），首字延迟 8-40 秒
    const model = (await comateModels())[0]?.id || "auto";
    const r = await comateHttp("POST", "/v1/chat/completions", {
      model, max_tokens: 64,
      messages: [{ role: "user", content: "请只回复OK" }],
    }, 240000);
    let reply = "", stop = "";
    try {
      const j = r.j;
      const msg = j.choices?.[0]?.message || {};
      reply = (msg.content || "").slice(0, 120);
      stop = j.choices?.[0]?.finish_reason || "";
    } catch { reply = r.raw || ""; }
    return { ok: r.ok && Array.isArray(r.j?.choices) && r.j.choices.length > 0, status: r.status, reply, stop, model };
  });

  // --- Qoder CN（vendored 社区网关；Python 长驻进程，双区+千问办公账号池）---
  handle("qoder:start", async () => {
    if (qoderAlive()) return { ok: true, already: true };
    if (!fs.existsSync(QODER_PROXY)) return { ok: false, error: `未找到 qoder/qoder_proxy.py（${QODER_PROXY}）` };
    fs.mkdirSync(path.dirname(QODER_LOG), { recursive: true });
    const st = trySpawn(PYTHON, [QODER_PROXY, "--port", String(QODER_PORT),
      // 账号池落用户目录（打包版资源目录只读，且凭证绝不随安装包分发）
      "--accounts-dir", path.join(HOME, ".qoder-relay", "accounts")], {
      cwd: path.dirname(QODER_PROXY), env: { ...process.env }, windowsHide: true, detached: true,
      stdio: ["ignore", fs.openSync(QODER_LOG, "a"), fs.openSync(QODER_LOG, "a")],
    });
    if (!st.proc) return { ok: false, error: `${st.error || "无法启动 Python 运行时"}（需要 Python 3.9+ 在 PATH 中）` };
    qoderProc = st.proc;
    qoderProc.unref();
    qoderProc.on("exit", (code) => { log("qoder gateway exited", code); qoderProc = null; });
    for (let i = 0; i < 24; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (qoderAlive()) {
        const h = await qoderHealth();
        if (!h.ok) { queueZcodeSync({ upsert: ["qoder"] }); return { ok: true, warn: `网关已启动，但账号池为空：点「同步账号」导入本机已登录的 Qoder/千问办公凭证` }; }
        queueZcodeSync({ upsert: ["qoder"] });
        return { ok: true };
      }
    }
    return { ok: false, error: st.error || "12 秒内未就绪，查看 ~/.qoder-relay/gateway.log" };
  });

  handle("qoder:stop", async () => {
    try {
      const out = execSync(`netstat -ano | findstr :${QODER_PORT} | findstr LISTENING`, { shell: "cmd.exe", timeout: 8000 }).toString();
      const pid = out.trim().split(/\s+/).pop();
      if (pid) execSync(`taskkill /F /PID ${pid}`, { shell: "cmd.exe" });
      if (qoderProc) { try { qoderProc.kill(); } catch {} qoderProc = null; }
      queueZcodeSync({ remove: ["qoder"] });
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  });

  handle("qoder:smoke", async () => {
    // 只用 enabled 的模型（Free 账号多数模型要付费，403 是终态；冒烟选第一个可用项）
    const models = (await qoderModels()).map((m) => m.id);
    if (!models.length) return { ok: false, error: "模型目录为空（网关账号池为空或未同步？）" };
    const model = models.includes("qwen3.8-flash") ? "qwen3.8-flash" : models[0];
    const cnKey = qoderRealmKey("cn") || "qoder-local";
    const r = await qoderHttp("POST", "/v1/chat/completions", {
      model, max_tokens: 64,
      messages: [{ role: "user", content: "请只回复OK" }],
    }, 240000, { Authorization: `Bearer ${cnKey}` });
    let reply = "", stop = "";
    try {
      const j = r.j;
      const msg = j.choices?.[0]?.message || {};
      reply = (msg.content || "").slice(0, 120);
      stop = j.choices?.[0]?.finish_reason || "";
    } catch { reply = r.raw || ""; }
    return { ok: r.ok && Array.isArray(r.j?.choices) && r.j.choices.length > 0, status: r.status, reply, stop, model, available: models };
  });

  handle("qoder:sync-accounts", async () => qoderSyncAccounts());

  handle("qwenwork:smoke", async () => {
    const models = (await qwenworkModels()).map((m) => m.id);
    if (!models.length) return { ok: false, error: "千问办公模型目录为空（账号池里没有 qworkcn 账号？点「同步账号」）" };
    const model = models.includes("qwen3.8-flash") ? "qwen3.8-flash" : models[0];
    const key = qoderRealmKey("qworkcn");
    const hdr = key ? { Authorization: `Bearer ${key}` } : { "X-Realm": "qworkcn" };
    const r = await qoderHttp("POST", "/v1/chat/completions", {
      model, max_tokens: 64,
      messages: [{ role: "user", content: "请只回复OK" }],
    }, 240000, hdr);
    let reply = "", stop = "";
    try {
      const msg = r.j.choices?.[0]?.message || {};
      reply = (msg.content || "").slice(0, 120);
      stop = r.j.choices?.[0]?.finish_reason || "";
    } catch { reply = r.raw || ""; }
    return { ok: r.ok && Array.isArray(r.j?.choices) && r.j.choices.length > 0, status: r.status, reply, stop, model, available: models };
  });

  // ===================== Codex 接入（前门翻译 + config.toml 托管区） =====================
  // 全景与取证见 .research/cc-switch-codex-analysis.md。要点：
  //   - Codex 0.100+ 的 wire_api 只认 "responses"：WorkBuddy/Trae/豆包 由 codex_front 翻译，
  //     Comate/AutoClaw/Qoder/千问办公 的 relay 自带 /v1/responses，Codex 直连（不经过前门）。
  //   - 凭据放 provider 表的 experimental_bearer_token，不碰 ~/.codex/auth.json
  //     （那是官方登录的地盘，动它等于把官方登录打给第三方）。
  //   - 只动托管区：我们的 [model_providers.aswitch-*] 表 + 4 个顶层指针键；
  //     别人的表 / 注释 / [projects.*] / 换行风格一个字节不动（闸门与备份回滚在 codex-config.js）。
  //   - 自定义 model_catalog_json 是**整体替换**自带目录，所以生成时必须克隆自带条目。

  const CODEX_ALIVE = {
    autoclaw: relayAlive, workbuddy: wbAlive, trae: traeAlive, doubao: doubaoAlive,
    comate: comateAlive, qoder: qoderAlive, qwenwork: qoderAlive,   // 千问办公与 Qoder 同网关
  };

  /** 前门健康（/health 带链路表；端口不通即未运行） */
  async function codexFrontHealth() {
    return new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${CODEX_FRONT_PORT}/health`, { timeout: 4000 }, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => { try { resolve({ running: true, ...JSON.parse(d) }); } catch { resolve({ running: true, ok: false }); } });
      });
      req.on("error", () => resolve({ running: false, ok: false }));
      req.on("timeout", () => { req.destroy(); resolve({ running: false, ok: false }); });
    });
  }

  // --- codex CLI 的定位与调用：Windows 上 npm 装的是 .cmd 垫片，直接 spawn 会 ENOENT，
  //     一律借 cmd.exe 跑（参数全是我们写死的常量，没有用户输入拼进去）---
  let codexCliCache = null;
  function codexCli() {
    if (codexCliCache) return codexCliCache;
    const appdata = process.env.APPDATA || path.join(HOME, "AppData", "Roaming");
    const cands = [process.env.CODEX_BIN, path.join(appdata, "npm", "codex.cmd"), path.join(appdata, "npm", "codex")].filter(Boolean);
    for (const c of cands) if (fs.existsSync(c)) { codexCliCache = c; return c; }
    try {
      const w = execSync("where codex", { shell: "cmd.exe", timeout: 8000 }).toString().trim().split(/\r?\n/)[0];
      if (w && fs.existsSync(w)) { codexCliCache = w; return w; }
    } catch {}
    codexCliCache = "codex";   // 交给调用方报 ENOENT（"未找到 Codex CLI"）
    return codexCliCache;
  }
  function codexRun(args, timeoutMs = 30000) {
    const r = spawnSync(`"${codexCli()}" ${args.join(" ")}`, {
      encoding: "utf8", shell: true, windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: r.status === 0 && !r.error, out: r.stdout || "", err: `${r.stderr || ""}${r.error ? r.error.message : ""}`.trim(), status: r.status };
  }
  const codexVersion = () => { const r = codexRun(["--version"], 15000); return r.ok ? r.out.trim() : ""; };

  /** 自带模型目录（离线，不需要登录）。自定义目录整体替换自带目录 → 必须克隆它们 */
  let codexBundledCache = null;
  function codexBundled(refresh = false) {
    if (codexBundledCache && !refresh) return codexBundledCache;
    const r = codexRun(["debug", "models", "--bundled"], 60000);
    const out = { ok: false, models: [], error: "" };
    try {
      out.models = JSON.parse(r.out).models || [];
      out.ok = out.models.length > 0;
    } catch (e) { out.error = r.err || `输出不是 JSON（退出码 ${r.status}）`; }
    codexBundledCache = out;
    return out;
  }

  /** 统一命名目录（models-catalog.json）里各平台的模型声明：窗口 / 视觉 */
  function unifiedModels(linkId) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(RES_ROOT, "models-catalog.json"), "utf8"));
      return j.platforms?.[linkId]?.models || [];
    } catch { return []; }
  }

  /**
   * 一条链路的 Codex 目录条目：**只读**各网关的模型目录（带钥），窗口/视觉尽量取统一命名的声明。
   * 与 ZCode 注册流程（platformCatalogs）的区别：这里绝不触发 a_switch.py 的写配置副作用。
   */
  async function codexModelList(linkId) {
    const meta = new Map(unifiedModels(linkId).map((m) => [m.id, m]));
    let ids = [];
    try {
      if (linkId === "autoclaw") ids = (await healthOnce(4000)).aliases || [];
      else if (linkId === "workbuddy") ids = ((await wbHttp("GET", "/v1/models", null, 15000)).j?.data || []).map((m) => m.id || m);
      else if (linkId === "trae") ids = (await traeModels()).map((m) => m.id);
      else if (linkId === "doubao") ids = (await doubaoModels()).map((m) => m.id);
      else if (linkId === "comate") ids = (await comateModels()).map((m) => m.id);
      else if (linkId === "qoder") ids = (await qoderModels(15000)).map((m) => m.id);
      else if (linkId === "qwenwork") ids = (await qwenworkModels(15000)).map((m) => m.id);
    } catch {}
    return [...new Set(ids.filter((x) => typeof x === "string" && x.trim()))].map((id) => {
      const m = meta.get(id) || {};
      return { slug: id, displayName: m.display || id, contextWindow: m.contextWindow || 200000, vision: !!m.vision };
    });
  }

  /** 前门进程（只绑 127.0.0.1；链路表 = CODEX_LINKS 里 via="front" 的三条） */
  handle("codex:front-start", async () => {
    // 前门要认的三条链路（缺一条就说明跑着的是老进程/手工起的：注册那条链路会 404，
    // 报告出来让用户「前门停止 → 前门启动」重启，不动别人的进程）
    const needLinks = CX.CODEX_LINKS.filter((x) => x.via === "front").map((x) => x.frontPath);
    const missing = (links) => needLinks.filter((k) => !links || !(k in links));
    const h = await codexFrontHealth();
    if (h.running) return { ok: true, already: true, links: h.links || {}, missing: missing(h.links) };
    if (!fs.existsSync(CODEX_FRONT)) return { ok: false, error: `未找到 bridge/codex_front.mjs（${CODEX_FRONT}）` };
    const nd = findNode();
    const args = [CODEX_FRONT, "--port", String(CODEX_FRONT_PORT)];
    for (const l of CX.CODEX_LINKS.filter((x) => x.via === "front")) args.push("--upstream", `${l.frontPath}=http://127.0.0.1:${l.port}`);
    const st = trySpawn(nd.cmd, args, {
      cwd: BRIDGE_DIR, env: { ...process.env, ...nd.env }, windowsHide: true, detached: true,
      stdio: ["ignore", fs.openSync(CODEX_FRONT_LOG, "a"), fs.openSync(CODEX_FRONT_LOG, "a")],
    });
    if (!st.proc) return { ok: false, error: `${st.error || "无法启动 Node 运行时"}（${nd.source}）` };
    codexFrontProc = st.proc;
    codexFrontProc.unref();
    codexFrontProc.on("exit", (code) => { log("codex front exited", code); codexFrontProc = null; });
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const hh = await codexFrontHealth();
      if (hh.running) return { ok: true, links: hh.links || {}, missing: missing(hh.links) };
    }
    return { ok: false, error: st.error || "10 秒内未就绪，查看 ~/.autoclaw-relay/codex-front.log" };
  });

  handle("codex:front-stop", async () => {
    try {
      const out = execSync(`netstat -ano | findstr :${CODEX_FRONT_PORT} | findstr LISTENING`, { shell: "cmd.exe", timeout: 8000 }).toString();
      const pid = out.trim().split(/\s+/).pop();
      if (pid) execSync(`taskkill /F /PID ${pid}`, { shell: "cmd.exe" });
      if (codexFrontProc) { try { codexFrontProc.kill(); } catch {} codexFrontProc = null; }
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  });

  /** 只读体检 + 逐链路现状（面板一屏：配置、目录、前门、cli、七条链路各自能不能用） */
  handle("codex:status", async () => {
    const cfg = codexCfgPath();
    const bundled = codexBundled();
    const bundledSlugs = bundled.models.map((m) => m.slug);
    const report = CX.checkCodexConfig(cfg, { bundledSlugs });
    const front = await codexFrontHealth();
    const version = codexVersion();
    const links = CX.CODEX_LINKS.map((l) => ({
      id: l.id, label: l.label, tier: l.tier, via: l.via, port: l.port, model: l.model,
      baseUrl: CX.linkBaseUrl(l), providerId: CX.codexProviderId(l.id),
      registered: (report.providers || []).some((t) => t.providerId === CX.codexProviderId(l.id)),
      current: report.current?.model_provider === CX.codexProviderId(l.id),
      upstreamAlive: CODEX_ALIVE[l.id](),
      note: l.tier === "chat" ? "上游没有工具通道：Codex 里当纯文本档用" : "工具循环可用（Codex 会在本机执行命令）",
    }));
    return {
      ok: report.ok === true, configPath: cfg, exists: report.exists !== false,
      eol: report.eol, bom: report.bom, current: report.current || {}, catalog: report.catalog || null,
      providers: report.providers || [], foreignTables: report.foreignTables || [], foreignTopKeys: report.foreignTopKeys || [],
      problems: report.problems || [], warnings: report.warnings || [],
      front: { running: front.running, port: CODEX_FRONT_PORT, links: front.links || {},
        responsesCalls: front.responsesCalls || 0, upstreamErrors: front.upstreamErrors || 0, lastError: front.lastError || null },
      cli: { path: codexCli(), version, ok: !!version },
      bundled: { count: bundled.models.length, error: bundled.error || "" },
      links,
    };
  });

  /** 注册 / 设为当前：写托管表 + 顶层指针 + 目录（闸门失败即抛，绝不落半截配置） */
  handle("codex:register", async (_e, linkId, opts = {}) => {
    const link = CX.linkOf(linkId);
    if (!link) return { ok: false, error: `未知链路 ${linkId}（可选：${CX.CODEX_LINKS.map((l) => l.id).join("、")}）` };
    let frontLinks = null, frontMissing = [];
    if (link.via === "front") {
      const st = await handlers["codex:front-start"]({});
      if (!st.ok) return { ok: false, error: `Codex 前门没起来：${st.error}` };
      frontLinks = st.links || null;
      frontMissing = st.missing || [];
    }
    const models = await codexModelList(linkId);
    const bundled = codexBundled();
    // 上游目录里的 id 可能是带前缀的全名（wb2api 报 cn:glm-5.3）——写全名才进得了目录、
    // 才拿得到元数据；写别名会让 Codex 回退默认元数据（0.160.1 实测会打 warning）
    const wantModel = opts.model || link.model;
    const model = CX.pickModel(wantModel, models.map((m) => m.slug));
    let r;
    try {
      r = CX.activate(codexCfgPath(), {
        linkId, model, token: linkApiKey(linkId), statePath: codexStatePath(),
        writeCatalog: opts.writeCatalog !== false, catalogModels: models,
        bundled: bundled.models.length ? bundled.models : null,
        contextWindow: opts.contextWindow, autoCompactLimit: opts.autoCompactLimit,
      });
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    const report = CX.checkCodexConfig(codexCfgPath(), { bundledSlugs: bundled.models.map((m) => m.slug) });
    const alive = CODEX_ALIVE[linkId]();
    const warnings = [...report.warnings];
    if (!bundled.models.length) warnings.push(`自带模型目录取不到（${bundled.error || "codex debug models 无输出"}）：目录只含本次取到的模型，官方模型可能从选择器里消失`);
    if (!models.length) warnings.push(`上游模型目录取不到（${link.label} 网关没起、或钥匙不一致）：这次目录只含 Codex 自带条目，Codex 里选不到这条链路的模型 —— 修好上游再注册一次`);
    else if (!models.some((m) => m.slug === model)) warnings.push(`上游目录里没有模型 ${model}：Codex 会回退默认元数据（窗口/推理档位不准），用「目录预览」挑一个真实 id 再注册`);
    if (!alive) warnings.push(`上游网关（:${link.port}）现在没在跑：配置已写好，但 Codex 里发请求会 502，先把它启动起来`);
    if (frontMissing.length) warnings.push(`前门在跑但不认得 ${frontMissing.map((k) => "/" + k).join("、")}（老进程或手工起的）：这条链路会 404，点「前门停止」再「前门启动」重启它`);
    if (link.tier === "chat") warnings.push("聊天档：上游没有工具通道，Codex 里只能当纯文本助手用（工具调用会失败）");
    return { ok: true, linkId, providerId: r.providerId, baseUrl: r.baseUrl, model: r.model, tier: link.tier,
      modelPicked: r.model !== wantModel ? { want: wantModel, used: r.model } : null,
      backup: r.backup, catalog: r.catalog, activeLinks: r.activeLinks, upstreamAlive: alive,
      front: frontLinks, warnings, report };
  });

  /** 摘除：只删我们的表；若它是当前供应商就把顶层键还原成注册前的样子 */
  handle("codex:deregister", async (_e, linkId) => {
    if (!CX.linkOf(linkId)) return { ok: false, error: `未知链路 ${linkId}` };
    try {
      const r = CX.deregister(codexCfgPath(), { linkId, statePath: codexStatePath() });
      return { ...r, report: CX.checkCodexConfig(codexCfgPath()) };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  /** 目录预览：这次会给 Codex 看到哪些模型（自带克隆 + 我方），不写盘 */
  handle("codex:catalog", async (_e, linkId) => {
    const link = CX.linkOf(linkId);
    if (!link) return { ok: false, error: `未知链路 ${linkId}` };
    const bundled = codexBundled();
    const models = await codexModelList(linkId);
    const picked = CX.pickModel(link.model, models.map((m) => m.slug));
    const cat = CX.buildCatalog({ bundled: bundled.models, models, ensureModel: picked });
    return { ok: true, linkId, liveModels: models.map((m) => m.slug), liveEmpty: models.length === 0,
      wantModel: link.model, pickedModel: picked, ensured: cat.ensured,
      bundled: cat.bundled, ours: cat.ours,
      skipped: cat.skipped, count: cat.count, builtSlugs: cat.slugs,
      bundledOk: bundled.models.length > 0, error: bundled.error || "" };
  });

  /** 冒烟：按 Codex 的形状打一发 /v1/responses（走前门的链路经翻译；直连链路直连 relay） */
  handle("codex:smoke", async (_e, linkId = "workbuddy") => {
    const link = CX.linkOf(linkId) || CX.linkOf("workbuddy");
    let origin, path0;
    if (link.via === "front") {
      const st = await handlers["codex:front-start"]({});
      if (!st.ok) return { ok: false, error: `Codex 前门没起来：${st.error}` };
      origin = { host: "127.0.0.1", port: CODEX_FRONT_PORT };
      path0 = `/${link.frontPath}/v1/responses`;
    } else {
      origin = { host: "127.0.0.1", port: link.port };
      path0 = "/v1/responses";
    }
    const model = link.model;
    // 512 而不是 64：思考型模型（glm-5.3 / qwen3.8-max 等）会先花掉一截 reasoning tokens，
    // 上限太小时正文一个字都不剩（实测 64 → 只有 reasoning 项、status=incomplete）。
    const body = JSON.stringify({ model, input: "请只回复OK", max_output_tokens: 512, stream: false });
    const r = await new Promise((resolve) => {
      const req = http.request({ ...origin, path: path0, method: "POST", timeout: 240000,
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${linkApiKey(link.id)}`, "Content-Length": Buffer.byteLength(body) } },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          let out = "", reply = "";
          try {
            const j = JSON.parse(d);
            out = j.output || [];
            reply = out.flatMap((o) => o.content || []).map((c) => c.text || "").join("").trim();
            if (!reply && j.error) reply = typeof j.error === "string" ? j.error : (j.error.message || "");
          } catch { reply = d.slice(0, 200); }
          resolve({ status: res.statusCode, items: out.map((o) => o.type), reply });
        });
      });
      req.on("error", (e) => resolve({ status: 0, items: [], reply: e.message }));
      req.on("timeout", () => { req.destroy(); resolve({ status: 0, items: [], reply: "超时（240s）" }); });
      req.write(body); req.end();
    });
    // 判定：200 且「有正文或至少有一个 reasoning 项」——有些思考型模型在 512 上限里
    // 只来得及吐思考，那不是链路坏了（items 里能看到 reasoning）
    const reasoning = r.items.some((t) => t === "reasoning");
    return { ok: r.status === 200 && (r.reply.length > 0 || reasoning), link: link.id, model, path: path0,
      status: r.status, items: r.items, reasoningOnly: reasoning && !r.reply,
      reply: r.reply.slice(0, 200) || (reasoning ? "（本次只有思考内容，正文被 max_output_tokens 截断）" : "") };
  });

  // --- 入站 api_key（七条链路统一闸门的钥匙盘点 / 鉴权体检 / 生成）---
  // 盘点：每条链路 ZCode 注册用的钥匙值 + 来源。所有钥匙本就是明文落在本机
  // （ZCode 的 provider_config.json、~/.autoclaw-relay/ 下的两个档案），
  // 这里只是把散在各处的值聚到一个视图里，不新增暴露面。
  // 列表第一位 = 当前主钥（linkApiKey 的口径，keys:probe 的带钥探针也用它）。
  const pushKey = (arr, value, source, extra) => {
    const v = typeof value === "string" ? value.trim() : "";
    if (v && !arr.some((k) => k.value === v)) arr.push({ value: v, source, ...(extra || {}) });
  };
  const genKeyOf = (linkId) => IK.activeKey(IK.readStore(INBOUND_KEYS_FILE), linkId);
  // 标准钥（别名·sk- 形）：档案顶层 _aliases[linkId] 里的值，专门喂 dsh / Codex /
  // OpenAI SDK 这类只认 sk- 形钥匙的标准工具。只进闸门集合，不改 ZCode 注册值，
  // 所以在清单里始终排在主钥之后（keys[0] 永远是当前主钥），并带 alias 标记
  // 供 UI 渲染撤销按钮。
  const pushAliases = (keys, linkId) => {
    for (const k of IK.readAliases(INBOUND_KEYS_FILE)[linkId] || []) {
      pushKey(keys, k, "标准钥 sk-（别名·工具用；可撤销）", { alias: true });
    }
  };
  const KEY_INVENTORY = [
    { id: "autoclaw", label: "AutoClaw", port: 18766, aliasable: true, keys: () => {
      const gen = genKeyOf("autoclaw");
      const keys = [];
      pushKey(keys, gen, "控制台生成（~/.autoclaw-relay/inbound-keys.json）");
      pushKey(keys, "autoclaw-local", gen ? "内置兜底（生成后仍有效）" : "内置（闸门 & ZCode 注册）");
      pushKey(keys, process.env.AUTOCLAW_PROXY_TOKEN || "autoclaw-dsh", "PROXY_TOKEN（dsh 共用）");
      if (process.env.AUTOCLAW_INBOUND_KEYS) for (const k of process.env.AUTOCLAW_INBOUND_KEYS.split(",").map((s) => s.trim()).filter(Boolean)) pushKey(keys, k, "AUTOCLAW_INBOUND_KEYS 轮换钥");
      pushAliases(keys, "autoclaw");
      return keys;
    } },
    { id: "workbuddy", label: "WorkBuddy", port: WB_PORT, keys: () => [
      // wb2api 是上游 Go 二进制，只有 config.json 的 api_key 单钥（Bearer 形状）、
      // 没有 env 追加通道；「生成」= 改写该文件并重启网关
      { value: linkApiKey("workbuddy"), source: "wb2api config.json api_key" },
    ] },
    { id: "trae", label: "Trae", port: TRAE_PORT, aliasable: true, keys: () => {
      const gen = genKeyOf("trae");
      const keys = [];
      pushKey(keys, gen, "控制台生成（~/.autoclaw-relay/inbound-keys.json）");
      pushKey(keys, "trae-local-key", gen ? "内置兜底（生成后仍有效）" : "内置（闸门 & ZCode 注册）");
      if (process.env.TRAE_INBOUND_KEYS) for (const k of process.env.TRAE_INBOUND_KEYS.split(",").map((s) => s.trim()).filter(Boolean)) pushKey(keys, k, "TRAE_INBOUND_KEYS 轮换钥");
      pushAliases(keys, "trae");
      return keys;
    } },
    { id: "doubao", label: "豆包工作", port: DOUBAO_PORT, aliasable: true, keys: () => {
      const gen = genKeyOf("doubao");
      const keys = [];
      pushKey(keys, gen, "控制台生成（~/.autoclaw-relay/inbound-keys.json）");
      pushKey(keys, "doubao-local-key", gen ? "内置兜底（生成后仍有效）" : "内置（闸门 & ZCode 注册）");
      let fileKey = null;
      try { fileKey = JSON.parse(fs.readFileSync(path.join(HOME, ".doubao-relay", "config.json"), "utf8")).key; } catch {}
      pushKey(keys, fileKey, "~/.doubao-relay/config.json");
      pushKey(keys, process.env.DOUBAO_RELAY_KEY, "DOUBAO_RELAY_KEY 环境变量");
      if (process.env.DOUBAO_INBOUND_KEYS) for (const k of process.env.DOUBAO_INBOUND_KEYS.split(",").map((s) => s.trim()).filter(Boolean)) pushKey(keys, k, "DOUBAO_INBOUND_KEYS 轮换钥");
      pushAliases(keys, "doubao");
      return keys;
    } },
    { id: "comate", label: "Comate", port: COMATE_PORT, aliasable: true, keys: () => {
      const gen = genKeyOf("comate");
      const keys = [];
      pushKey(keys, gen, "控制台生成（~/.autoclaw-relay/inbound-keys.json）");
      pushKey(keys, "comate-local", gen ? "内置兜底（生成后仍有效）" : "内置（闸门 & ZCode 注册）");
      pushKey(keys, process.env.COMATE_RELAY_KEY, "COMATE_RELAY_KEY 环境变量");
      if (process.env.COMATE_INBOUND_KEYS) for (const k of process.env.COMATE_INBOUND_KEYS.split(",").map((s) => s.trim()).filter(Boolean)) pushKey(keys, k, "COMATE_INBOUND_KEYS 轮换钥");
      pushAliases(keys, "comate");
      return keys;
    } },
    { id: "qoder", label: "Qoder CN", port: QODER_PORT, keys: () => {
      const k = qoderRealmKey("cn");
      return [{ value: k || "qoder-local", source: k ? "出口 Key（~/.autoclaw-relay/qoder-realm-keys.json）" : "兜底 qoder-local（出口 Key 未生成；点「生成」即用控制台流程补齐）" }];
    } },
    { id: "qwenwork", label: "千问办公", port: QODER_PORT, keys: () => {
      const k = qoderRealmKey("qworkcn");
      return [{ value: k || "qwenwork-local", source: k ? "出口 Key（~/.autoclaw-relay/qoder-realm-keys.json）" : "兜底 qwenwork-local（出口 Key 未生成；点「生成」即用控制台流程补齐）" }];
    } },
  ];

  handle("keys:query", async () => {
    const cfgMatch = (() => {
      // ZCode 注册值对账：access.apiKey 应与这里盘点的一致（不一致 = 注册后改过钥匙，需要重新注册）
      try {
        const cfg = JSON.parse(fs.readFileSync(ZCODE_CFG, "utf8"));
        const rules = cfg?.config?.providerConfigRules?.providerRules || [];
        const byId = new Map(rules.map((r) => [r.providerId, r?.config?.access?.apiKey || ""]));
        const pairs = { autoclaw: PROVIDER_ID, workbuddy: WB_PROVIDER_ID, trae: TRAE_PROVIDER_ID, doubao: DOUBAO_PROVIDER_ID, comate: COMATE_PROVIDER_ID, qoder: QODER_PROVIDER_ID, qwenwork: QWENWORK_PROVIDER_ID };
        const out = {};
        for (const item of KEY_INVENTORY) {
          const registered = byId.get(pairs[item.id]);
          const keys = item.keys();
          out[item.id] = {
            registered: registered || null,
            matches: registered ? keys.some((k) => k.value === registered) : null,
            // current：ZCode 注册的正是列表第一位（当前主钥），而非列表里的备用钥
            current: registered ? (keys[0]?.value || "") === registered : null,
          };
        }
        return out;
      } catch { return {}; }
    })();
    return {
      ok: true,
      links: KEY_INVENTORY.map(({ id, label, port, aliasable, keys }) => ({
        id, label, port, aliasable: !!aliasable, keys: keys(), zcode: cfgMatch[id] || null,
      })),
    };
  });

  // 鉴权体检：每条链路两个探针——匿名打模型端点必须 401（闸门在岗），
  // 带盘点钥匙再打必须不是 401 特征（钥匙被闸门认可）。判定只看状态码与
  // 特征串，不消耗上游额度：401 的报文在闸门层就生成，业务路径拿到的任何
  // 非闸门响应（200 目录 / 502 上游缺失 / 503）都算“越过闸门”。
  async function keyProbe(link) {
    const keys = link.keys();
    const probe = (method, pathname, headers, timeoutMs = 12000) => new Promise((resolve) => {
      const data = method === "POST" ? JSON.stringify({ model: "probe", max_tokens: 1, messages: [{ role: "user", content: "ping" }] }) : null;
      const rq = http.request({
        host: "127.0.0.1", port: link.port, path: pathname, method,
        headers: { ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}), ...headers },
        timeout: timeoutMs,
      }, (res) => {
        let b = ""; res.on("data", (c) => (b += c));
        res.on("end", () => resolve({ status: res.statusCode, body: b }));
      });
      rq.on("error", (e) => resolve({ status: 0, body: String(e.message) }));
      rq.setTimeout(timeoutMs, () => { rq.destroy(); resolve({ status: -1, body: "timeout" }); });
      if (data) rq.write(data); rq.end();
    });
    const GATE_MSG = "missing or invalid api key";
    const gated = (r) => r.status === 401 && r.body.includes(GATE_MSG);
    // 各家闸门管什么路径不一样：anthropic 系打 /v1/messages，openai 系打 /v1/models
    const anthro = ["autoclaw", "comate"].includes(link.id) || link.id === "trae";
    const path = anthro ? "/v1/messages" : "/v1/models";
    const method = anthro ? "POST" : "GET";
    const extra = link.id === "autoclaw" ? { "anthropic-version": "2023-06-01" } : {};
    const anon = await probe(method, path, extra);
    // wb2api 的 401 报文是 "missing or invalid API key"（大写 API），qoder 网关是 "invalid api key"——
    // 两个特征都认；保险兜底：任何 401 都视为闸门在岗（闸门层报文 vs 上游 401 无法区分时宁可误报闸门开）
    const gateOn = anon.status === 401;
    // wb2api 只认 Authorization: Bearer（带 x-api-key 头反而被它拒），其余网关两种形状等价——
    // 这里统一双头带钥，只有 workbuddy 单走 Bearer
    const keyHeaders = link.id === "workbuddy"
      ? { authorization: `Bearer ${keys[0].value}` }
      : { "x-api-key": keys[0].value, authorization: `Bearer ${keys[0].value}` };
    const withKey = keys.length ? await probe(method, path, { ...extra, ...keyHeaders }) : null;
    // 带钥仍 401 且报文是闸门特征才算“钥匙被拦”：带钥后的 401 也可能来自上游
    // （AutoClaw 欠费返回「云端上游 返回 401: Invalid token」、wb2api 转发上游 401），
    // 那恰好证明请求已越过闸门，不该判钥匙无效。
    const gateBody = (r) => r && r.status === 401
      && (r.body.includes("missing or invalid api key")
        || r.body.includes("missing or invalid API key")
        || r.body.includes('"invalid api key"'));
    const keyOk = withKey ? !gateBody(withKey) : false;
    return {
      id: link.id, label: link.label, port: link.port,
      running: anon.status !== 0 && anon.status !== -1,
      gate: anon.status === 0 ? "unreachable" : gateOn ? "on" : "off/legacy",
      anonStatus: anon.status,
      keyFirst: keys[0]?.value || "",
      keyProbeStatus: withKey ? withKey.status : null,
      ok: anon.status !== 0 && anon.status !== -1 && gateOn && keyOk,
      detail: anon.status === 0 ? "网关未运行"
        : !gateOn ? "匿名请求未被拦下（闸门关闭或旧代码）"
        : !keyOk ? `带钥匙仍被闸门拦下（${withKey.status}）——盘点值与网关实际钥匙不一致`
        : withKey && withKey.status === 401 ? "闸门在岗、钥匙有效（上游拒绝：账号欠费/登录态失效，见对应链路冒烟）"
        : withKey && (withKey.status === 502 || withKey.status === 503) ? "闸门在岗、钥匙有效（上游不可达/未登录，见对应链路冒烟）"
        : "闸门在岗且钥匙有效",
    };
  }

  /**
   * 拿「指定的一把钥匙」打链路模型端点（keys:probe 用主钥，这里给标准钥/别名
   * 断言用）。判定口径与 keys:probe 相同：401 且报文是闸门特征才算“被闸门拦下”，
   * 其余状态码（200 目录 / 上游 401、502、503）都算越过闸门。
   */
  function probeKey(linkId, key) {
    const link = KEY_INVENTORY.find((l) => l.id === linkId);
    if (!link) return Promise.resolve({ status: 0, gateBody: false, error: "未知链路" });
    const anthro = ["autoclaw", "comate", "trae"].includes(linkId);
    const path = anthro ? "/v1/messages" : "/v1/models";
    const method = anthro ? "POST" : "GET";
    const data = method === "POST" ? JSON.stringify({ model: "probe", max_tokens: 1, messages: [{ role: "user", content: "ping" }] }) : null;
    return new Promise((resolve) => {
      const rq = http.request({
        host: "127.0.0.1", port: link.port, path, method,
        headers: {
          ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
          "x-api-key": key, authorization: `Bearer ${key}`,
          ...(linkId === "autoclaw" ? { "anthropic-version": "2023-06-01" } : {}),
        },
        timeout: 12000,
      }, (res) => {
        let b = ""; res.on("data", (c) => (b += c));
        res.on("end", () => resolve({
          status: res.statusCode,
          gateBody: res.statusCode === 401 && (b.includes("missing or invalid api key") || b.includes("missing or invalid API key") || b.includes('"invalid api key"')),
        }));
      });
      rq.on("error", (e) => resolve({ status: 0, gateBody: false, error: String(e.message) }));
      rq.setTimeout(12000, () => { rq.destroy(); resolve({ status: -1, gateBody: false, error: "timeout" }); });
      if (data) rq.write(data);
      rq.end();
    });
  }

  handle("keys:probe", async () => {
    const probes = [];
    for (const link of KEY_INVENTORY) {
      try { probes.push(await keyProbe(link)); } catch (e) { probes.push({ id: link.id, label: link.label, ok: false, detail: String((e && e.message) || e) }); }
    }
    return { ok: probes.every((p) => p.ok), probes, at: new Date().toISOString() };
  });

  // 自测块在 app.whenReady 作用域，probeKey 在 setupIpc 作用域——直接调用会
  // ReferenceError（与 queueZcodeSync 同一个坑），所以照旧走处理器。
  handle("keys:probe:one", (_e, linkId, key) => probeKey(linkId, key));

  /**
   * 重启在跑的链路（停旧进程 → 走既有 start 处理器起新实例）：生成新钥后必须
   * 让在跑实例重新读档案。未运行返回 false（不需要重启，start 时自然读新钥）。
   * 停进程刻意不走 xxx:stop 处理器——它排队 queueZcodeSync({remove})，一次生成
   * 就会先把供应商摘掉再挂回来（多余的中间态写盘，还给失败留缺口）。
   */
  async function restartLink(linkId) {
    const alive = PLATFORM_ALIVE[linkId];
    if (!alive || !alive()) return false;
    const port = KEY_INVENTORY.find((l) => l.id === linkId)?.port;
    try {
      const out = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { shell: "cmd.exe", timeout: 8000 }).toString();
      const pid = out.trim().split(/\s+/).pop();
      if (pid) execSync(`taskkill /F /PID ${pid}`, { shell: "cmd.exe" });
    } catch (e) { throw new Error("停止旧实例失败：" + String((e && e.message) || e)); }
    await new Promise((r) => setTimeout(r, 800));   // taskkill 是同步的，留点余量让端口真正释放
    const startCh = linkId === "autoclaw" ? "relay:start" : `${linkId}:start`;
    const st = await handlers[startCh](null);
    if (st && st.ok === false) throw new Error(st.error || "启动失败");
    return true;
  }

  /**
   * 生成/指定新钥的落地（keys:generate 与 keys:rotate 共用）：
   * 写档案或配置 → 在跑的链路重启吃进 → 排队把 ZCode 注册值切换到新钥。
   * 三条通道：workbuddy 改 wb2api config.json（单钥）；qoder/千问办公走网关
   * 出口 Key 的面板流程；其余四条写 ~/.autoclaw-relay/inbound-keys.json（档案
   * 是「加钥」，内置兜底钥不受影响）。ZCode 侧一律要等 ZCode 重启才读新配置。
   */
  async function applyInboundKey(linkId, newKey) {
    const link = KEY_INVENTORY.find((l) => l.id === linkId);
    if (!link) return { ok: false, error: `未知链路 ${linkId}（可选：${KEY_INVENTORY.map((l) => l.id).join("、")}）` };
    if (!IK.validKey(newKey)) return { ok: false, error: "钥匙形状不合法：可打印 ASCII、无空白、4..128 字符（控制台生成的都是这个形状）" };
    if (linkId === "workbuddy") {
      let cfg = {};
      try { cfg = JSON.parse(fs.readFileSync(WB_CONFIG, "utf8")) || {}; } catch {}
      cfg.api_key = newKey;
      try { fs.writeFileSync(WB_CONFIG, JSON.stringify(cfg, null, 2)); } catch (e) { return { ok: false, error: `config.json 写入失败：${e.message}` }; }
      let restarted = false;
      try { restarted = await restartLink(linkId); } catch (e) { return { ok: false, error: `新钥已写入 config.json，但网关重启失败：${e.message}（手动重启 workbuddy 网关即可）` }; }
      queueZcodeSync({ upsert: [linkId] });
      return { ok: true, linkId, key: newKey, store: WB_CONFIG, restarted, note: restarted ? "已改写 wb2api config.json 并重启网关" : "已改写 wb2api config.json（网关未运行，启动后生效）" };
    }
    if (linkId === "qoder" || linkId === "qwenwork") {
      const realm = linkId === "qoder" ? "cn" : "qworkcn";
      const store = readRealmKeys();
      store[realm] = newKey;
      try { fs.writeFileSync(QODER_REALM_KEYS, JSON.stringify(store, null, 1), { mode: 0o600 }); } catch (e) { return { ok: false, error: `落盘失败：${e.message}` }; }
      const ensure = await qoderEnsureRealmKeys();
      if (!ensure.ok) return { ok: false, error: ensure.error };
      queueZcodeSync({ upsert: [linkId] });
      return { ok: true, linkId, key: newKey, store: QODER_REALM_KEYS, restarted: false, note: "出口 Key 已写网关（重启 ZCode 后生效）" };
    }
    const store = IK.readStore(INBOUND_KEYS_FILE);
    store[linkId] = newKey;
    try { IK.writeStore(INBOUND_KEYS_FILE, store); } catch (e) { return { ok: false, error: `档案落盘失败：${e.message}` }; }
    let restarted = false;
    try { restarted = await restartLink(linkId); } catch (e) { return { ok: false, error: `档案已更新，但链路重启失败：${e.message}（手动重启该链路即可生效）` }; }
    queueZcodeSync({ upsert: [linkId] });
    return { ok: true, linkId, key: newKey, store: INBOUND_KEYS_FILE, restarted, note: restarted ? "档案已更新、链路已重启（新钥即刻生效）" : "档案已更新（链路未运行，下次启动即生效）" };
  }

  // 生成：给指定链路生成一把随机新钥并全链路落地（档案 → 重启 → 重注册）。
  // 生成是「加钥」语义：内置兜底钥永远有效，ZCode 注册值切到新钥；想换一把
  // 再点一次即可，不存在「换钥后旧配置全废」的状态。
  handle("keys:generate", async (_e, linkId) => {
    const out = await applyInboundKey(linkId, IK.generateKey(linkId));
    if (out.ok) out.hint = "ZCode 侧重启客户端后读新配置（或点「一键注册」立即写）；此后本卡片「重新盘点」即显示新钥";
    return out;
  });

  // 轮换：指定 newKey 时与「生成」走同一条落地路径；不带 newKey 只报告可行路径，不做静默改钥
  handle("keys:rotate", async (_e, linkId, newKey) => {
    const link = KEY_INVENTORY.find((l) => l.id === linkId);
    if (!link) return { ok: false, error: `未知链路 ${linkId}（可选：${KEY_INVENTORY.map((l) => l.id).join("、")}）` };
    if (newKey) {
      const r = await applyInboundKey(linkId, String(newKey).trim());
      if (r.ok) r.rotated = true;
      return r;
    }
    return {
      ok: true, linkId,
      hint: linkId === "workbuddy"
        ? "WorkBuddy：点「生成」由控制台改写 wb2api config.json 并重启网关；手动方式同此（改 api_key 后重启 wb2api.exe）"
        : linkId === "qoder" || linkId === "qwenwork"
          ? "Qoder/千问办公：点「生成」由控制台重建出口 Key（写本地明文 → 写网关 → 重注册）"
          : `${link.label}：点「生成」由控制台生成随机新钥，写入 ~/.autoclaw-relay/inbound-keys.json 并自动重启该链路；手动方式：${link.id.toUpperCase()}_INBOUND_KEYS=旧钥,新钥 平滑并存，重启 relay 后在 ZCode 里更新注册值。要给只认 sk- 形的标准工具（dsh / Codex / OpenAI SDK）用，点行内「sk 钥」加一把标准钥（别名）即可——它不改 ZCode 注册值`,
    };
  });

  /**
   * 标准钥（别名·sk- 形）：给只认 sk- 开头钥匙的标准工具（DeepSeek Harness、
   * Codex、OpenAI SDK 系）备的一把旁路钥匙。写档案顶层 _aliases[linkId]，
   * 只进对应 relay 的入站闸门集合，不动 ZCode 注册值——所以加/删都不排队重注册，
   * 但必须重启对应链路（闸门集合在启动时构造一次）。
   * action：add（key 为空则现场生成一把 sk-<前缀>-<36 hex>，也可用自带的自定义钥）
   * / remove（撤销，给 key）。
   */
  handle("keys:alias", async (_e, linkId, key, action) => {
    const link = KEY_INVENTORY.find((l) => l.id === linkId);
    if (!link) return { ok: false, error: `未知链路 ${linkId}（可选：${KEY_INVENTORY.map((l) => l.id).join("、")}）` };
    if (!link.aliasable) {
      return { ok: false, error: linkId === "workbuddy"
        ? "WorkBuddy 不支持标准钥别名：wb2api 是单钥二进制（只有 config.json 的 api_key 一把）。要 sk- 形就用「生成」/「轮换」把主钥直接换成 sk- 形"
        : `${link.label} 不支持标准钥别名：该链路走网关侧出口 Key，单钥；要用 sk- 形请直接用「生成」` };
    }
    const act = String(action || "add").trim();
    let out;
    if (act === "remove") {
      const want = String(key || "").trim();
      if (!want) return { ok: false, error: "撤销标准钥需要给出要移除的值" };
      out = IK.removeAlias(INBOUND_KEYS_FILE, linkId, want);
      if (!out.ok) return out;
      if (!out.removed) return { ok: false, error: "档案里没有这把标准钥（可能已撤销，或值不一致）", aliases: out.aliases };
    } else if (act === "add") {
      out = IK.addAlias(INBOUND_KEYS_FILE, linkId, String(key || "").trim() || IK.generateStandardKey(linkId));
      if (!out.ok) return out;
    } else {
      return { ok: false, error: `未知 action：${act}（可选 add / remove）` };
    }
    let restarted = false;
    try { restarted = await restartLink(linkId); } catch (e) {
      return { ok: false, error: `标准钥已${act === "remove" ? "撤销" : "落盘"}，但链路重启失败：${e.message}（手动重启该链路即可生效）`, aliases: out.aliases };
    }
    const verb = act === "remove" ? "标准钥已撤销" : "标准钥已登记";
    return {
      ok: true, linkId, action: act, key: out.key || String(key || "").trim(), aliases: out.aliases,
      store: INBOUND_KEYS_FILE, restarted,
      note: `${verb}${restarted ? "、链路已重启（即刻生效）" : "（链路未运行，下次启动即生效）"}；别名只进闸门，ZCode 注册值不变、无需重注册`,
    };
  });

  handle("logs:tail", async (_e, which) => {
    if (which === "watch") return tailFile(WATCH_LOG, 120);
    if (which === "console") return tailFile(path.join(RELAY_DIR, "console.log"), 120);
    if (which === "workbuddy") return tailFile(WB_LOG, 150);
    if (which === "trae") return tailFile(TRAE_LOG, 150);
    if (which === "doubao") return tailFile(DOUBAO_LOG, 150);
    if (which === "comate") return tailFile(COMATE_LOG, 150);
    if (which === "qoder") return tailFile(QODER_LOG, 150);
    if (which === "codex") return tailFile(CODEX_FRONT_LOG, 150);
    return tailFile(RELAY_LOG, 200);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180, height: 860, minWidth: 980, minHeight: 640,
    backgroundColor: "#0f1115",
    title: "AutoClaw → ZCode 控制台",
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(() => {
  log("console started");
  const boot = ensureRelayServer();   // 首次运行：把 relay 部署到 ~/.autoclaw-relay/
  if (boot) log("relay 自举失败:", boot);
  const wbBoot = ensureWbWorkDir();   // 打包态：播种 ~/.workbuddy-gateway/（config.json + auths/ + data/）
  if (wbBoot) log("workbuddy 自举失败:", wbBoot);
  setupIpc();
  if (process.env.ASWITCH_SELFTEST !== "1") {
    // 开机对账：活着的链路补注册进 ZCode，已停的摘除（后台串行跑，不阻塞窗口）。
    // queueZcodeSync 声明在 setupIpc 作用域内，这里必须走注册好的 zcode:sync 处理器
    // 触发——直接调用会在 whenReady 抛 ReferenceError，连 createWindow 都到不了
    // （症状：进程在、窗口无、日志只有 console started。2026-10-07 冷启动实测踩中）。
    handlers["zcode:sync"]({}).catch((e) => log("开机对账失败:", String((e && e.message) || e)));
  }
  if (process.env.ASWITCH_SELFTEST === "1") {
    // 自测模式：顺序执行各 IPC 处理器（等同逐个点击按钮），结果输出到 stdout
    const invoke = (ch, ...args) => {
      const h = handlers[ch];
      if (!h) return Promise.reject(new Error("no handler " + ch));
      return Promise.resolve(h({ _selftest: true }, ...args));
    };
    (async () => {
      const results = [];
      const progFile = path.join(RELAY_DIR, "selftest-progress.txt");
      const prog = (msg) => { try { fs.appendFileSync(progFile, `${new Date().toISOString().slice(11, 19)} ${msg}
`); } catch {} };
      const t = async (name, ok) => { results.push([name, !!ok]); prog(`${name}: ${ok ? "PASS" : "FAIL"}`); };
      prog("selftest start");
      // 定向自测：ASWITCH_SELFTEST_ONLY="zcode:register,trae:smoke" 只跑指定处理器，
      // 便于快速迭代单个按钮（全量自测会重启 relay，耗时较长）。
      // 需要带参的处理器用 "=" 传字符串参数（多参数再按 "=" 分段）：
      // keys:generate=trae / keys:rotate=trae=<新钥>
      const only = (process.env.ASWITCH_SELFTEST_ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);
      if (only.length) {
        for (const spec of only) {
          const eq = spec.indexOf("=");
          const ch = eq >= 0 ? spec.slice(0, eq) : spec;
          const args = eq >= 0 ? spec.slice(eq + 1).split("=") : [];
          try {
            const out = await invoke(ch, ...args);
            prog(`only ${spec} -> ${JSON.stringify(out).slice(0, 400)}`);
            console.log(`==== ONLY ${spec} ====`);
            console.log(JSON.stringify(out, null, 1).slice(0, 8000));
          } catch (e) {
            prog(`only ${spec} ERROR: ${e.message}`);
            console.log(`==== ONLY ${spec} ERROR: ${e.message} ====`);
          }
        }
        app.exit(0);
        return;
      }
      const s1 = await invoke("status:query");
      await t("status:query", s1.relay.running && s1.zcode.registered);
      const env = await invoke("env:check");
      prog(`env:check ${(env.items || []).filter((i) => !i.ok).map((i) => i.name + ":" + i.detail).join(" | ") || "全部就绪"}`);
      await t("env:check", env.ok === true);
      const p1 = await invoke("points:refresh");
      await t("points:refresh", p1.ok && p1.total != null);
      const c1 = await invoke("credential:sync");
      await t("credential:sync", c1.ok === true);
      await invoke("watcher:stop");
      await new Promise((r) => setTimeout(r, 1500));
      const w0 = await invoke("status:query");
      await t("watcher:stop", w0.watcher.running === false);
      await invoke("watcher:start");
      await new Promise((r) => setTimeout(r, 2500));
      const w1 = await invoke("status:query");
      await t("watcher:start", w1.watcher.running === true);
      prog("smoke:test 发起（上游慢时最长 3 分钟）");
      const sm = await invoke("smoke:test");
      await t("smoke:test", sm.ok === true && sm.reply);
      await invoke("workbuddy:start");
      prog("workbuddy:smoke 发起");
      const wbs = await invoke("workbuddy:smoke");
      prog(`workbuddy:smoke detail status=${wbs.status} reply=${String(wbs.reply).slice(0, 80)}`);
      await t("workbuddy:smoke", wbs.ok === true);
      const wbc = await invoke("workbuddy:credits");
      await t("workbuddy:credits", wbc.ok === true);
      await invoke("trae:start");
      prog("trae:smoke 发起（Trae 需远端拉起沙箱会话，通常 10-40 秒）");
      const trs = await invoke("trae:smoke");
      prog(`trae:smoke detail status=${trs.status} model=${trs.model} reply=${String(trs.reply).slice(0, 80)}`);
      await t("trae:smoke", trs.ok === true);
      await invoke("doubao:start");
      prog("doubao:smoke 发起（豆包首字通常 3-10 秒）");
      const dbs = await invoke("doubao:smoke");
      prog(`doubao:smoke detail status=${dbs.status} model=${dbs.model} reply=${String(dbs.reply).slice(0, 80)}`);
      await t("doubao:smoke", dbs.ok === true);
      await invoke("comate:start");
      prog("comate:smoke 发起（云端 agent 三步链，通常 8-40 秒）");
      const cms = await invoke("comate:smoke");
      prog(`comate:smoke detail status=${cms.status} model=${cms.model} reply=${String(cms.reply).slice(0, 80)}`);
      await t("comate:smoke", cms.ok === true);
      // 工具循环是这一版 relay 的能力，健康检查自报；不花额度就能识别“跑着旧代码的 relay”
      const cmSt = (await invoke("status:query")).comate || {};
      prog(`comate:tool-loop detail ${JSON.stringify(cmSt.toolLoop || null)} cached=${cmSt.toolRoutingCached ?? "-"}`);
      await t("comate:tool-loop", typeof cmSt.toolLoop === "string" && cmSt.toolLoop.includes("continuation"));
      await invoke("qoder:start");
      await invoke("qoder:sync-accounts");
      prog("qoder:smoke 发起（COSY 签名链路，通常 3-15 秒）");
      const qds = await invoke("qoder:smoke");
      prog(`qoder:smoke detail status=${qds.status} model=${qds.model} reply=${String(qds.reply).slice(0, 80)}`);
      await t("qoder:smoke", qds.ok === true);
      // 千问办公与 Qoder 共用网关进程，只是出口不同（qworkcn 账号池）
      prog("qwenwork:smoke 发起");
      const qws = await invoke("qwenwork:smoke");
      prog(`qwenwork:smoke detail status=${qws.status} model=${qws.model} reply=${String(qws.reply).slice(0, 80)}`);
      await t("qwenwork:smoke", qws.ok === true);
      // ---- Codex 接入：在**临时 CODEX_HOME** 上跑（把用户真实 config.toml 复制过去当 fixture），
      // 覆盖 只读体检 → 起前门 → 目录预览 → 注册（写托管区+目录）→ 复检 → 冒烟 → 摘除后逐字节还原。
      // 不用真实 ~/.codex：自测中途中断时，用户自己的 Codex 配置不该被留在半途。
      const cxHome = fs.mkdtempSync(path.join(os.tmpdir(), "aswitch-codex-selftest-"));
      const cxRealCfg = codexCfgPath();
      let cxCopied = false;
      try { if (fs.existsSync(cxRealCfg)) { fs.copyFileSync(cxRealCfg, path.join(cxHome, "config.toml")); cxCopied = true; } } catch {}
      process.env.CODEX_HOME = cxHome;
      process.env.ASWITCH_CODEX_STATE = path.join(cxHome, "codex-state.json");   // 快照也隔离，别动用户真实的
      const cxNorm = () => { try { const s = fs.readFileSync(codexCfgPath(), "utf8"); return s.trim() ? s : null; } catch { return null; } };
      // fixture 是用户真实配置的副本，可能本身就带着我们的托管区（用户已把某条链路注册进 Codex）。
      // 先摘一次把 fixture 归零——否则「注册→摘除」之后不可能跟带托管区的起点逐字节相等。
      try { await invoke("codex:deregister", "workbuddy"); } catch {}
      const cxBefore = cxNorm();
      prog(`codex selftest home=${cxHome}（用户真实配置${cxCopied ? "已复制当 fixture" : "不存在"}，全程不碰原文件）`);
      const cx0 = await invoke("codex:status");
      prog(`codex:status cli=${cx0.cli?.version || "未找到"} 自带目录=${cx0.bundled?.count} 前门=${cx0.front?.running} 已注册=${(cx0.providers || []).map((p) => p.providerId).join(",") || "无"}`);
      await t("codex:status", cx0.cli?.ok === true && cx0.bundled?.count > 0 && Array.isArray(cx0.links) && cx0.links.length === 7);
      const cxf = await invoke("codex:front-start");
      prog(`codex:front-start ${cxf.already ? "已在运行" : "已启动"} links=${Object.keys(cxf.links || {}).join(",")} 缺=${JSON.stringify(cxf.missing || [])}`);
      await t("codex:front-start", cxf.ok === true && !!(cxf.links || {}).wb);
      const cxc = await invoke("codex:catalog", "workbuddy");
      prog(`codex:catalog 自带=${cxc.bundled} 我方=${cxc.ours} 共=${cxc.count} 网关实时目录=${JSON.stringify(cxc.liveModels).slice(0, 160)} skipped=${JSON.stringify(cxc.skipped)}`);
      await t("codex:catalog", cxc.ok === true && cxc.count > cxc.bundled);
      const cxr = await invoke("codex:register", "workbuddy");
      prog(`codex:register provider=${cxr.providerId} model=${cxr.model} 目录=${cxr.catalog?.count} 上游=${cxr.upstreamAlive} 警告=${(cxr.warnings || []).join(" | ") || "无"}`);
      await t("codex:register", cxr.ok === true && cxr.providerId === "aswitch-workbuddy" && cxr.catalog?.count > 0);
      const cx1 = await invoke("codex:status");
      prog(`codex:status(注册后) current=${cx1.current?.model_provider} 目录条目=${cx1.catalog?.entries} ok=${cx1.ok} 问题=${JSON.stringify(cx1.problems)}`);
      await t("codex:status(注册后)", cx1.current?.model_provider === "aswitch-workbuddy" && cx1.ok === true && cx1.catalog?.entries > 0);
      const cxs = await invoke("codex:smoke", "workbuddy");
      prog(`codex:smoke link=${cxs.link} status=${cxs.status} 输出项=${JSON.stringify(cxs.items)} reply=${String(cxs.reply).slice(0, 60)}`);
      await t("codex:smoke", cxs.ok === true);
      const cxd = await invoke("codex:deregister", "workbuddy");
      prog(`codex:deregister changed=${cxd.changed} restored=${cxd.restored} 目录已清=${cxd.catalogRemoved} 文件逐字节还原=${cxBefore === cxNorm()}`);
      await t("codex:deregister", cxd.ok === true && cxd.changed === true && cxd.restored === true && cxBefore === cxNorm());
      delete process.env.CODEX_HOME;   // 临时 home 用完就还回去，后面的 env:check 报真实路径
      delete process.env.ASWITCH_CODEX_STATE;
      try { fs.rmSync(cxHome, { recursive: true, force: true }); } catch {}
      // 一键启动（此时各家都已在跑，应全部报“已在运行”）
      const all = await invoke("all:start");
      prog(`all:start ${(all.steps || []).map((s) => `${s.name}:${s.ok ? s.detail : s.detail}`).join(" | ")}`);
      await t("all:start", all.ok === true);
      // 余额总览：七条链路一次拉齐（有额度接口的给真实读数，没有的标 noApi 并只给登录态）。
      // 断言只看结构（7 行都在），数值本身随账号状态变，不作为通过条件。
      const bal = await invoke("balance:all");
      prog(`balance:all ${(bal.links || []).map((l) => `${l.label}:${l.available ? l.value + (l.unit || "") : (l.noApi ? "无接口" : "未取到")}`).join(" | ")}`);
      await t("balance:all", bal.ok === true && Array.isArray(bal.links) && bal.links.length === 7);
      const rg = await invoke("zcode:register");
      prog(`zcode:register detail trae=${JSON.stringify(rg.trae).slice(0, 200)} workbuddy=${JSON.stringify(rg.workbuddy).slice(0, 120)} comate=${JSON.stringify(rg.comate).slice(0, 120)} qoder=${JSON.stringify(rg.qoder).slice(0, 120)} qwenwork=${JSON.stringify(rg.qwenwork).slice(0, 120)}`);
      await t("zcode:register", rg.ok === true && Array.isArray(rg.models) && rg.models.length >= 4);
      await t("zcode:register:trae", rg.trae?.registered === true && rg.trae.models.length > 0);
      await t("zcode:register:comate", rg.comate?.registered === true && rg.comate.models.length > 0);
      await t("zcode:register:qoder", rg.qoder?.registered === true && rg.qoder.models.length > 0);
      // 第八家：千问办公走绑定了 qworkcn 的出口 Key，注册成功即证明 Key 分流链路在位
      await t("zcode:register:qwenwork", rg.qwenwork?.registered === true && rg.qwenwork.models.length > 0);
      await t("zcode:realm-keys", rg.realmKeys?.realms?.includes("cn") === true && rg.realmKeys?.realms?.includes("qworkcn") === true);
      // 注册结果里 ok 只代表目录取到了；写入被闸门拦下是另一个字段（历史上这么漏过一次）
      await t("zcode:register:未被闸门拦下", !rg.registerError);
      // 注册后立即体检：配置必须仍然健康（合法枚举 + manualProviderModelRules 在位）
      const zc = await invoke("zcode:check");
      prog(`zcode:check providers=${(zc.providers || []).map((p) => `${p.providerId}:${p.apiType || "none"}`).join(",")} manual=${zc.hasManualRules}`);
      await t("zcode:check", zc.ok === true && zc.hasManualRules === true && zc.modelRuleCount > 0);
      prog(`zcode:register detail backup=${rg.backup}`);
      // 生成 api_key：给 trae 生成一把随机钥（写档案 → 重启 trae 吃进 → 排队重注册），
      // 紧接着的 keys:probe 会用「生成后的当前主钥」带钥复测；两行一起覆盖生成链路端到端
      const kg = await invoke("keys:generate", "trae");
      const trk = ((await invoke("keys:query")).links || []).find((l) => l.id === "trae");
      const kgActive = (trk?.keys || [])[0]?.value === kg.key;
      prog(`keys:generate trae key=${kg.key ? kg.key.slice(0, 12) + "…" : "-"} restarted=${kg.restarted} store=${kg.store ? "ok" : "-"} active=${kgActive} ${kg.error || kg.note || ""}`);
      await t("keys:generate", kg.ok === true && /^tr-[0-9a-f]{36}$/.test(String(kg.key)) && kgActive);
      // 标准钥（别名 sk-）：给 trae 加一把 sk- 形旁路钥（写 _aliases → 重启 trae 吃进），
      // 用它带钥打 /v1/messages 必须越过闸门（证明别名真的进了闸门集合），
      // 且 ZCode 注册值仍是主钥、盘点里别名排在其后；最后撤销还原现场
      const ka = await invoke("keys:alias", "trae", "", "add");
      const trA = ((await invoke("keys:query")).links || []).find((l) => l.id === "trae");
      const aliasSeen = (trA?.keys || []).some((k) => k.alias === true && k.value === ka.key);
      const aliasMainKept = (trA?.keys || [])[0]?.value === kg.key;
      const aProbe = ka.ok ? await invoke("keys:probe:one", "trae", ka.key) : { status: 0 };
      prog(`keys:alias add key=${ka.key ? ka.key.slice(0, 14) + "…" : "-"} restarted=${ka.restarted} listed=${aliasSeen} mainKept=${aliasMainKept} probe=${aProbe.status} ${ka.error || ka.note || ""}`);
      await t("keys:alias", ka.ok === true && /^sk-tr-[0-9a-f]{36}$/.test(String(ka.key)) && aliasSeen && aliasMainKept
        && aProbe.status !== 0 && aProbe.status !== -1 && aProbe.gateBody !== true);
      const kx = await invoke("keys:alias", "trae", ka.key, "remove");
      prog(`keys:alias remove restarted=${kx.restarted} left=${(kx.aliases || []).length} ${kx.error || kx.note || ""}`);
      await t("keys:alias:remove", kx.ok === true && (kx.aliases || []).every((k) => k !== ka.key));
      // 入站 api_key：全部活着的链路匿名必须 401、带盘点钥匙必须越过闸门（不消耗上游额度）
      const kp = await invoke("keys:probe");
      prog(`keys:probe ${(kp.probes || []).map((p) => `${p.label}:${p.ok ? "ok" : p.detail}`).join(" | ")}`);
      await t("keys:probe", kp.ok === true);
      const l1 = await invoke("logs:tail", "relay");
      const l2 = await invoke("logs:tail", "watch");
      const l3 = await invoke("logs:tail", "trae");
      const l4 = await invoke("logs:tail", "codex");
      await t("logs:tail", l1.length > 50 && l2.length > 0 && l3.length > 0 && l4.length > 0);
      prog("relay:stop 发起");
      await invoke("relay:stop");
      await new Promise((r) => setTimeout(r, 2500));
      const h0 = await new Promise((res) => {
        const q = http.get("http://127.0.0.1:18766/health", { timeout: 3000 }, (r2) => { res(true); r2.resume(); });
        q.on("error", () => res(false)); q.on("timeout", () => { q.destroy(); res(false); });
      });
      await t("relay:stop (失联)", h0 === false);
      await invoke("relay:start");
      await new Promise((r) => setTimeout(r, 2500));
      const s2 = await invoke("status:query");
      await t("relay:start (恢复)", s2.relay.ok === true);
      const pass = results.filter((r) => r[1]).length;
      prog(`selftest 完成 ${pass}/${results.length}`);
      console.log(`==== SELFTEST ${pass}/${results.length} ====`);
      try { fs.writeFileSync(path.join(RELAY_DIR, "selftest-result.txt"), JSON.stringify({ time: new Date().toISOString(), pass, total: results.length, results: results.map(([n, ok]) => ({ name: n, ok })) }, null, 1)); } catch {}
      app.exit(pass === results.length ? 0 : 1);
    })();
    return;
  }
  createWindow();
});
app.on("window-all-closed", () => {
  // relay 与同步器为后台服务，关闭窗口不停止它们
  app.quit();
});
