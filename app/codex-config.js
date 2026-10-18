"use strict";
/**
 * Codex 配置（~/.codex/config.toml）的读写工具（纯 Node，无 Electron 依赖，零第三方依赖）。
 *
 * 单独成模块的原因与 app/zcode-config.js 相同：这段逻辑要能在真实点击「注册」之前
 * 被合成 fixture 反复重放（`node app/test_codex_config.js`），而不是只能在 Electron
 * 里点一次才知道写坏了没有。config.toml 是 Codex 自己的文件，用户还往里写
 * [projects.*]、[plugins.*]、notify……我们只被允许动自己那几行。
 *
 * 闸门（任何一道不过就拒绝落盘，宁可注册失败也不给客户端留半截配置）：
 *   G1 形状   providerId / base_url / wire_api / token / model 必须是我们认得的形状；
 *             base_url 只允许 http://127.0.0.1:<本机已知端口>/<已知前缀>/v1。
 *   G2 结构   托管区之外逐字节不变（外来表、外来顶层键、注释、空行、缩进、换行风格全算），
 *             实现是「去掉托管行之后的残文必须相等」——比逐个键比对强。
 *   G3 原子   tmp + rename；写前留 config.toml.bak-<stamp>；保留换行风格与 BOM。
 *   G4 读回   写完重新解析断言托管区生效；失败立即回滚备份。
 *
 * 托管区（唯一允许我们改的东西）：
 *   ① [model_providers.aswitch-<link>] 表 —— 凭据放这里的 experimental_bearer_token，
 *      不碰 ~/.codex/auth.json（那是官方登录的地盘，动它等于把官方登录打给第三方）。
 *      机制取证见 .research/cc-switch-codex-analysis.md §0.1；本机 0.160.1 实测：
 *      带 experimental_bearer_token 的 provider 表不需要 auth.json 就能跑。
 *   ② 顶层指针键 model_provider / model / model_catalog_json，以及按需写、
 *      按需撤的 model_context_window / model_auto_compact_token_limit。
 *      激活前的旧值快照进 <statePath>，摘除时原样还原。
 *
 * 关于目录（model_catalog_json）：0.160.1 实测 —— 自定义目录**整体替换**自带目录
 * （只写 1 条模型的目录，`codex debug models` 就只剩那 1 条），所以生成目录时必须把
 * 自带条目整份克隆进来，否则激活我们的配置会把官方模型从选择器里赶走。
 * 我方条目用 11 个必填字段的最小模板（字段集由探针逐条补出，见
 * .research/codex-probe/probe_catalog.mjs）：它产出与「未知模型回退元数据」完全相同的
 * 工具面（只有 exec_command 一族 shell 工具，没有 apply_patch / tool_search）。
 * 差别不在 shell_type 上，而在**官方条目多写了三样东西**（0.160.1 自带目录实测）：
 * apply_patch_tool_type="freeform"、supports_search_tool=true、experimental_supported_tools
 * 非空——克隆官方 gpt-* 条目就会把 freeform apply_patch 带进来，我们的桥只翻译 shell 词汇。
 * shell_type 的合法值只有 default / local / shell_command / unified_exec / disabled，
 * 写别的整个目录会解析失败（报 unknown variant）；其中 shell_command 在 0.160.1 里被
 * 解析成 unified_exec（`codex debug models` 渲染出来就是它），所以我们照实写 unified_exec。
 */
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------- 链路表（G1 白名单）
// 端口/前缀必须与 main.js 的监管常量一致：18776 是 codex_front（Responses→Chat 网桥），
// 直连链路的端口就是各 relay 自己的监听端口。
const FRONT_PORT = 18776;
const FRONT_HOST = "127.0.0.1";

/**
 * 每条链路的 Codex 注册参数。
 *   via  : "front" = 走 codex_front 翻译（上游只讲 chat completions，没有 /responses）；
 *          "direct" = relay 自带 /v1/responses。
 *   tier : "tools" = 工具循环可用；"chat" = 只能聊天（Codex 里当纯文本档）。
 *   model: 默认模型（注册时可覆盖；取值来自 models-catalog.json 的对外命名）。
 */
