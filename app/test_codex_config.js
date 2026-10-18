"use strict";
/**
 * Codex 配置写入的沙箱回归测试：`node app/test_codex_config.js`
 *
 * 全部跑在临时目录里的合成 fixture 上，绝不碰 ~/.codex/config.toml。
 * fixture 与用户真实文件同构（[projects.*] / [plugins.*] / notify 多行数组 / 注释 /
 * 别人的 provider 表），因为这套写入最容易犯的错不是"少写一个键"，而是**把别人的东西弄没了**：
 * 所以每个用例都拿 `foreignText`（去掉托管区后的残文）做逐字节比对。
 *
 * 取证背景（0.160.1 实测，见 .research/cc-switch-codex-analysis.md）：
 *   - 自定义 model_catalog_json 是**整体替换**自带目录 → 目录必须合并自带条目；
 *   - experimental_bearer_token 生效且不需要 auth.json；
 *   - 未知顶层键静默忽略，所以"写错键"不会报错，只能靠这里的断言拦。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const C = require("./codex-config.js");

const results = [];
const t = (name, fn) => {
  try { fn(); results.push([name, true, ""]); }
  catch (e) { results.push([name, false, e.message]); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const eq = (a, b, msg) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${msg || "不相等"}：${A} !== ${B}`);
};
const throws = (fn, needle, msg) => {
  try { fn(); } catch (e) {
    assert(String(e.message).includes(needle), `${msg}：错误信息不符，实际为「${e.message}」`);
    return e.message;
  }
  throw new Error(`${msg}：预期抛错但没有`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cfg-"));
const cfgPath = path.join(tmp, "config.toml");
const statePath = path.join(tmp, "codex-state.json");
const TOKEN = "sk-aswitch-test-0123456789";
const read = () => fs.readFileSync(cfgPath, "utf8");
const reset = (text) => { fs.rmSync(cfgPath, { force: true }); fs.rmSync(C.catalogPath(cfgPath), { force: true }); fs.rmSync(statePath, { force: true }); if (text != null) fs.writeFileSync(cfgPath, text); };
const cfg = (opts) => C.activate(cfgPath, { linkId: "workbuddy", token: TOKEN, statePath, ...opts });

/** 与用户真实 config.toml 同构的 fixture：注释 + 官方顶层键 + 别人的 provider 表 + 项目/插件表 + 多行数组 */
const REAL_FIXTURE = [
  '# Codex 全局配置（本文件由用户手工维护，别的工具只许动自己的那几行）',
  'model = "gpt-5.5"',
  'model_reasoning_effort = "medium"',
  'notify = [',
  '  "C:\\\\Users\\\\Someone\\\\codex-computer-use.exe",',
  '  "turn-ended",',
  ']',
  '',
  '[model_providers.proxychat]',
  'name = "别人家的中转"',
  'base_url = "http://127.0.0.1:9999/v1"',
  'env_key = "PROXYCHAT_KEY"',
  'wire_api = "responses"',
  '',
  '[projects.\'d:\\projects\\demo\']',
  'trust_level = "trusted"',
  '',
  '[plugins."visualize@openai-bundled"]',
  'enabled = true',
  '',
].join("\n");

const OUR_REQUIRED = ["slug", "display_name", "description", "base_instructions", "supported_reasoning_levels", "shell_type",
  "visibility", "supported_in_api", "priority", "support_verbosity", "truncation_policy", "experimental_supported_tools", "input_modalities"];
const BUNDLED = [
  { slug: "gpt-5.5", display_name: "GPT-5.5", shell_type: "unified_exec", base_instructions: "official", context_window: 272000 },
  { slug: "gpt-6-luna", display_name: "GPT-6-Luna", shell_type: "unified_exec", base_instructions: "official" },
];
const OUR_MODELS = [
  { slug: "glm-5.3", displayName: "GLM-5.3", contextWindow: 500000 },
  { slug: "glm-5.3-flash", displayName: "GLM-5.3-Flash", vision: true },
  { slug: "gpt-5.5" },   // 故意与自带条目撞 slug
];

