"use strict";
/**
 * ZCode 供应商配置的读写工具（纯 Node，无 Electron 依赖）。
 *
 * 单独成模块的原因：这段逻辑曾经内嵌在 Electron 主进程里，导致它只能在真实点击
 * “一键注册”时才会跑、也无法写回归测试——而正是这段逻辑把用户的配置改坏过
 * （写入了非法 api.type、并丢掉了 manualProviderModelRules 字段）。放到这里之后
 * 可以用 `node app/test_zcode_config.js` 针对合成 fixture 做沙箱重放。
 *
 * 铁律：provider_config.json 由 ZCode 自己拥有，我们只被允许增量修改自己注册的
 * 供应商。任何“整体重建文件”的写法都是错的，一律走 writeZcodeConfig 的四道闸门。
 */
const fs = require("fs");
const path = require("path");

// ZCode 供应商 api.type 的合法取值，取自 ZCode 自己的代码而非记忆：
// resources/glm/zcode.cjs 里 createProvider 的 switch 只有三个分支
// （anthropic-messages → kind "anthropic"、openai-responses → kind "openai"、
//   openai-chat-completions → kind "openai-compatible"），其余一律
// throw `Unsupported Provider API type: <值>`；resources/config/provider/zcode-builtin.json
// 中出现的也只有这三个。**陷阱**：字符串 "openai-compatible" 在 ZCode 代码里到处都是，
// 但它是映射后的内部 kind，不是合法的配置值——写进去会让整个供应商加载失败。
const ZCODE_API = {
  ANTHROPIC: "anthropic-messages",
  OPENAI_RESPONSES: "openai-responses",
  OPENAI_CHAT: "openai-chat-completions",
};
const ZCODE_API_TYPES = Object.values(ZCODE_API);

function readConfig(cfgPath) {
  return JSON.parse(fs.readFileSync(cfgPath, "utf8"));
}

/** 数组成员的身份：供应商用 providerId，模型条目用 providerId/modelId，其余退化为 id */
function elementId(el) {
  if (!el || typeof el !== "object") return null;
  if (el.providerId != null) return el.modelId != null ? `${el.providerId}/${el.modelId}` : String(el.providerId);
  if (el.id != null) return String(el.id);
  if (el.modelId != null) return String(el.modelId);
  return null;
}

/** 收集对象的结构路径（对象按键展开；数组按元素身份而非下标展开），用于“写入前后不得丢结构”的断言 */
function structurePaths(value, prefix = "", out = new Set()) {
  if (Array.isArray(value)) {
    for (const el of value) {
      const id = elementId(el);
      if (id != null) structurePaths(el, `${prefix}[${id}]`, out);
    }
    return out;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      const p = prefix ? `${prefix}.${k}` : k;
      out.add(p);
      structurePaths(v, p, out);
    }
  }
  return out;
}

/**
 * 写入 ZCode 供应商配置。四道闸门，任何一道不过就拒绝落盘
 * （宁可注册失败，也不能让客户端拿到坏配置）：
 *   ① 枚举：所有供应商的 api.type 必须是 ZCODE_API_TYPES 之一；
 *   ② 结构：写入前后不得丢失任何既有结构路径，白名单外一律视为回归；
 *   ③ 原子：先写临时文件再 rename，避免客户端每 60 秒的轮询读到半截文件；
 *   ④ 读回：写完重新解析校验，失败立即回滚到备份。
 */