const CODEX_LINKS = [
  { id: "workbuddy", label: "WorkBuddy", via: "front", frontPath: "wb", port: 7863, model: "glm-5.3", tier: "tools" },
  { id: "comate", label: "Comate 文心快码", via: "direct", port: 18774, model: "glm-5.3", tier: "tools" },
  { id: "qoder", label: "Qoder CN", via: "direct", port: 8791, model: "auto", tier: "tools" },
  { id: "qwenwork", label: "千问办公", via: "direct", port: 8791, model: "qwen3.8-max", tier: "tools" },
  { id: "autoclaw", label: "AutoClaw", via: "direct", port: 18766, model: "glm-5.3", tier: "tools" },
  // trae 的模型名大小写/后缀敏感：`deepseek-v4-flash`（多模态全组条目）上游会**静默返回空**
  // （200 + 空 content，不报错，实测 2026-10-11），`-official` 后缀那条才真出话。别改回去。
  { id: "trae", label: "Trae SOLO CN", via: "front", frontPath: "trae", port: 18768, model: "deepseek-v4-flash-official", tier: "chat" },
  { id: "doubao", label: "豆包工作", via: "front", frontPath: "doubao", port: 18770, model: "doubao", tier: "chat" },
];

const MANAGED_TOP_KEYS = ["model_provider", "model", "model_catalog_json", "model_context_window", "model_auto_compact_token_limit"];
// 可选键：只在调用方给值时写，写过就记进 state.writtenKeys；下次不给则撤掉并还原用户原值
const OPTIONAL_TOP_KEYS = ["model_context_window", "model_auto_compact_token_limit"];
const CATALOG_REL = "aswitch-model-catalog.json";
const PROVIDER_PREFIX = "aswitch-";
const MARKER_COMMENT = "# --- A-SWITCH 托管区（由控制台写入；手改可能被下次注册覆盖）---";

const linkOf = (id) => CODEX_LINKS.find((l) => l.id === id) || null;
const codexProviderId = (linkId) => PROVIDER_PREFIX + linkId;
const isOurProvider = (id) => typeof id === "string" && id.startsWith(PROVIDER_PREFIX);

/** 链路 → Codex base_url（G1 只认这个函数的产出） */
function linkBaseUrl(link) {
  return link.via === "front"
    ? `http://${FRONT_HOST}:${FRONT_PORT}/${link.frontPath}/v1`
    : `http://${FRONT_HOST}:${link.port}/v1`;
}
const catalogPath = (cfgPath) => path.join(path.dirname(cfgPath), CATALOG_REL);
const managedTableName = (linkId) => `model_providers.${codexProviderId(linkId)}`;