// ---------------------------------------------------------------- 1 形状闸门（G1）
t("G1 链路表与 base_url 形状固定（端口/前缀不许漂）", () => {
  eq(C.linkBaseUrl(C.linkOf("workbuddy")), "http://127.0.0.1:18776/wb/v1", "WorkBuddy 走前门");
  eq(C.linkBaseUrl(C.linkOf("comate")), "http://127.0.0.1:18774/v1", "Comate 直连 relay");
  eq(C.linkBaseUrl(C.linkOf("qwenwork")), "http://127.0.0.1:8791/v1", "千问办公与 Qoder 同端口不同钥");
  assert(C.CODEX_LINKS.every((l) => l.tier === "tools" || l.tier === "chat"), "档位只有 tools/chat");
});

t("G1 未知链路 / 坏 token / 坏 model 一律拒绝，且点名原因", () => {
  reset(null);
  throws(() => C.activate(cfgPath, { linkId: "openai-official", token: TOKEN, statePath }), "未知链路", "未知链路要拦");
  throws(() => cfg({ token: 'sk-bad"quote' }), "api_key", "带引号的钥要拦");
  throws(() => cfg({ token: "sk-换行\n注入" }), "api_key", "非 ASCII/换行要拦");
  throws(() => cfg({ token: "" }), "api_key", "空钥要拦");
  throws(() => cfg({ model: "glm 5.3" }), "model", "带空格的模型名要拦");
  throws(() => C.assertShape({ link: C.linkOf("comate"), providerId: "aswitch-comate", baseUrl: "http://1.2.3.4:18774/v1", wireApi: "responses", token: TOKEN, model: "glm-5.3" }), "base_url", "外来 base_url 要拦");
  throws(() => C.assertShape({ link: C.linkOf("comate"), providerId: "aswitch-comate", baseUrl: "http://127.0.0.1:18774/v1", wireApi: "chat", token: TOKEN, model: "glm-5.3" }), "responses", "chat 协议要拦");
});

// ---------------------------------------------------------------- 2 空文件注册
t("A 空文件：激活生成托管表 + 指针键 + 目录，读回校验通过", () => {
  reset(null);
  const r = cfg({ model: "glm-5.3", bundled: BUNDLED, catalogModels: OUR_MODELS });
  assert(r.ok && r.providerId === "aswitch-workbuddy", "返回结构");
  const text = read();
  assert(text.includes(C.MARKER_COMMENT), "带 A-SWITCH 标记注释");
  assert(text.includes("[model_providers.aswitch-workbuddy]"), "provider 表");
  assert(text.includes('model_provider = "aswitch-workbuddy"') && text.includes('model = "glm-5.3"'), "顶层指针");
  assert(text.includes(`experimental_bearer_token = "${TOKEN}"`), "凭据写进 provider 表");
  assert(!text.includes("requires_openai_auth"), "绝不写 requires_openai_auth（会把官方登录打给第三方）");
  const p = C.parseToml(text);
  eq(p.topKeys.size, 3, "只有 model_provider/model/model_catalog_json 三个顶层键");
  assert(fs.existsSync(C.catalogPath(cfgPath)), "目录文件已生成");
  assert(r.backup === null, "首次创建没有备份可留");
  assert(r.catalog.count === 4, "目录 = 自带 2 + 我方 2（撞 slug 的 gpt-5.5 跳过，官方条目保住）");
  eq(r.catalog.skipped, ["gpt-5.5"], "撞 slug 记进 skipped");
});

