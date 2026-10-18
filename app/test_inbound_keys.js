"use strict";
/**
 * 入站 api_key「生成」功能的沙箱回归测试：`node app/test_inbound_keys.js`
 *
 * 全部跑在临时目录里的合成 fixture 上，绝不碰真实的 ~/.autoclaw-relay/。
 * 重点是四条不变量：
 *   1. 生成钥形状（前缀 + 36 位 hex）与随机性——控制台生成的东西必须能当
 *      header/env 值用，不能带空白或逗号（逗号会破坏 *_INBOUND_KEYS 追加语义）；
 *   2. 档案读写宽容且不丢数据——手改坏的 JSON 不该把坏钥带进闸门口径；
 *   3. 内置兜底钥与 relay 源码逐字一致（防漂移）——BUILTIN 里改了名而 relay
 *      没跟着改，就会表现为「生成后旧 ZCode 注册值失效」这类现场故障；
 *   4. 标准钥（别名）与主钥互不吞噬——两条写路径（writeStore / addAlias）都要
 *      保住对方的数据，否则「生成主钥」会悄悄抹掉已配好的 sk- 别名（反之亦然）。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const IK = require("./inbound-keys.js");

const results = [];
const t = (name, fn) => {
  try { fn(); results.push([name, true, ""]); }
  catch (e) { results.push([name, false, e.message]); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "asw-ik-"));
const LINKS = ["autoclaw", "workbuddy", "trae", "doubao", "comate", "qoder", "qwenwork"];

// ------------------------------------------------------------ generateKey
t("A1 生成钥前缀覆盖七条链路", () => {
  for (const id of LINKS) {
    const k = IK.generateKey(id);
    assert(k.startsWith(IK.PREFIX[id] + "-"), `${id} 的前缀应为 ${IK.PREFIX[id]}-，实际 ${k}`);
  }
});

t("A2 生成钥形状 = 前缀 + 36 位 hex", () => {
  for (const id of LINKS) {
    const k = IK.generateKey(id);
    assert(/^[a-z]{2}-[0-9a-f]{36}$/.test(k), `${id} 形状不符：${k}`);
    assert(IK.validKey(k), `${id} 生成的钥应通过 validKey`);
  }
});

t("A3 未知链路退化为 ik- 前缀", () => {
  assert(/^ik-[0-9a-f]{36}$/.test(IK.generateKey("nope")), "未知链路应退化为 ik-");
});

t("A4 连续生成不重复", () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const k = IK.generateKey("trae");
    assert(!seen.has(k), "两次生成出现相同值（随机源坏了）");
    seen.add(k);
  }
});

// -------------------------------------------------- generateStandardKey
t("A5 标准钥 = sk- + 平台前缀 + 36 位 hex（与主钥形状可区分）", () => {
  for (const id of LINKS) {
    const k = IK.generateStandardKey(id);
    assert(k.startsWith("sk-" + IK.PREFIX[id] + "-"), `${id} 标准钥前缀应为 sk-${IK.PREFIX[id]}-，实际 ${k}`);
    assert(/^sk-[a-z]{2}-[0-9a-f]{36}$/.test(k), `${id} 标准钥形状不符：${k}`);
    assert(IK.validKey(k), `${id} 标准钥应通过 validKey`);
  }
});

t("A6 未知链路标准钥退化为 sk-ik-，连续生成不重复", () => {
  assert(/^sk-ik-[0-9a-f]{36}$/.test(IK.generateStandardKey("nope")), "未知链路应退化为 sk-ik-");
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const k = IK.generateStandardKey("doubao");
    assert(!seen.has(k), "两次生成出现相同标准钥（随机源坏了）");
    seen.add(k);
  }
});

// -------------------------------------------------------------- validKey
t("B1 validKey 接受常规钥", () => {
  for (const k of ["abcd", "qd-0123456789abcdef0123456789abcdef0123", "A_b-C.9~x"]) {
    assert(IK.validKey(k), `应接受：${k}`);
  }
});

t("B2 validKey 拒绝空/短/空白/逗号/超长", () => {
  const bad = ["", "abc", "has space", "has\tspace", "a,b", "x".repeat(129)];
  for (const k of bad) assert(!IK.validKey(k), `应拒绝：${JSON.stringify(k.slice(0, 20))}（长度 ${k.length}）`);
});

t("B3 validKey 拒绝非字符串", () => {
  for (const v of [null, undefined, 123, {}, ["a"], Buffer.from("abcd")]) assert(!IK.validKey(v), "应拒绝非字符串");
});

// ------------------------------------------------------------- storePath
t("C1 storePath 落在 ~/.autoclaw-relay/inbound-keys.json", () => {
  const p = IK.storePath("C:\\Users\\fake");
  assert(p === path.join("C:\\Users\\fake", ".autoclaw-relay", "inbound-keys.json"), "路径不符：" + p);
});

// ------------------------------------------------------------- readStore
t("D1 档案缺失 → 空对象", () => {
  assert(JSON.stringify(IK.readStore(path.join(tmp, "no-such.json"))) === "{}", "缺失应返回 {}");
});

t("D2 坏 JSON → 空对象（不抛错）", () => {
  const f = path.join(tmp, "bad.json");
  fs.writeFileSync(f, "{not json");
  assert(JSON.stringify(IK.readStore(f)) === "{}", "坏 JSON 应返回 {}");
});

t("D3 数组 / null / 标量 → 空对象", () => {
  for (const [name, raw] of [["arr.json", "[1,2]"], ["null.json", "null"], ["num.json", "42"]]) {
    const f = path.join(tmp, name);
    fs.writeFileSync(f, raw);
    assert(Object.keys(IK.readStore(f)).length === 0, `${name} 应返回 {}`);
  }
});

t("D4 非字符串值与坏形状值被过滤", () => {
  const f = path.join(tmp, "mixed.json");
  fs.writeFileSync(f, JSON.stringify({
    trae: "tr-" + "a".repeat(36), autoclaw: 123, doubao: null, comate: { v: "x" },
    ghost: "has space", long: "y".repeat(200), empty: "",
  }));
  const s = IK.readStore(f);
  assert(s.trae === "tr-" + "a".repeat(36), "合法值应保留");
  for (const k of ["autoclaw", "doubao", "comate", "ghost", "long", "empty"]) {
    assert(!(k in s), `${k} 应被过滤`);
  }
});

t("D5 值两端空白被 trim", () => {
  const f = path.join(tmp, "trim.json");
  fs.writeFileSync(f, JSON.stringify({ trae: "  tr-" + "b".repeat(36) + "\n" }));
  assert(IK.readStore(f).trae === "tr-" + "b".repeat(36), "应 trim 后保留");
});

// ------------------------------------------------------------ writeStore
t("E1 写后读回一致（含目录自动创建）", () => {
  const f = path.join(tmp, "nested", "deep", "inbound-keys.json");
  const store = { trae: IK.generateKey("trae"), doubao: IK.generateKey("doubao") };
  IK.writeStore(f, store);
  const back = IK.readStore(f);
  assert(back.trae === store.trae && back.doubao === store.doubao, "读回不一致");
});

t("E2 覆盖写：第二次写不含第一次的键", () => {
  const f = path.join(tmp, "overwrite.json");
  IK.writeStore(f, { trae: IK.generateKey("trae"), autoclaw: IK.generateKey("autoclaw") });
  IK.writeStore(f, { trae: IK.generateKey("trae") });
  const back = IK.readStore(f);
  assert(back.trae && !("autoclaw" in back), "覆盖写应完全替换内容");
});

t("E3 原子写不留 .tmp 残留", () => {
  const f = path.join(tmp, "atomic.json");
  IK.writeStore(f, { comate: IK.generateKey("comate") });
  assert(!fs.existsSync(f + ".tmp"), ".tmp 应已被 rename 掉");
});

// ------------------------------------------------------------- activeKey
t("F1/F2/F3 activeKey 命中 / 未生成 / 空档案", () => {
  const store = { trae: "tr-" + "c".repeat(36) };
  assert(IK.activeKey(store, "trae") === store.trae, "命中应返回值");
  assert(IK.activeKey(store, "doubao") === "", "未生成应返回空串");
  assert(IK.activeKey({}, "trae") === "" && IK.activeKey(null, "trae") === "", "空/坏 store 应返回空串");
});

// --------------------------------------------------------- 别名（标准钥）
t("H1 readAliases：缺失 / 坏 JSON / 无 _aliases / 坏形状 _aliases → 空映射", () => {
  assert(JSON.stringify(IK.readAliases(path.join(tmp, "no-such.json"))) === "{}", "缺失应返回 {}");
  const bad = path.join(tmp, "bad-alias.json");
  fs.writeFileSync(bad, "{not json");
  assert(Object.keys(IK.readAliases(bad)).length === 0, "坏 JSON 应返回空映射");
  const flat = path.join(tmp, "flat-alias.json");
  fs.writeFileSync(flat, JSON.stringify({ trae: "tr-" + "a".repeat(36) }));
  assert(Object.keys(IK.readAliases(flat)).length === 0, "无 _aliases 应返回空映射");
  for (const [name, raw] of [["al-arr.json", "[]"], ["al-str.json", '"x"'], ["al-num.json", "7"]]) {
    const f = path.join(tmp, name);
    fs.writeFileSync(f, JSON.stringify({ _aliases: JSON.parse(raw) }));
    assert(Object.keys(IK.readAliases(f)).length === 0, `${name} 的 _aliases 坏形状应返回空映射`);
  }
});

t("H2 readAliases：非数组链路 / 非字符串项 / 坏形状值被过滤，值去重且 trim", () => {
  const f = path.join(tmp, "alias-filter.json");
  const good1 = "sk-tr-" + "b".repeat(36), good2 = "sk-db-" + "c".repeat(36);
  fs.writeFileSync(f, JSON.stringify({ _aliases: {
    trae: [good1, good1, "  " + good2 + "\n", 123, null, "has space", "", "x".repeat(200)],
    doubao: "not-an-array",
    comate: [],
  } }));
  const a = IK.readAliases(f);
  assert(a.trae.length === 2 && a.trae[0] === good1 && a.trae[1] === good2, "应按登记序保留两把合法值（去重 + trim）：" + JSON.stringify(a.trae));
  assert(!("doubao" in a) && !("comate" in a), "非数组/空数组链路应被丢掉");
});

t("H3 addAlias：登记后可读回；同值幂等；多把并存按登记序", () => {
  const f = path.join(tmp, "alias-add.json");
  const k1 = IK.generateStandardKey("trae"), k2 = IK.generateStandardKey("trae");
  const r1 = IK.addAlias(f, "trae", k1);
  assert(r1.ok && r1.aliases.length === 1 && r1.aliases[0] === k1, "首次登记应成功且列表只含该值");
  const r2 = IK.addAlias(f, "trae", k1);
  assert(r2.ok && r2.aliases.length === 1, "同值重复登记应幂等（不新增一条）");
  const r3 = IK.addAlias(f, "doubao", k2);
  assert(r3.ok, "另一条链路可并存");
  const a = IK.readAliases(f);
  assert(a.trae.length === 1 && a.trae[0] === k1, "读回 trae 应为一把");
  assert(a.doubao.length === 1 && a.doubao[0] === k2, "读回 doubao 应为一把");
});

t("H4 addAlias 拒绝坏形状且不落盘", () => {
  const f = path.join(tmp, "alias-bad.json");
  for (const bad of ["", "abc", "has space", "a,b", null, 123]) {
    const r = IK.addAlias(f, "trae", bad);
    assert(r.ok === false && typeof r.error === "string", `应拒绝 ${JSON.stringify(bad)}`);
  }
  assert(!fs.existsSync(f), "全部被拒时不该创建档案");
});

t("H5 removeAlias：移除一把留其他；移最后一把后该链路从 _aliases 清掉", () => {
  const f = path.join(tmp, "alias-remove.json");
  const k1 = IK.generateStandardKey("trae"), k2 = IK.generateStandardKey("trae");
  IK.addAlias(f, "trae", k1); IK.addAlias(f, "trae", k2);
  const r1 = IK.removeAlias(f, "trae", k1);
  assert(r1.ok && r1.removed === 1 && r1.aliases.length === 1 && r1.aliases[0] === k2, "应只移除命中那把");
  const r2 = IK.removeAlias(f, "trae", k2);
  assert(r2.ok && r2.removed === 1 && r2.aliases.length === 0, "移最后一把应返回空列表");
  assert(!("trae" in IK.readAliases(f)), "该链路应从 _aliases 里清掉");
});

t("H6 removeAlias 未命中：removed=0，档案其余内容不变", () => {
  const f = path.join(tmp, "alias-miss.json");
  const k1 = IK.generateStandardKey("comate");
  IK.addAlias(f, "comate", k1);
  const before = fs.readFileSync(f, "utf8");
  const r = IK.removeAlias(f, "comate", "sk-cm-" + "f".repeat(36));
  assert(r.ok && r.removed === 0 && r.aliases.length === 1, "未命中应 removed=0 且不动列表");
  assert(fs.readFileSync(f, "utf8") === before, "未命中也不该改变档案字节");
});

t("H7 主钥写不抹别名：writeStore 后 _aliases 原样保留", () => {
  const f = path.join(tmp, "keep-alias.json");
  const a1 = IK.generateStandardKey("trae"), a2 = IK.generateStandardKey("doubao");
  IK.addAlias(f, "trae", a1); IK.addAlias(f, "doubao", a2);
  const main = IK.generateKey("trae");
  IK.writeStore(f, { trae: main });                      // 控制台「生成」走这条路径
  assert(IK.readStore(f).trae === main, "主钥应写入");
  const a = IK.readAliases(f);
  assert(a.trae[0] === a1 && a.doubao[0] === a2, "别名应原样保留：" + JSON.stringify(a));
});

t("H8 别名写不抹主钥：addAlias/removeAlias 后 readStore 仍读到主钥", () => {
  const f = path.join(tmp, "keep-main.json");
  const main = IK.generateKey("doubao");
  IK.writeStore(f, { doubao: main });
  const a1 = IK.generateStandardKey("doubao");
  IK.addAlias(f, "doubao", a1);
  assert(IK.readStore(f).doubao === main, "addAlias 后主钥应还在");
  IK.removeAlias(f, "doubao", a1);
  assert(IK.readStore(f).doubao === main, "removeAlias 后主钥应还在");
});

t("H9 主钥覆盖语义仍成立：writeStore 仍是整表替换（除 _aliases）", () => {
  const f = path.join(tmp, "overwrite2.json");
  IK.addAlias(f, "trae", IK.generateStandardKey("trae"));
  IK.writeStore(f, { trae: IK.generateKey("trae"), autoclaw: IK.generateKey("autoclaw") });
  IK.writeStore(f, { trae: IK.generateKey("trae") });
  const back = IK.readStore(f);
  assert(back.trae && !("autoclaw" in back), "覆盖写应替换主钥整表");
  assert(IK.readAliases(f).trae.length === 1, "但别名不受覆盖写影响");
});

t("H10 readStore 跳过保留键：_aliases 不会被当主钥读出来", () => {
  const f = path.join(tmp, "skip-reserved.json");
  IK.writeStore(f, { trae: IK.generateKey("trae") });
  IK.addAlias(f, "trae", IK.generateStandardKey("trae"));
  const s = IK.readStore(f);
  assert(!(IK.ALIASES_FIELD in s), "readStore 不该把 _aliases 当主钥");
  assert(Object.keys(s).join(",") === "trae", "除主钥外不该多出键：" + Object.keys(s).join(","));
});

t("H11 旧格式档案（纯扁平，无 _aliases）兼容：读正常、别名空、可直接 add", () => {
  const f = path.join(tmp, "legacy.json");
  const main = IK.generateKey("comate");
  fs.writeFileSync(f, JSON.stringify({ comate: main }));   // 旧控制台写出的格式
  assert(IK.readStore(f).comate === main, "旧格式主钥应读到");
  assert(IK.readAliases(f).comate === undefined, "旧格式别名应为空");
  const k = IK.generateStandardKey("comate");
  assert(IK.addAlias(f, "comate", k).ok, "旧格式上应能直接登记别名");
  assert(IK.readStore(f).comate === main && IK.readAliases(f).comate[0] === k, "登记别名后两者并存");
});

// --------------------------------------------------------- 防漂移（源码）
const srcOf = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

t("G1 BUILTIN 与四条 relay 源码常量逐字一致", () => {
  const relPaths = { autoclaw: "bridge/server_2x.mjs", trae: "trae/relay.mjs", doubao: "doubao/relay.mjs", comate: "comate/relay.mjs" };
  for (const [id, rel] of Object.entries(relPaths)) {
    const src = srcOf(rel);
    assert(src.includes(`"${IK.BUILTIN[id]}"`), `${rel} 里找不到内置钥 ${IK.BUILTIN[id]}（BUILTIN 与 relay 漂移了）`);
  }
});

t("G2 四条 relay 都带 consoleStoreKeys 通道（主钥 ∪ 别名，读同一档案）", () => {
  const relPaths = { autoclaw: "bridge/server_2x.mjs", trae: "trae/relay.mjs", doubao: "doubao/relay.mjs", comate: "comate/relay.mjs" };
  for (const [id, rel] of Object.entries(relPaths)) {
    const src = srcOf(rel);
    assert(src.includes("function consoleStoreKeys"), `${rel} 缺 consoleStoreKeys（生成钥/别名通道被删了？）`);
    assert(src.includes(".autoclaw-relay\", \"inbound-keys.json"), `${rel} 的档案路径不是 ~/.autoclaw-relay/inbound-keys.json`);
    // 别名读法：保留键 + 本链路数组，两处都要在（漏一处 = 别名进了档案但进不了闸门）
    assert(src.includes(`raw?._aliases?.${id}`), `${rel} 没读 _aliases.${id}（别名通道被删了？）`);
    assert(src.includes("consoleStoreKeys()"), `${rel} 没把 consoleStoreKeys() 并进闸门集合`);
  }
});

t("G3 STORE_LINKS 恰为四条 env 链路", () => {
  assert(IK.STORE_LINKS.slice().sort().join(",") === "autoclaw,comate,doubao,trae", "STORE_LINKS 不符：" + IK.STORE_LINKS.join(","));
});

t("G4 保留键名与 relay/主进程源码逐字一致", () => {
  assert(IK.ALIASES_FIELD === "_aliases", "ALIASES_FIELD 应为 _aliases");
  for (const rel of ["bridge/server_2x.mjs", "trae/relay.mjs", "doubao/relay.mjs", "comate/relay.mjs"]) {
    assert(srcOf(rel).includes("_aliases"), `${rel} 里找不到 ${IK.ALIASES_FIELD} 字面量`);
  }
  const main = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  assert(main.includes("keys:alias"), "main.js 缺 keys:alias 处理器");
  assert(main.includes("IK.generateStandardKey"), "main.js 没接 generateStandardKey（「sk 钥」按钮的自动生成）");
  assert(main.includes("pushAliases"), "main.js 的钥匙盘点没并入别名行");
});

// ------------------------------------------------------------------ 汇总
const pass = results.filter((r) => r[1]).length;
for (const [name, ok, msg] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  <-- " + msg}`);
console.log(`\n==== ${pass}/${results.length} ====`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exit(pass === results.length ? 0 : 1);
