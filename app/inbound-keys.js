"use strict";
/**
 * 入站 api_key 的生成与存档（纯 Node，回归测试见 app/test_inbound_keys.js）。
 *
 * 语义（2026-10-11 起控制台「生成」按钮）：
 *  - 「生成」是加钥不是废钥：每条链路的有效钥匙 = 内置兜底钥 ∪ env 轮换钥 ∪
 *    本档案里的生成钥。内置钥是 relay 源码里的常量，控制台废不掉它；生成后
 *    ZCode 注册值切到新钥，内置钥自动退居「备」（仍可用，闸门语义如此）。
 *  - 档案固定落在 ~/.autoclaw-relay/inbound-keys.json（0600，runtime 数据不进
 *    仓库）。四条 env 型 relay（autoclaw/trae/doubao/comate）启动时读它并把
 *    本链路钥并进 INBOUND_KEYS——所以生成后必须重启对应 relay 才生效，控制台
 *    在跑着的话自动停-起；手动启动的 relay 重启后同样吃进新钥。
 *  - workbuddy / qoder / qwenwork 不走本档案：前者改 wb2api 的 config.json
 *    api_key，后两者是网关侧出口 Key（qoder-realm-keys.json，见 main.js
 *    qoderEnsureRealmKeys），由既有流程管理；PREFIX 里仍给它们留了前缀，
 *    这样控制台生成的随机钥一眼能看出归属。
 *
 * 标准钥（别名）映射（2026-10-11 起控制台「sk 钥」按钮）：
 *  - 给只认 sk- 开头钥匙的标准工具（DeepSeek Harness、Codex、OpenAI SDK 系）
 *    备的旁路钥匙：档案里以顶层保留键 _aliases 存放 `{ "<linkId>": ["sk-…"] }`，
 *    relay 启动时把「本链路主钥 ∪ 本链路别名」一并吃进闸门集合。别名只影响
 *    入站闸门，不改 ZCode 注册值（ZCode 侧仍用主钥），因此加删别名不必重注册，
 *    但要求对应 relay 重启一次（闸门集合在启动时构造）。
 *  - 格式：sk-<平台前缀>-<36 位 hex>；也允许直接填用户自己的 sk-xxx 自定义钥
 *    （只要形状合法）。别名可移除（撤销），主钥与内置兜底钥不受影响。
 *  - 旧档案（无 _aliases 的扁平格式）完全兼容：readStore 忽略保留键，
 *    writeStore 原样保留 _aliases，readAliases 读不到就是空映射。
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// 内置兜底钥必须与各 relay 源码里的常量逐字一致（test_inbound_keys.js 有防漂移断言）
const BUILTIN = {
  autoclaw: "autoclaw-local",
  workbuddy: "wb-local-key",
  trae: "trae-local-key",
  doubao: "doubao-local-key",
  comate: "comate-local",
  qoder: "qoder-local",
  qwenwork: "qwenwork-local",
};

// 生成钥前缀：与 qoder 出口 Key 的 qd- 风格一致，一眼看出出自哪条链路
const PREFIX = { autoclaw: "ac", workbuddy: "wb", trae: "tr", doubao: "db", comate: "cm", qoder: "qd", qwenwork: "qw" };

// 本档案只管 env 型四条链路；其余链路的生成走各自部件（见文件头）
const STORE_LINKS = ["autoclaw", "trae", "doubao", "comate"];

// 顶层保留键：标准钥（别名）映射表，形状 { "<linkId>": [key, ...] }。
// 放在保留键下而不是混进扁平主钥里，旧读取方（readStore / relay 的扁平读法）
// 完全不受影响。
const ALIASES_FIELD = "_aliases";

const storePath = (homeDir) => path.join(homeDir, ".autoclaw-relay", "inbound-keys.json");

/** 随机钥：前缀 + 密码学随机 18 字节 hex（36 位，与 qoder 出口 Key 同规格） */
function generateKey(linkId) {
  const prefix = PREFIX[linkId] || "ik";
  return `${prefix}-${crypto.randomBytes(18).toString("hex")}`;
}