// ---------------------------------------------------------------- 3 真实形状文件
t("B 真实形状 fixture：托管区外逐字节不变（注释/项目表/插件表/多行数组全在）", () => {
  reset(REAL_FIXTURE);
  cfg({ bundled: BUNDLED, catalogModels: OUR_MODELS });
  const text = read();
  assert(text.includes('# Codex 全局配置（本文件由用户手工维护，别的工具只许动自己的那几行）'), "文件头注释还在");
  assert(text.includes('notify = [\n  "C:\\\\Users\\\\Someone\\\\codex-computer-use.exe",\n  "turn-ended",\n]'), "多行 notify 数组逐字节不变");
  assert(text.includes('[model_providers.proxychat]') && text.includes('env_key = "PROXYCHAT_KEY"'), "别人的 provider 表还在");
  assert(text.includes("[projects.'d:\\projects\\demo']") && text.includes('trust_level = "trusted"'), "项目表还在");
  assert(text.includes('[plugins."visualize@openai-bundled"]'), "插件表还在");
  assert(text.includes('model_reasoning_effort = "medium"'), "用户自己的顶层键还在");
  // 残文比对：托管区之外一个字都不许变
  C.assertForeignUnchanged(REAL_FIXTURE, text);
  // 顶层键插在最后一个顶层键之后、第一张表之前
  const p = C.parseToml(text);
  const firstHeader = Math.min(...p.headers.map((h) => h.header));
  assert(p.topKeys.get("model_provider").start < firstHeader, "新顶层键插在表之前");
  assert(p.topKeys.get("notify").end > p.topKeys.get("notify").start, "多行数组的跨度算对了");
});

t("B2 幂等：连按两次注册，文件内容一致（除了备份）", () => {
  reset(REAL_FIXTURE);
  cfg({ bundled: BUNDLED, catalogModels: OUR_MODELS });
  const once = read();
  cfg({ bundled: BUNDLED, catalogModels: OUR_MODELS });
  eq(read(), once, "第二次注册不该再改动文件");
});

t("B3 只有表、没有顶层键的文件：新键插在第一张表头之前", () => {
  reset('[model_providers.proxychat]\nname = "别家"\nbase_url = "http://127.0.0.1:9999/v1"\n');
  cfg({ writeCatalog: false });
  const p = C.parseToml(read());
  const firstHeader = Math.min(...p.headers.map((h) => h.header));
  assert(p.topKeys.get("model_provider").start < firstHeader, "插在表头之前");
  assert(read().startsWith('[model_providers.proxychat]') === false, "我们的键在最前面");
});

// ---------------------------------------------------------------- 4 切换与摘除
t("C A→B 切换：原始顶层值只快照一次，摘除当前时还原成用户的原始值", () => {
  reset(REAL_FIXTURE);
  cfg({ bundled: BUNDLED, catalogModels: OUR_MODELS });                       // A = workbuddy
  C.activate(cfgPath, { linkId: "comate", token: TOKEN, statePath, bundled: BUNDLED, catalogModels: OUR_MODELS });
  let p = C.parseToml(read());
  eq(C.topValue(p, "model_provider"), "aswitch-comate", "B 成为当前");
  eq(C.topValue(p, "model"), "glm-5.3", "B 的模型");
  assert(p.tables.size >= 2, "两张表都在");
  // 摘除 B（当前）→ 顶层键还原成用户原始值（fixture 里的 model = "gpt-5.5"）
  const r = C.deregister(cfgPath, { linkId: "comate", statePath });
  assert(r.restored, "摘除当前链路要标记已还原");
  p = C.parseToml(read());
  eq(C.topValue(p, "model_provider"), null, "原始文件没有 model_provider → 还原成没有");
  eq(C.topValue(p, "model"), "gpt-5.5", "model 还原成用户的 gpt-5.5");
  assert(!p.tables.has("model_providers.aswitch-comate"), "B 的表已删");
  assert(p.tables.has("model_providers.aswitch-workbuddy"), "A 的表还在");
  assert(fs.existsSync(C.catalogPath(cfgPath)), "还有我们的表 → 目录保留");
});

t("C2 摘除非当前链路：只删表，顶层键与目录都不动", () => {
  reset(REAL_FIXTURE);
  cfg({ bundled: BUNDLED, catalogModels: OUR_MODELS });
  C.activate(cfgPath, { linkId: "comate", token: TOKEN, statePath, bundled: BUNDLED, catalogModels: OUR_MODELS });
  const before = read();
  const r = C.deregister(cfgPath, { linkId: "workbuddy", statePath });
  assert(r.changed && !r.restored, "只删表");
  const after = read();
  eq(C.topValue(C.parseToml(after), "model_provider"), "aswitch-comate", "当前供应商没变");
  C.assertForeignUnchanged(before, after);
});