function writeZcodeConfig(cfgPath, next, prevRaw, { allowRemovedPaths = [] } = {}) {
  const problems = [];
  for (const rule of next?.config?.providerConfigRules?.providerRules || []) {
    const t = rule?.config?.api?.type;
    if (t !== undefined && !ZCODE_API_TYPES.includes(t)) {
      problems.push(`${rule.providerId} 的 api.type="${t}" 不是合法枚举（合法值：${ZCODE_API_TYPES.join(" / ")}）`);
    }
  }
  let prev = null;
  try { prev = JSON.parse(prevRaw); } catch { problems.push("写入前的配置文件本身无法解析，拒绝覆盖"); }
  if (prev) {
    const before = structurePaths(prev);
    const after = structurePaths(next);
    const allow = allowRemovedPaths;
    const lost = [...before].filter((p) => !after.has(p) && !allow.some((a) => p.startsWith(a)));
    if (lost.length) problems.push(`写入会丢失既有结构：${lost.slice(0, 5).join("、")}${lost.length > 5 ? ` 等 ${lost.length} 处` : ""}`);
  }
  if (problems.length) throw new Error("拒绝写入 ZCode 配置（" + problems.join("；") + "）");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backup = `${cfgPath}.bak-${stamp}`;
  fs.copyFileSync(cfgPath, backup);
  const tmp = `${cfgPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, cfgPath);
  try {
    const back = readConfig(cfgPath);
    for (const rule of back?.config?.providerConfigRules?.providerRules || []) {
      const t = rule?.config?.api?.type;
      if (t !== undefined && !ZCODE_API_TYPES.includes(t)) throw new Error(`${rule.providerId} 的 api.type 读回后非法`);
    }
  } catch (err) {
    fs.copyFileSync(backup, cfgPath);   // 回滚，绝不留下坏配置
    throw new Error(`写入后读回校验失败，已回滚到 ${path.basename(backup)}：${err.message}`);
  }
  return backup;
}

/** 注册/更新一个供应商规则：逐层合并，保留我们不管的既有子键（如 modelOrder、templateId） */
function upsertProviderRule(rules, rule) {
  const i = rules.findIndex((r) => r.providerId === rule.providerId);
  if (i === -1) { rules.push(rule); return rules; }
  const prev = rules[i] || {};
  rules[i] = {
    ...prev, ...rule,
    config: {
      ...prev.config, ...rule.config,
      access: { ...prev.config?.access, ...rule.config?.access },
      api: { ...prev.config?.api, ...rule.config?.api },
    },
  };
  return rules;
}

// 注册流程从网关目录里唯一有权刷新的属性：上下文长度。
// 其余属性（supportsImage/supportsPdf…）一旦存在就视为声明，保留既有值——
// 否则每次点“一键注册”，调用方填的默认值都会把人工修正过的能力声明抹掉。
const OWNED_PROPERTY_KEYS = ["contextWindow"];

/**
 * 注册/更新一个供应商的模型条目：条目按原位置整块替换，但每个模型既有的属性声明保留。
 * 就地生效（与 upsertProviderRule 一致）并返回同一个数组——2026-10-05 踩过：早先版本
 * 返回新数组，而三处调用方都没接返回值，结果 personalModelIds 从 12 涨到 27、模型条目
 * 却一条没加，ZCode 里看不到新模型。
 */
function upsertModelEntries(entries, providerId, newEntries) {
  const prevByModel = new Map(entries.filter((x) => x.providerId === providerId).map((x) => [x.modelId, x]));
  const merged = newEntries.map((e) => {
    const old = prevByModel.get(e.modelId);
    if (!old) return e;
    const props = { ...old.config?.properties };
    for (const k of OWNED_PROPERTY_KEYS) {
      if (e.config?.properties?.[k] !== undefined) props[k] = e.config.properties[k];
    }
    return { ...old, ...e, config: { ...old.config, ...e.config, properties: props } };
  });
  const first = entries.findIndex((x) => x.providerId === providerId);
  const rest = entries.filter((x) => x.providerId !== providerId);
  const next = first === -1
    ? [...rest, ...merged]
    : [...rest.slice(0, entries.slice(0, first).filter((x) => x.providerId !== providerId).length),
       ...merged,
       ...rest.slice(entries.slice(0, first).filter((x) => x.providerId !== providerId).length)];
  entries.length = 0;
  entries.push(...next);
  return entries;
}

/**
 * 注销供应商：从 providerRules / providerModelRules / providerOrder 三处摘除。
 * 只允许对"自己注册的供应商"调用（调用方负责核对 providerId 归属）；
 * 结构不丢断言由 writeZcodeConfig 的 allowRemovedPaths 白名单兜底——
 * 调用方必须用 removedProviderAllowPaths() 生成放行前缀，缺了会被闸门整单拒绝。
 * 就地修改 cfg 并返回实际摘除数量（供调用方判断"本来就不存在则免写盘"）。
 */
function removeProviders(cfg, providerIds) {
  const ids = new Set(providerIds);
  const conf = cfg.config || {};
  let removed = 0;
  const rules = conf.providerConfigRules?.providerRules;
  if (Array.isArray(rules)) {
    const next = rules.filter((r) => !ids.has(r?.providerId));
    removed += rules.length - next.length;
    rules.length = 0;
    rules.push(...next);
  }
  const entries = conf.modelConfigRules?.providerModelRules;
  if (Array.isArray(entries)) {
    const next = entries.filter((e) => !ids.has(e?.providerId));
    removed += entries.length - next.length;
    entries.length = 0;
    entries.push(...next);
  }
  const order = conf.providerOrder;
  if (Array.isArray(order)) {
    const next = order.filter((p) => !ids.has(p));
    removed += order.length - next.length;
    order.length = 0;
    order.push(...next);
  }
  return removed;
}

/** 注销时的结构放行前缀：providerRules 与 providerModelRules 两处、[pid] 与 [pid/ 两种元素路径形态 */
function removedProviderAllowPaths(providerIds) {
  return providerIds.flatMap((p) => [
    `config.providerConfigRules.providerRules[${p}]`,
    `config.providerConfigRules.providerRules[${p}/`,
    `config.modelConfigRules.providerModelRules[${p}]`,
    `config.modelConfigRules.providerModelRules[${p}/`,
  ]);
}

/** 只读体检：报告配置里所有供应商的 api.type 是否合法、结构是否完整（不写文件） */
function checkZcodeConfig(cfgPath) {  const cfg = readConfig(cfgPath);
  const conf = cfg.config || {};
  const rules = conf.providerConfigRules?.providerRules || [];
  const illegal = rules.filter((r) => r.config?.api?.type && !ZCODE_API_TYPES.includes(r.config.api.type))
    .map((r) => ({ providerId: r.providerId, apiType: r.config.api.type }));
  const missingEnums = rules.filter((r) => !r.config?.api?.type).map((r) => r.providerId);
  const mcr = conf.modelConfigRules || {};
  return {
    ok: illegal.length === 0,
    path: cfgPath,
    providers: rules.map((r) => ({ providerId: r.providerId, apiType: r.config?.api?.type || null,
      models: (r.config?.personalModelIds || []).length })),
    illegal,
    missingEnums,
    modelConfigRulesKeys: Object.keys(mcr),
    hasManualRules: "manualProviderModelRules" in mcr,
    modelRuleCount: (mcr.providerModelRules || []).length,
  };
}

module.exports = {
  ZCODE_API, ZCODE_API_TYPES,
  readConfig, structurePaths, elementId,
  writeZcodeConfig, upsertProviderRule, upsertModelEntries, checkZcodeConfig,
  removeProviders, removedProviderAllowPaths,
};
