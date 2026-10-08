#!/usr/bin/env node
/**
 * 模型命名一致性检查：`node test_model_catalog.mjs`（离线） / `node test_model_catalog.mjs --live`
 *
 * 单一事实源是仓库根的 models-catalog.json（统一命名规范 + 七平台规范名对照）。
 * 本脚本守两条线：
 *   离线（默认）：
 *     ① 目录内所有 id 符合命名规范（全小写、无上游 hash / 路由前缀 / 内部缩写 key）；
 *     ② trae 条目 id === upstream 小写（可 canonical 化的必须已 canonical 化）；
 *     ③ autoclaw 段与 a_switch.py 的 ZCODE_MODELS 逐条一致（id/route/视觉/上下文）。
 *   --live（追加）：对在跑的网关拉 /v1/models：
 *     ④ 对外 id 全部合规；
 *     ⑤ 静态目录平台（autoclaw/comate/doubao/qoder/qwenwork）目录内 id 必须全部在线；
 *       网关多出来的条目只要合规就放行（上游新增模型不该卡测试，但会打 INFO 提醒补目录）。
 * 网关没在跑的平台跳过并记 SKIP，不算失败。退出码：0=全过，1=有 FAIL。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(fs.readFileSync(path.join(root, "models-catalog.json"), "utf8"));
const LIVE = process.argv.includes("--live");

const results = [];
const t = (name, ok, detail = "") => results.push([name, !!ok, detail]);
const ID_RE = /^[a-z0-9][a-z0-9.:-]*$/;
const badIds = (ids) => ids.filter((id) => !ID_RE.test(id) || id.includes("_"));

function comateCanon(raw) {
  return String(raw).replace(/_[0-9a-f]{8,}$/i, "").replace(/-(?:fc|oneapi)$/i, "").toLowerCase();
}

// ---- ① 目录自检：所有 id 合规 ----
for (const [key, p] of Object.entries(catalog.platforms)) {
  const ids = (p.models || []).map((m) => m.id);
  const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
  t(`① ${key}: id 全部合规且无重复`, badIds(ids).length === 0 && dup.length === 0,
    [badIds(ids).length ? `违规 id: ${badIds(ids).join(", ")}` : "", dup.length ? `重复 id: ${dup.join(", ")}` : ""].filter(Boolean).join("；"));
}

// ---- ② trae：id 必须等于 upstream 的小写 ----
for (const m of catalog.platforms.trae.models || []) {
  if (m.upstream !== undefined && m.id !== String(m.upstream).toLowerCase()) {
    t(`② trae/${m.id}: id 应等于 upstream 小写`, false, `upstream=${m.upstream}`);
  }
}
t("② trae: id === upstream 小写（逐条）", true);

// ---- ③ a_switch.py 的 ZCODE_MODELS 与目录一致 ----
{
  // 开发树在 autoclaw-switch/ 子目录，仓库树就在根——两处都找
  const pyPath = ["autoclaw-switch/a_switch.py", "a_switch.py"]
    .map((p) => path.join(root, p)).find((p) => fs.existsSync(p));
  const py = fs.readFileSync(pyPath, "utf8");
  const block = /ZCODE_MODELS\s*=\s*\[([\s\S]*?)\n\]/.exec(py);
  // 只认没被注释掉的条目：名单里允许留注释掉的示例条目（如权益被移除、待恢复的模型）
  const liveBlock = block ? block[1].split("\n").filter((l) => !/^\s*#/.test(l)).join("\n") : "";
  const rows = block
    ? [...liveBlock.matchAll(/\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*(True|False)\s*,\s*(\d+)\s*\)/g)]
        .map((m) => ({ id: m[1], route: m[2], vision: m[3] === "True", contextWindow: Number(m[4]) }))
    : [];
  t("③ a_switch.py: ZCODE_MODELS 可解析且非空", rows.length > 0, rows.length ? "" : "正则未匹配到任何条目");
  const cat = (catalog.platforms.autoclaw.models || []).map((m) => ({ id: m.id, route: m.route, vision: !!m.vision, contextWindow: m.contextWindow }));
  const key = (r) => `${r.id}|${r.route}|${r.vision}|${r.contextWindow}`;
  const missing = cat.filter((r) => !rows.some((x) => key(x) === key(r)));
  const extra = rows.filter((r) => !cat.some((x) => key(x) === key(r)));
  t("③ a_switch.py ↔ models-catalog.json 逐条一致（id/route/视觉/上下文）",
    missing.length === 0 && extra.length === 0,
    [missing.length ? `目录有而 python 无: ${missing.map((r) => r.id).join(", ")}` : "",
     extra.length ? `python 有而目录无: ${extra.map((r) => r.id).join(", ")}` : ""].filter(Boolean).join("；"));
}

// ---- --live：各网关 /v1/models ----
const STATIC = ["autoclaw", "comate", "doubao", "qoder", "qwenwork"];
async function fetchModels(name, port, headers) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: headers || {}, signal: ctl.signal });
    if (!r.ok) return { skip: `HTTP ${r.status}` };
    const j = await r.json();
    return { ids: (j.data || []).map((m) => m.id).filter(Boolean) };
  } catch {
    return { skip: "未运行" };
  } finally { clearTimeout(timer); }
}

if (LIVE) {
  const realmKeysFile = path.join(os.homedir(), ".autoclaw-relay", "qoder-realm-keys.json");
  let qworkKey = null;
  let cnKey = null;
  try { const j = JSON.parse(fs.readFileSync(realmKeysFile, "utf8")); qworkKey = j.qworkcn || j.realms?.qworkcn || null; cnKey = j.cn || j.realms?.cn || null; } catch {}

  const targets = [
    // 入站 api_key 闸门（2026-10-07）：A/B 档的 /v1/models 要求带钥匙，缺头会 401
    ["autoclaw", 18766, { "x-api-key": "autoclaw-local" }],
    ["workbuddy", 7863, { authorization: "Bearer wb-local-key" }],
    ["trae", 18768, {}],
    ["doubao", 18770, {}],
    ["comate", 18774, { "x-api-key": "comate-local" }],
    ["qoder", 8791, { authorization: `Bearer ${cnKey || "qoder-local"}` }],
    ["qwenwork", 8791, qworkKey ? { authorization: `Bearer ${qworkKey}` } : {}],
  ];
  for (const [name, port, headers] of targets) {
    const r = await fetchModels(name, port, headers);
    if (r.skip) { t(`④⑤ ${name}: LIVE`, true, `SKIP（${r.skip}）`); continue; }
    const bad = badIds(r.ids);
    t(`④ ${name}: 网关对外 id 全部合规`, bad.length === 0, bad.length ? `违规 id: ${bad.join(", ")}` : `${r.ids.length} 个 id`);
    if (STATIC.includes(name)) {
      const want = new Set((catalog.platforms[name].models || []).map((m) => m.id));
      const missing = [...want].filter((id) => !r.ids.includes(id));
      const extra = r.ids.filter((id) => !want.has(id));
      t(`⑤ ${name}: 目录内 id 全部在线`, missing.length === 0,
        [missing.length ? `目录有而网关无: ${missing.join(", ")}` : "",
         extra.length ? `INFO 网关新增（建议补进 models-catalog.json）: ${extra.join(", ")}` : ""].filter(Boolean).join("；"));
    } else {
      const extra = r.ids.filter((id) => !(catalog.platforms[name].models || []).some((m) => m.id === id));
      t(`⑤ ${name}: 动态目录`, true, extra.length ? `INFO 网关新增: ${extra.slice(0, 8).join(", ")}${extra.length > 8 ? " …" : ""}` : "与快照一致");
    }
  }
} else {
  t("④⑤ LIVE 检查未启用（加 --live 检查在跑的网关）", true, "SKIP");
}

const pass = results.filter((r) => r[1]).length;
for (const [name, ok, detail] of results) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? (detail ? `  -- ${detail}` : "") : `  <-- ${detail}`}`);
}
console.log(`\n==== ${pass}/${results.length} ====`);
process.exit(pass === results.length ? 0 : 1);