t("C3 摘除最后一个链路：目录与指针一起清掉，文件回到用户原样", () => {
  reset(REAL_FIXTURE);
  cfg({ bundled: BUNDLED, catalogModels: OUR_MODELS });
  const r = C.deregister(cfgPath, { linkId: "workbuddy", statePath });
  assert(r.catalogRemoved, "目录被清掉");
  assert(!fs.existsSync(C.catalogPath(cfgPath)), "目录文件已删除");
  eq(read(), REAL_FIXTURE, "文件逐字节回到激活前的样子");
});

t("C4 重复摘除：第二次是空操作，不写盘（不留新备份）", () => {
  reset(REAL_FIXTURE);
  cfg({ writeCatalog: false });
  C.deregister(cfgPath, { linkId: "workbuddy", statePath });
  const r = C.deregister(cfgPath, { linkId: "workbuddy", statePath });
  assert(!r.changed, "空操作");
  assert(r.reason.includes("没有我们的痕迹"), "给出原因");
});

// ---------------------------------------------------------------- 5 可选顶层键
t("D 用户自己的 model_context_window 不该被我们顺手删掉（没有值就不碰）", () => {
  // 注意插在第一张表之前：写在表头之后的行属于那张表，就不是顶层键了
  reset(REAL_FIXTURE.replace("\n[model_providers.proxychat]", "\nmodel_context_window = 123456\n\n[model_providers.proxychat]"));
  cfg({ writeCatalog: false });
  eq(C.topValue(C.parseToml(read()), "model_context_window"), "123456", "用户的值保留");
  // 我们主动给值 → 覆盖并记进 writtenKeys
  C.activate(cfgPath, { linkId: "workbuddy", token: TOKEN, statePath, writeCatalog: false, contextWindow: 200000 });
  eq(C.topValue(C.parseToml(read()), "model_context_window"), "200000", "给值就覆盖");
  // 下一次不给 → 撤掉我们的值、还原用户原值
  cfg({ writeCatalog: false });
  eq(C.topValue(C.parseToml(read()), "model_context_window"), "123456", "撤掉我们的值并还原用户原值");
});

t("D2 写过又不要的可选键：用户原本没有就删干净（不留半截）", () => {
  reset(REAL_FIXTURE);
  C.activate(cfgPath, { linkId: "workbuddy", token: TOKEN, statePath, writeCatalog: false, contextWindow: 200000, autoCompactLimit: 150000 });
  let p = C.parseToml(read());
  eq([C.topValue(p, "model_context_window"), C.topValue(p, "model_auto_compact_token_limit")], ["200000", "150000"], "两个可选键都写了");
  cfg({ writeCatalog: false });
  p = C.parseToml(read());
  eq([C.topValue(p, "model_context_window"), C.topValue(p, "model_auto_compact_token_limit")], [null, null], "撤干净");
  assert(!read().includes("model_context_window"), "行也删掉，不留空键");
});

// ---------------------------------------------------------------- 6 G2/G3/G4 闸门本体
t("E G2 咬人：托管区外被动过就拒绝写入（并指出第一处差异）", () => {
  const evil = REAL_FIXTURE.replace('[plugins."visualize@openai-bundled"]\nenabled = true\n', "");
  const msg = throws(() => C.assertForeignUnchanged(REAL_FIXTURE, evil), "托管区之外", "删别人的表必须拦下");
  assert(msg.includes("差异"), "错误信息要指出差异位置");
  reset(REAL_FIXTURE);
  const p = C.parseToml(REAL_FIXTURE);
  C.setTopKey(p, "model", "glm-5.3");
  throws(() => C.writeCodexConfig(cfgPath, C.serializeToml(p) + "\n# 多出来的注释\n", REAL_FIXTURE), "托管区之外", "写盘前的闸门也必须拦");
});