// ------------------------------------------------------------------ TOML 子集
// 只做「行级定位 + 整块替换」：解析出顶层键/表头/表内键的行号范围，其余一律不解释。
// 于是注释、空行、缩进、键序、未知键……全留在 lines 里，写回时逐字节还原。
// 每次改动后 syncFrom() 重解析，行号永远新鲜（不做手写偏移量记账）。
const HEADER_RE = /^\s*(\[\[?)\s*([^\[\]]+?)\s*(\]\]?)\s*(#.*)?$/;
const KEY_RE = /^\s*([A-Za-z0-9_-]+|"[^"]*"|'[^']*')\s*=/;
const isMarker = (line) => /^\s*#\s*-{2,}\s*A-SWITCH/.test(line);

/** 从第 i 行（`key = ...`）开始，返回该键值结束的行号（含）：值可以是多行数组/多行串 */
function valueSpanEnd(lines, i) {
  let depth = 0, inStr = null, triple = false;
  for (let j = i; j < lines.length; j++) {
    const text = lines[j];
    for (let k = 0; k < text.length; k++) {
      const ch = text[k];
      if (inStr) {
        if (triple) { if (text.startsWith(inStr + inStr + inStr, k)) { inStr = null; triple = false; k += 2; } continue; }
        if (inStr === '"' && ch === "\\") { k++; continue; }
        if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === "#") break;
      if (ch === '"' || ch === "'") {
        if (text.startsWith(ch + ch + ch, k)) { inStr = ch; triple = true; k += 2; continue; }
        inStr = ch; continue;
      }
      if (ch === "[" || ch === "{") depth++;
      else if (ch === "]" || ch === "}") depth--;
    }
    if (!inStr && depth <= 0) return j;
  }
  return lines.length - 1;
}

function parseToml(text) {
  const eol = /\r\n/.test(text) ? "\r\n" : "\n";
  const bom = text.startsWith("\uFEFF");
  const lines = (bom ? text.slice(1) : text).split(eol);
  const tables = new Map();        // name -> { name, array, header, end, keys: Map(key -> {start,end}) }
  const arrayTables = new Set();
  const topKeys = new Map();
  const headers = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const h = HEADER_RE.exec(lines[i]);
    if (h) {
      const array = h[1] === "[[";
      const t = { name: h[2], array, header: i, end: lines.length, keys: new Map() };
      headers.push(t);
      if (array) arrayTables.add(t.name); else tables.set(t.name, t);
      cur = t;
      continue;
    }
    const m = KEY_RE.exec(lines[i]);
    if (!m) continue;
    const key = m[1].replace(/^["']|["']$/g, "");
    const span = { start: i, end: valueSpanEnd(lines, i) };
    if (cur) cur.keys.set(key, span); else topKeys.set(key, span);
    i = span.end;
  }
  for (let n = 0; n < headers.length; n++) headers[n].end = n + 1 < headers.length ? headers[n + 1].header : lines.length;
  return { eol, bom, lines, tables, topKeys, headers, arrayTables };
}

const serializeToml = (p) => (p.bom ? "\uFEFF" : "") + p.lines.join(p.eol);

/** 就地改动之后重新解析，刷新所有行号 */
function syncFrom(p) {
  const re = parseToml(serializeToml(p));
  Object.assign(p, re);
  return p;
}

/** 托管区行号集合：我们的 provider 表（含表头上一行的 A-SWITCH 标记注释）+ 托管顶层键 */
function managedSpans(p) {
  const spans = [];
  for (const t of p.tables.values()) {
    const bare = t.name.startsWith("model_providers.") ? t.name.slice("model_providers.".length) : "";
    if (!isOurProvider(bare)) continue;
    let start = t.header;
    if (start > 0 && isMarker(p.lines[start - 1])) start--;
    spans.push([start, t.end - 1]);
  }
  for (const k of MANAGED_TOP_KEYS) {
    const s = p.topKeys.get(k);
    if (s) spans.push([s.start, s.end]);
  }
  return spans;
}

/** 去掉托管区之后的残文：G2 就是比对这个字符串 */
function foreignText(p) {
  const spans = managedSpans(p).sort((a, b) => a[0] - b[0]);
  const out = [];
  let i = 0;
  for (const [s, e] of spans) {
    for (; i < Math.min(s, p.lines.length); i++) out.push(p.lines[i]);
    i = Math.max(i, e + 1);
  }
  for (; i < p.lines.length; i++) out.push(p.lines[i]);
  return out.join("\n");
}

function firstDiff(a, b) {
  const A = a.split("\n"), B = b.split("\n");
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    if (A[i] !== B[i]) return `第 ${i + 1} 处差异：写入前 ${JSON.stringify(A[i] ?? null)} / 写入后 ${JSON.stringify(B[i] ?? null)}`;
  }
  return "内容不同但找不到行级差异";
}

/**
 * 顶层键插入点：最后一个顶层键之后；没有则第一张表头之前；再没有就文件尾。
 * 「表头之前」还要躲开表头正上方的 A-SWITCH 标记注释——插到标记与表头之间会把标记
 * 从它守护的那张表上割开（空文件首次注册时就是这样），于是标记被算进托管区外的残文，
 * G2 立刻拦下自己。
 */
function topKeyInsertAt(p) {
  let at = -1;
  for (const s of p.topKeys.values()) at = Math.max(at, s.end + 1);
  if (at >= 0) return at;
  if (p.headers.length) {
    const h = p.headers[0].header;
    return h > 0 && isMarker(p.lines[h - 1]) ? h - 1 : h;
  }
  return p.lines.length;
}

function tomlLiteral(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  throw new Error(`不支持写入的 TOML 值类型：${typeof value}`);
}

/** 就地设置/替换一个顶层键（值跨多行时整段替换） */
function setTopKey(p, key, value) {
  const span = p.topKeys.get(key);
  const line = `${key} = ${tomlLiteral(value)}`;
  if (span) p.lines.splice(span.start, span.end - span.start + 1, line);
  else p.lines.splice(topKeyInsertAt(p), 0, line);
  return syncFrom(p);
}

/** 就地删除一个顶层键 */
function removeTopKey(p, key) {
  const span = p.topKeys.get(key);
  if (!span) return false;
  p.lines.splice(span.start, span.end - span.start + 1);
  syncFrom(p);
  return true;
}

/**
 * 就地写一个 provider 表：已存在的键就地改值，缺的键追加到表尾，**别人的键一个不删**；
 * 表不存在则在文件尾新建（带 A-SWITCH 标记注释）。
 */
function upsertProviderTable(p, linkId, entries) {
  const name = managedTableName(linkId);
  if (!p.tables.get(name)) {
    p.lines.push(MARKER_COMMENT, `[${name}]`, ...entries.map(([k, v]) => `${k} = ${tomlLiteral(v)}`));
    return syncFrom(p);
  }
  for (const [k, v] of entries) {
    const t = p.tables.get(name);
    const span = t.keys.get(k);
    const line = `${k} = ${tomlLiteral(v)}`;
    if (span) p.lines.splice(span.start, span.end - span.start + 1, line);
    else p.lines.splice(t.end, 0, line);
    syncFrom(p);
  }
  return p;
}

/** 就地删除一个 provider 表（连标记注释一起），返回是否删到了东西 */
function removeProviderTable(p, linkId) {
  const name = managedTableName(linkId);
  const t = p.tables.get(name);
  if (!t) return false;
  const start = t.header > 0 && isMarker(p.lines[t.header - 1]) ? t.header - 1 : t.header;
  p.lines.splice(start, t.end - start);
  syncFrom(p);
  return true;
}

const ourTables = (p) => [...p.tables.keys()]
  .filter((n) => n.startsWith("model_providers.") && isOurProvider(n.slice("model_providers.".length)));

/** 读一个顶层键的字面值（去引号；不解释复杂类型） */
function topValue(p, key) {
  const s = p.topKeys.get(key);
  if (!s) return null;
  const m = /=\s*(.*)$/.exec(p.lines[s.start]);
  if (!m) return null;
  return m[1].trim().replace(/^["']|["']$/g, "");
}

// ------------------------------------------------------------------ G1 形状闸门
const PRINTABLE = /^[\x20-\x7E]+$/;
const NO_SPACE = /^[\x21-\x7E]+$/;

/** 校验一条链路的注册参数；有问题就抛（调用方把消息显示给用户） */
function assertShape({ link, providerId, baseUrl, wireApi, token, model }) {
  const problems = [];
  if (!link) problems.push(`未知链路：${link?.id ?? "(空)"}`);
  if (!link || providerId !== codexProviderId(link.id)) problems.push(`providerId 必须是 aswitch-<已登记链路>`);
  if (!link || baseUrl !== linkBaseUrl(link)) problems.push(`base_url 必须是 ${link ? linkBaseUrl(link) : "已知链路的 http://127.0.0.1:<端口>/<前缀>/v1"}`);
  if (wireApi !== "responses") problems.push('wire_api 只能是 "responses"（Codex 0.100+ 已删除 chat）');
  if (typeof token !== "string" || !token || !PRINTABLE.test(token)) problems.push("api_key 必须是可打印 ASCII 的非空串");
  else if (/["\\]/.test(token)) problems.push("api_key 里不能有引号或反斜杠");
  else if (!NO_SPACE.test(token)) problems.push("api_key 里不能有空白字符");
  if (typeof model !== "string" || !model || !PRINTABLE.test(model)) problems.push("model 必须是可打印 ASCII 的非空串");
  else if (!NO_SPACE.test(model)) problems.push("model 里不能有空白字符（模型 id 不含空格）");
  if (problems.length) throw new Error("拒绝注册 Codex 供应商（" + problems.join("；") + "）");
}

// ------------------------------------------------------------------ G2/G3/G4 写入
function assertForeignUnchanged(prevText, nextText) {
  const a = foreignText(parseToml(prevText));
  const b = foreignText(parseToml(nextText));
  if (a !== b) throw new Error("拒绝写入 Codex 配置：托管区之外的内容发生了变化（" + firstDiff(a, b) + "）");
}

/**
 * 写 config.toml：G2（托管区外逐字节不变）→ 备份 → 原子写 → G4 读回（失败回滚）。
 * verify(parsed) 由调用方给，返回问题数组；非空即视为读回失败。
 */
function writeCodexConfig(cfgPath, nextText, prevText, { verify } = {}) {
  assertForeignUnchanged(prevText, nextText);
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  const existed = fs.existsSync(cfgPath);
  let backup = null;
  if (existed) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    backup = `${cfgPath}.bak-${stamp}`;
    fs.copyFileSync(cfgPath, backup);
  }
  const tmp = `${cfgPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, nextText);
  fs.renameSync(tmp, cfgPath);
  try {
    const back = parseToml(fs.readFileSync(cfgPath, "utf8"));
    const problems = verify ? verify(back) : [];
    if (problems.length) throw new Error(problems.join("；"));
  } catch (err) {
    if (backup) fs.copyFileSync(backup, cfgPath); else fs.rmSync(cfgPath, { force: true });
    throw new Error(`写入后读回校验失败，已回滚${backup ? `到 ${path.basename(backup)}` : "（删除新文件）"}：${err.message}`);
  }
  return { backup, existed };
}

// ------------------------------------------------------------------ 状态快照
function readState(statePath) {
  try { return JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { return null; }
}
function writeState(statePath, obj) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(obj, null, 1), { mode: 0o600 });
}

/** 快照托管顶层键的原文（值可能跨行，整段存） */
const snapshotTopKeys = (p) => Object.fromEntries(MANAGED_TOP_KEYS.map((k) => {
  const s = p.topKeys.get(k);
  return [k, s ? { present: true, text: p.lines.slice(s.start, s.end + 1) } : { present: false }];
}));

/** 还原一个顶层键：快照里原来有的按原文写回，原来没有的删掉；快照缺失一律当"没有" */
function restoreTopKey(p, key, snapshot) {
  const snap = snapshot?.[key];
  if (snap && snap.present && Array.isArray(snap.text)) {
    const s = p.topKeys.get(key);
    if (s) p.lines.splice(s.start, s.end - s.start + 1, ...snap.text);
    else p.lines.splice(topKeyInsertAt(p), 0, ...snap.text);
  } else {
    removeTopKey(p, key);
  }
  return syncFrom(p);
}

/** 还原全部托管顶层键 */
function restoreTopKeys(p, snapshot) {
  for (const k of MANAGED_TOP_KEYS) restoreTopKey(p, k, snapshot);
  return p;
}

// ------------------------------------------------------------------ 目录（model_catalog_json）
// 11 个必填字段的最小模板：探针逐条补出来的（missing field 报错驱动），
// 与「未知模型回退元数据」产出同一套 shell-only 工具面。
const BASE_INSTRUCTIONS = [
  "You are a coding agent working on the user's machine.",
  "Use the shell tool to inspect and modify files; quote paths; verify before destructive commands.",
].join("\n");
const REASONING_LEVELS = [
  { effort: "low", description: "Fast responses with lighter reasoning" },
  { effort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
  { effort: "high", description: "Greater reasoning depth for complex problems" },
];

function catalogEntry(slug, { displayName, description, contextWindow, vision, priority } = {}) {
  const label = displayName || slug;
  const e = {
    slug,
    display_name: label,
    description: description || `${label}（经 A-SWITCH 本地网关转发）`,
    base_instructions: BASE_INSTRUCTIONS,
    supported_reasoning_levels: REASONING_LEVELS,
    shell_type: "unified_exec",     // 0.160.1 把 shell_command 也解析成它；官方 11 条全是这个
    visibility: "list",
    supported_in_api: true,
    priority: typeof priority === "number" ? priority : 50,
    support_verbosity: false,
    truncation_policy: { mode: "tokens", limit: 10000 },
    experimental_supported_tools: [],
    input_modalities: vision ? ["text", "image"] : ["text"],
  };
  if (contextWindow) {
    e.context_window = contextWindow;
    e.effective_context_window_percent = 95;
  }
  return e;
}

/**
 * 目录文本：自带条目（`codex debug models --bundled` 的原样克隆）+ 我方条目。
 * 必须带上自带条目——自定义目录是整体替换而非合并（0.160.1 实测）。
 * slug 撞车时保留自带条目（官方元数据更准），记进 skipped。
 * ensureModel：当前要写进顶层 model 的那个 slug 一定要在目录里——不在的话 Codex 会打
 * 「Model metadata not found，回退元数据」并丢掉窗口/推理档位（实测 0.160.1），
 * 所以给它补一条合成条目（走同一套模板与窗口声明）。
 */
function buildCatalog({ bundled = [], models = [], ensureModel = null } = {}) {
  const have = new Set(bundled.map((m) => m && m.slug).filter(Boolean));
  const skipped = [];
  const ours = [];
  models.forEach((m, i) => {
    if (!m || !m.slug) return;
    if (have.has(m.slug)) { skipped.push(m.slug); return; }
    have.add(m.slug);
    ours.push(catalogEntry(m.slug, { ...m, priority: m.priority ?? 50 + i }));
  });
  const ensured = [];
  if (ensureModel && !have.has(ensureModel)) {
    have.add(ensureModel);
    ours.push(catalogEntry(ensureModel, { displayName: ensureModel, priority: 50 + ours.length }));
    ensured.push(ensureModel);
  }
  return {
    text: JSON.stringify({ models: [...bundled, ...ours] }),
    count: bundled.length + ours.length, bundled: bundled.length, ours: ours.length,
    skipped, slugs: ours.map((m) => m.slug), ensured,
  };
}

/**
 * 从实时目录里挑一个对得上的模型 id：优先同名，其次按 `:` 分段的后缀相同
 * （wb2api 报的是 cn:glm-5.3，而我们表里想写 glm-5.3；写全名才能进目录拿到元数据）。
 * 都对不上就把想要的照原样还回去（上游也许按别名接受，由调用方给告警）。
 */
function pickModel(desired, liveIds = []) {
  const want = String(desired || "").trim();
  const ids = (liveIds || []).filter((x) => typeof x === "string" && x);
  if (!want || !ids.length || ids.includes(want)) return want;
  const tail = (s) => String(s).split(":").pop();
  return ids.find((id) => tail(id) === want)
    || ids.find((id) => tail(id).toLowerCase() === want.toLowerCase())
    || want;
}

/**
 * 刷新目录文件。bundled 由调用方用 `codex debug models --bundled` 取（离线、不需要登录）；
 * 取不到就沿用旧目录里"不是我方条目"的那些（就是上次克隆进来的自带条目）。
 * prevOurs = 上次生成时记下的我方 slug（state.catalogOurs）——按 slug 记名精确剔除；
 * 没有它就只能拿本次模型表当名单，撞 slug 的自带条目会被误剔（兜底路径，宁可重生成）。
 */
function refreshCatalog(cfgPath, models, { bundled = null, prevOurs = null, ensureModel = null } = {}) {
  const file = catalogPath(cfgPath);
  let base = bundled;
  if (!base) {
    base = [];
    if (fs.existsSync(file)) {
      try {
        const old = JSON.parse(fs.readFileSync(file, "utf8")).models || [];
        const ours = new Set(Array.isArray(prevOurs) ? prevOurs : (models || []).map((m) => m && m.slug));
        base = old.filter((m) => m && !ours.has(m.slug));
      } catch { base = []; }
    }
  }
  const { text, count, ours, skipped, slugs, ensured } = buildCatalog({ bundled: base, models, ensureModel });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text + "\n");
  return { path: file, rel: CATALOG_REL, count, ours, bundled: base.length, skipped, slugs, ensured };
}

/** 目录现状（体检用） */
function catalogSummary(cfgPath) {
  const file = catalogPath(cfgPath);
  if (!fs.existsSync(file)) return { path: file, exists: false };
  try {
    const models = JSON.parse(fs.readFileSync(file, "utf8")).models || [];
    return { path: file, exists: true, entries: models.length, slugs: models.map((m) => m && m.slug).filter(Boolean) };
  } catch (e) { return { path: file, exists: true, error: String((e && e.message) || e) }; }
}

// ------------------------------------------------------------------ 注册 / 激活 / 摘除
/**
 * 注册并设为当前：写 provider 表 + 顶层指针（+ 目录）。
 *   ① /model 菜单不热加载：注册后要新开 Codex 进程才刷新（0.160.1 实测）。
 *   ② 旧顶层值只在「当前不是我们」时快照一次：A→B 切换不该把 A 的值当原始值。
 *   ③ 可选键（模型窗口/自动压缩阈值）只在给值时写，写过就记进 writtenKeys，
 *      下次不给则撤掉并还原用户原值——绝不悄悄删用户自己的设置。
 */
function activate(cfgPath, { linkId, model, token, statePath, writeCatalog = true, catalogModels = [], bundled = null, contextWindow, autoCompactLimit } = {}) {
  const link = linkOf(linkId);
  const providerId = codexProviderId(linkId);
  const baseUrl = link ? linkBaseUrl(link) : "";
  const useModel = model || (link ? link.model : "");
  assertShape({ link, providerId, baseUrl, wireApi: "responses", token, model: useModel });

  const prevText = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, "utf8") : "";
  const p = parseToml(prevText);
  const state = readState(statePath);
  const current = topValue(p, "model_provider");
  const snapshot = isOurProvider(current) && state?.topKeys ? state.topKeys : snapshotTopKeys(p);
  const writtenKeys = new Set((isOurProvider(current) && Array.isArray(state?.writtenKeys)) ? state.writtenKeys : []);

  upsertProviderTable(p, linkId, [
    ["name", `A-SWITCH ${link.label}`],
    ["base_url", baseUrl],
    ["wire_api", "responses"],
    ["experimental_bearer_token", token],
  ]);
  setTopKey(p, "model_provider", providerId);
  setTopKey(p, "model", useModel);
  let catalog = null;
  if (writeCatalog) {
    catalog = refreshCatalog(cfgPath, catalogModels, { bundled, prevOurs: state?.catalogOurs, ensureModel: useModel });
    setTopKey(p, "model_catalog_json", CATALOG_REL);
  } else if (writtenKeys.has("model_catalog_json") || topValue(p, "model_catalog_json") === CATALOG_REL) {
    restoreTopKey(p, "model_catalog_json", snapshot);
  }
  // 可选键：给值才写；写过又不要了就还原——用户原本有值的还原原值，原本没有的删干净。
  // 绝不"删掉用户自己的 model_context_window"。
  const optional = { model_context_window: contextWindow, model_auto_compact_token_limit: autoCompactLimit };
  for (const [k, v] of Object.entries(optional)) {
    if (v) { setTopKey(p, k, v); writtenKeys.add(k); }
    else if (writtenKeys.has(k)) { restoreTopKey(p, k, snapshot); writtenKeys.delete(k); }
  }

  const nextText = serializeToml(p);
  const { backup } = writeCodexConfig(cfgPath, nextText, prevText, {
    verify: (back) => {
      const problems = [];
      const t = back.tables.get(managedTableName(linkId));
      if (!t) problems.push("读回后找不到我们的 provider 表");
      else {
        const val = (k) => {
          const s = t.keys.get(k);
          return s ? /=\s*(.*)$/.exec(back.lines[s.start])?.[1].trim() : null;
        };
        if (val("base_url") !== JSON.stringify(baseUrl)) problems.push("读回后 base_url 不对");
        if (val("wire_api") !== JSON.stringify("responses")) problems.push("读回后 wire_api 不对");
        if (val("experimental_bearer_token") !== JSON.stringify(token)) problems.push("读回后凭据不对");
      }
      if (topValue(back, "model_provider") !== providerId) problems.push("读回后 model_provider 没指向我们");
      if (writeCatalog && topValue(back, "model_catalog_json") !== CATALOG_REL) problems.push("读回后 model_catalog_json 没指向我们的目录");
      return problems;
    },
  });

  writeState(statePath, {
    version: 1,
    providerId,
    providerIds: ourTables(p).map((n) => n.slice("model_providers.".length)),
    topKeys: snapshot,
    writtenKeys: [...writtenKeys],
    catalogRel: writeCatalog ? CATALOG_REL : null,
    catalogOurs: catalog ? catalog.slugs : (state?.catalogOurs || []),
    updatedAt: new Date().toISOString(),
  });
  return {
    ok: true, providerId, baseUrl, model: useModel, backup, catalog,
    contextWindow: contextWindow || null, activeLinks: ourTables(p).map((n) => n.slice("model_providers.".length)),
  };
}

/** 摘除：删表；若它是当前供应商，把顶层键还原成激活前的样子；我们的表全没了就清掉目录 */
function deregister(cfgPath, { linkId, statePath, keepCatalog = false } = {}) {
  const providerId = codexProviderId(linkId);
  const prevText = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, "utf8") : "";
  if (!prevText) return { ok: true, changed: false, reason: "config.toml 不存在" };
  const p = parseToml(prevText);
  const state = readState(statePath);
  const removedTable = removeProviderTable(p, linkId);
  const current = topValue(p, "model_provider");
  const restored = current === providerId;
  if (restored) restoreTopKeys(p, state?.topKeys);
  const left = ourTables(p);
  let catalogRemoved = false;
  if (!left.length && !keepCatalog) {
    if (topValue(p, "model_catalog_json") === CATALOG_REL) { removeTopKey(p, "model_catalog_json"); }
    const file = catalogPath(cfgPath);
    if (fs.existsSync(file)) { fs.rmSync(file, { force: true }); catalogRemoved = true; }
    writeState(statePath, { ...(state || {}), providerIds: [], catalogRel: null, catalogOurs: [], writtenKeys: [], updatedAt: new Date().toISOString() });
  } else if (state) {
    writeState(statePath, { ...state, providerIds: left.map((n) => n.slice("model_providers.".length)), updatedAt: new Date().toISOString() });
  }
  if (!removedTable && !restored && !catalogRemoved) return { ok: true, changed: false, reason: "没有我们的痕迹" };
  const { backup } = writeCodexConfig(cfgPath, serializeToml(p), prevText, {
    verify: (back) => {
      const problems = [];
      if (back.tables.get(managedTableName(linkId))) problems.push("读回后我们的 provider 表还在");
      if (restored && topValue(back, "model_provider") === providerId) problems.push("读回后顶层键没还原");
      return problems;
    },
  });
  return { ok: true, changed: true, restored, catalogRemoved, remaining: left.length, backup };
}

// ------------------------------------------------------------------ G5 只读体检
function readProviderTable(p, linkId) {
  const t = p.tables.get(managedTableName(linkId));
  if (!t) return null;
  const val = (k) => {
    const s = t.keys.get(k);
    return s ? (/=\s*(.*)$/.exec(p.lines[s.start])?.[1] || "").trim().replace(/^["']|["']$/g, "") : null;
  };
  return {
    providerId: codexProviderId(linkId), name: val("name"), base_url: val("base_url"),
    wire_api: val("wire_api"), hasToken: !!val("experimental_bearer_token"), extraKeys: [...t.keys.keys()].filter((k) => !["name", "base_url", "wire_api", "experimental_bearer_token"].includes(k)),
  };
}

/**
 * 只读体检：config.toml 能否解析、我们的表在不在且形状对、顶层指针指向谁、目录覆盖了哪些模型。
 * **不回显凭据**：只报告 hasToken。
 * bundledSlugs 传 `codex debug models --bundled` 的 slug 列表 → 报告目录是否把官方模型挤掉了。
 */
function checkCodexConfig(cfgPath, { bundledSlugs = null } = {}) {
  const out = { ok: false, path: cfgPath, exists: fs.existsSync(cfgPath), problems: [], warnings: [] };
  if (!out.exists) { out.problems.push("config.toml 不存在（还没注册过 Codex）"); return out; }
  let text = "";
  try { text = fs.readFileSync(cfgPath, "utf8"); } catch (e) { out.problems.push(`读文件失败：${e.message}`); return out; }
  const p = parseToml(text);
  out.eol = p.eol === "\r\n" ? "CRLF" : "LF";
  out.bom = p.bom;
  out.arrayTables = [...p.arrayTables];
  out.foreignTables = [...p.tables.keys()].filter((n) => !(n.startsWith("model_providers.") && isOurProvider(n.slice("model_providers.".length))));
  out.foreignTopKeys = [...p.topKeys.keys()].filter((k) => !MANAGED_TOP_KEYS.includes(k));
  out.current = Object.fromEntries(["model_provider", "model", "model_catalog_json", "model_context_window", "model_auto_compact_token_limit"]
    .map((k) => [k, topValue(p, k)]));
  out.providers = CODEX_LINKS.map((l) => readProviderTable(p, l.id)).filter(Boolean);
  for (const t of out.providers) {
    const link = linkOf(t.providerId.slice(PROVIDER_PREFIX.length));
    if (t.wire_api !== "responses") out.problems.push(`${t.providerId} 的 wire_api=${t.wire_api}（Codex 只认 responses）`);
    if (t.base_url !== linkBaseUrl(link)) out.problems.push(`${t.providerId} 的 base_url=${t.base_url}（应为 ${linkBaseUrl(link)}）`);
    if (!t.hasToken) out.problems.push(`${t.providerId} 缺 experimental_bearer_token`);
  }
  if (out.current.model_provider && !out.providers.some((t) => t.providerId === out.current.model_provider)) {
    out.warnings.push(`当前 model_provider=${out.current.model_provider} 不是 A-SWITCH 注册的（Codex 现在走别的供应商）`);
  }
  const cat = catalogSummary(cfgPath);
  out.catalog = cat;
  if (cat.exists && cat.error) out.problems.push(`目录文件解析失败：${cat.error}`);
  if (cat.exists && Array.isArray(cat.slugs) && Array.isArray(bundledSlugs) && bundledSlugs.length) {
    const missing = bundledSlugs.filter((s) => !cat.slugs.includes(s));
    out.catalog.missingBundled = missing;
    if (missing.length) out.warnings.push(`目录里缺 ${missing.length} 个自带模型（${missing.slice(0, 3).join("、")}…）：自定义目录是整体替换，缺了它们官方模型会从选择器里消失`);
  }
  out.ok = out.problems.length === 0;
  return out;
}

module.exports = {
  CODEX_LINKS, MANAGED_TOP_KEYS, OPTIONAL_TOP_KEYS, CATALOG_REL, FRONT_PORT, PROVIDER_PREFIX, MARKER_COMMENT,
  linkOf, codexProviderId, linkBaseUrl, catalogPath, managedTableName, isOurProvider,
  parseToml, serializeToml, syncFrom, managedSpans, foreignText, topValue, setTopKey, removeTopKey,
  upsertProviderTable, removeProviderTable, ourTables,
  assertShape, assertForeignUnchanged, writeCodexConfig, snapshotTopKeys, restoreTopKey, restoreTopKeys, readState, writeState,
  catalogEntry, buildCatalog, refreshCatalog, catalogSummary, pickModel, activate, deregister, checkCodexConfig,
};