/** 标准钥：sk- 前缀版（给 dsh / Codex / OpenAI SDK 这类只认 sk- 的工具用） */
function generateStandardKey(linkId) {
  const prefix = PREFIX[linkId] || "ik";
  return `sk-${prefix}-${crypto.randomBytes(18).toString("hex")}`;
}

/** 形状校验：可打印 ASCII 且无空白、4..128 字符——header/env/JSON 三处都不会被截断 */
function validKey(value) {
  return typeof value === "string" && /^[\x21-\x7e]{4,128}$/.test(value);
}

/** 宽容读原始 JSON 对象（保留 _aliases 等非主钥字段时用）；坏形状一律当空对象 */
function readRaw(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}

/** 原子写（tmp+rename，0600）。runtime 数据，绝不进仓库 */
function writeRaw(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * 读档案：缺失 / 坏 JSON / 非对象 → {}；只保留「非空 + 形状合法」的字符串值；
 * 顶层保留键（_aliases）不是主钥，跳过。
 * 宽容读、严格写：手改坏的档案不该把坏钥带进控制台的口径。
 */
function readStore(file) {
  const raw = readRaw(file);
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === ALIASES_FIELD) continue;
    const s = typeof v === "string" ? v.trim() : "";
    if (validKey(s)) out[k] = s;
  }
  return out;
}

/**
 * 原子写档案（tmp+rename，0600）。主钥为覆盖写（旧主钥清掉，语义同从前），
 * 但 _aliases 是别名通道的数据，不归本函数管，原样保留，否则「生成主钥」
 * 会把已配置的标准钥悄悄抹掉。
 */
function writeStore(file, store) {
  const raw = readRaw(file);
  const next = {};
  if (raw[ALIASES_FIELD]) next[ALIASES_FIELD] = raw[ALIASES_FIELD];
  for (const [k, v] of Object.entries(store)) {
    if (k === ALIASES_FIELD) continue;
    const s = typeof v === "string" ? v.trim() : "";
    if (validKey(s)) next[k] = s;
  }
  writeRaw(file, next);
}

/** 本链路档案里的生成钥；没生成过返回空串（调用方回退 BUILTIN） */
function activeKey(store, linkId) {
  return (store && store[linkId]) || "";
}

/**
 * 读标准钥（别名）映射：`{ "<linkId>": [key, ...] }`。
 * 宽容读：坏形状（非数组 / 非字符串项 / 不合法钥）一律丢掉，值去重。
 */
function readAliases(file) {
  const raw = readRaw(file)[ALIASES_FIELD];
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [linkId, list] of Object.entries(raw)) {
    if (!Array.isArray(list)) continue;
    const keys = [...new Set(list.map((k) => (typeof k === "string" ? k.trim() : "")).filter(validKey))];
    if (keys.length) out[linkId] = keys;
  }
  return out;
}

/** 加一把标准钥（同值幂等）；返回 { ok, key, aliases }，aliases 为该链路最新列表 */
function addAlias(file, linkId, key) {
  const s = typeof key === "string" ? key.trim() : "";
  if (!validKey(s)) return { ok: false, error: "钥匙形状不合法：可打印 ASCII、无空白、4..128 字符" };
  const raw = readRaw(file);
  const all = readAliases(file);
  all[linkId] = [...new Set([...(all[linkId] || []), s])];
  raw[ALIASES_FIELD] = all;
  writeRaw(file, raw);
  return { ok: true, key: s, aliases: all[linkId] };
}

/** 移除一把标准钥（撤销）；返回 { ok, removed, aliases } */
function removeAlias(file, linkId, key) {
  const s = typeof key === "string" ? key.trim() : "";
  const raw = readRaw(file);
  const all = readAliases(file);
  const before = all[linkId] || [];
  const rest = before.filter((k) => k !== s);
  if (rest.length) all[linkId] = rest; else delete all[linkId];
  if (Object.keys(all).length) raw[ALIASES_FIELD] = all; else delete raw[ALIASES_FIELD];
  writeRaw(file, raw);
  return { ok: true, removed: before.length - rest.length, aliases: rest };
}

module.exports = { BUILTIN, PREFIX, STORE_LINKS, ALIASES_FIELD, storePath, generateKey, generateStandardKey,
  validKey, readStore, writeStore, activeKey, readAliases, addAlias, removeAlias };