t("F G4 读回失败 → 回滚到备份，文件保持写入前内容", () => {
  reset(REAL_FIXTURE);
  const p = C.parseToml(REAL_FIXTURE);
  C.setTopKey(p, "model", "glm-5.3");
  const msg = throws(() => C.writeCodexConfig(cfgPath, C.serializeToml(p), REAL_FIXTURE, { verify: () => ["模拟读回失败"] }), "已回滚", "读回失败要回滚");
  assert(msg.includes("模拟读回失败"), "错误里带原始原因");
  eq(read(), REAL_FIXTURE, "文件与写入前逐字节一致");
});

t("G3 换行风格与 BOM 保留", () => {
  const crlf = "\uFEFF" + REAL_FIXTURE.replace(/\n/g, "\r\n");
  reset(crlf);
  cfg({ bundled: BUNDLED, catalogModels: OUR_MODELS });
  const text = read();
  assert(text.startsWith("\uFEFF"), "BOM 保留");
  assert(!/[^\r]\n/.test(text.slice(1)), "所有换行都是 CRLF");
  const p = C.parseToml(text);
  assert(p.lines.some((l) => l.includes("[model_providers.aswitch-workbuddy]")), "新表也是 CRLF");
  C.assertForeignUnchanged(crlf, text);
});

t("G4 体检：不回显凭据，坏 wire_api 会被点名", () => {
  reset(REAL_FIXTURE);
  cfg({ writeCatalog: false });
  const ok = C.checkCodexConfig(cfgPath);
  assert(ok.ok, `体检应当通过：${ok.problems.join("；")}`);
  assert(ok.providers[0].hasToken === true && !JSON.stringify(ok).includes(TOKEN), "只报告 hasToken，绝不回显钥");
  eq(ok.current.model_provider, "aswitch-workbuddy", "当前供应商");
  // 人为把 wire_api 改坏（模拟手工改错 / 旧版本留下的坏配置）。
  // 只改我方表里的那一处：fixture 里 proxychat 表也写着 wire_api = "responses"。
  const txt = read();
  const i = txt.indexOf(`[${C.managedTableName("workbuddy")}]`);
  fs.writeFileSync(cfgPath, txt.slice(0, i) + txt.slice(i).replace('wire_api = "responses"', 'wire_api = "chat"'));
  const bad = C.checkCodexConfig(cfgPath);
  assert(!bad.ok && bad.problems.some((s) => s.includes("responses")), `坏 wire_api 要点名：${JSON.stringify(bad.problems)}`);
});

// ---------------------------------------------------------------- 7 目录生成
t("H 目录：自带条目整份保留 + 我方条目 13 个字段齐 + 撞 slug 跳过", () => {
  const cat = C.buildCatalog({ bundled: BUNDLED, models: OUR_MODELS });
  const j = JSON.parse(cat.text);
  eq(j.models.length, 4, "2 自带 + 2 我方（撞 slug 的 gpt-5.5 不覆盖官方条目）");
  eq(cat.skipped, ["gpt-5.5"], "撞 slug 记进 skipped");
  eq(cat.slugs, ["glm-5.3", "glm-5.3-flash"], "记下我方 slug（供下次刷新精确剔除）");
  eq(j.models.slice(0, 2).map((m) => m.slug), ["gpt-5.5", "gpt-6-luna"], "自带条目原样在前");
  const ours = j.models[2];
  for (const k of OUR_REQUIRED) assert(ours[k] !== undefined, `缺字段 ${k}`);
  eq(ours.slug, "glm-5.3", "第一条第我方模型");
  eq(ours.shell_type, "unified_exec", "shell 档：不写 apply_patch_tool_type / supports_search_tool，工具面与未知模型回退一致");
  eq(ours.context_window, 500000, "声明了窗口");
  eq(ours.effective_context_window_percent, 95, "窗口百分比");
  eq(ours.input_modalities, ["text"], "不带 vision 的模型只有文本输入");
  eq(j.models[3].input_modalities, ["text", "image"], "vision 模型声明图片输入");
  eq(j.models[2].truncation_policy, { mode: "tokens", limit: 10000 }, "截断策略与官方同形状");
  assert(!cat.text.includes("apply_patch_tool_type"), "模板里不出现 apply_patch 相关字段");
});

t("H2 取不到自带目录时：沿用旧目录里的非我方条目（不清空官方模型）", () => {
  reset(REAL_FIXTURE);
  const first = C.refreshCatalog(cfgPath, OUR_MODELS, { bundled: BUNDLED });
  const r = C.refreshCatalog(cfgPath, OUR_MODELS, { bundled: null, prevOurs: first.slugs });   // 模拟 codex 不可用
  const j = JSON.parse(fs.readFileSync(C.catalogPath(cfgPath), "utf8"));
  eq(j.models.filter((m) => ["gpt-5.5", "gpt-6-luna"].includes(m.slug)).length, 2, "自带条目仍在");
  eq(j.models.length, 4, "自带 2 + 我方 2：撞 slug 的自带条目没被当成我方剔掉");
  eq(r.ours, 2, "我方条目数（gpt-5.5 撞车跳过）");
  eq(r.skipped, ["gpt-5.5"], "撞车记录保留");
});

t("H3 体检报「目录缺自带模型」——自定义目录是整体替换，缺了官方模型就消失", () => {
  reset(REAL_FIXTURE);
  cfg({ bundled: [], catalogModels: [{ slug: "glm-5.3" }] });
  const rep = C.checkCodexConfig(cfgPath, { bundledSlugs: ["gpt-5.5", "gpt-6-luna", "glm-5.3"] });
  assert(rep.catalog.missingBundled.includes("gpt-5.5"), "点名缺失的自带模型");
  assert(rep.warnings.some((w) => w.includes("整体替换")), "解释后果");
});

t("I 模型 id 对齐：优先同名，其次取上游全名（cn: 前缀），都对不上原样返回", () => {
  eq(C.pickModel("glm-5.3", ["cn:glm-5.3", "cn:hy3"]), "cn:glm-5.3", "按 : 后缀对上上游全名");
  eq(C.pickModel("cn:hy3", ["cn:glm-5.3", "cn:hy3"]), "cn:hy3", "同名优先");
  eq(C.pickModel("GLM-5.3", ["cn:glm-5.3"]), "cn:glm-5.3", "后缀匹配大小写不敏感");
  eq(C.pickModel("glm-5.3", ["qwen3.8-max"]), "glm-5.3", "都对不上：原样返回（上游也许按别名接受）");
  eq(C.pickModel("glm-5.3", []), "glm-5.3", "上游目录为空：原样返回");
});

t("J 顶层模型必须落在目录里：不在就补一条合成条目（否则 Codex 回退默认元数据）", () => {
  reset(REAL_FIXTURE);
  const cat = C.buildCatalog({ bundled: BUNDLED, models: [{ slug: "cn:glm-5.3" }], ensureModel: "glm-5.3" });
  eq(cat.ensured, ["glm-5.3"], "记下补的那条");
  const j = JSON.parse(cat.text);
  assert(j.models.some((m) => m.slug === "glm-5.3"), "合成条目进目录");
  eq(j.models.find((m) => m.slug === "glm-5.3").shell_type, "unified_exec", "合成条目走同一套模板");
  // 注册路径：顶层 model 取上游全名，目录里必须找得到它
  const r = cfg({ catalogModels: [{ slug: "cn:glm-5.3" }], model: C.pickModel("glm-5.3", ["cn:glm-5.3"]) });
  eq(r.model, "cn:glm-5.3", "顶层写成上游全名");
  eq(C.topValue(C.parseToml(read()), "model"), "cn:glm-5.3", "写进 config.toml 的也是全名");
  assert(C.catalogSummary(cfgPath).slugs.includes("cn:glm-5.3"), "目录里有顶层模型（Codex 不会回退元数据）");
  eq(r.catalog.ensured, [], "模型本来就在目录里：不补合成条目");
});

const pass = results.filter((r) => r[1]).length;
for (const [name, ok, msg] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  <-- " + msg}`);
console.log(`\n==== ${pass}/${results.length} ====`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exit(pass === results.length ? 0 : 1);
