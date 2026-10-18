#!/usr/bin/env node
/**
 * Codex 真机 E2E：注册一条链路 → 让**真的 codex exec** 跑一次工具循环（写文件 + 读回）
 * → 摘除并断言 config.toml 逐字节还原。
 *
 * 用法：node bridge/test_codex_e2e.mjs [linkId] [--model <id>] [--key <api_key>] [--keep]
 *   linkId 默认 comate（直连、原生 /v1/responses、工具档）。
 *   workbuddy/trae/doubao 走前门翻译（需要 18776 在跑，脚本不代劳）。
 *
 * 隔离性：绝不碰用户的 ~/.codex —— CODEX_HOME 指向 .research/codex-probe/e2e-home，
 * 先把用户真实 config.toml 复制过去当 fixture（有 [projects.*]/[plugins.*] 那种真实内容）。
 * 跑完（含失败路径）都会摘除并校验还原。
 *
 * 钥匙：workbuddy 的钥匙在网关上（wb2api config.json），开发树与已装控制台可能各有一份，
 * 脚本逐个探 /v1/models，用探得通的那把，并把来源打在屏幕上（免得"403/401 是环境还是代码"说不清）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const CX = require(path.join(ROOT, "app", "codex-config.js"));
const IK = require(path.join(ROOT, "app", "inbound-keys.js"));

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const linkId = argv.find((a) => !a.startsWith("--") && CX.linkOf(a)) || "comate";
const link = CX.linkOf(linkId);
const model = argOf("--model", link.model);
const HOME_DIR = os.homedir();
const E2E_HOME = path.join(ROOT, ".research", "codex-probe", "e2e-home");
const cfgPath = path.join(E2E_HOME, "config.toml");
const statePath = path.join(E2E_HOME, "state.json");
const codexBin = process.env.CODEX_BIN || "codex.cmd";

let failed = 0;
const step = (name, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed++;
  return ok;
};

function runCodex(args, { timeout = 300000, cwd = E2E_HOME } = {}) {
  const r = execFileSync(`"${codexBin}" ${args.join(" ")}`, {
    shell: true, cwd, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CODEX_HOME: E2E_HOME },
  });
  return r;
}

function httpJson(originHost, port, apiPath, { method = "GET", key = "", body = null, timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: originHost, port, path: apiPath, method, timeout: timeoutMs,
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}) },
    }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(d); } catch { /* 非 JSON 也照报 */ } resolve({ status: res.statusCode, j, raw: d.slice(0, 300) }); });
    });
    req.on("error", (e) => resolve({ status: 0, raw: e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, raw: "timeout" }); });
    if (data) req.write(data);
    req.end();
  });
}

/** 这条链路从 Codex 出发要打到哪里（前门 / 直连）→ /v1/* 的 origin */
function originOf(l) {
  const port = Number(argOf("--port", 0)) || l.port;   // --port：把链路指到临时/备用网关上验证
  return l.via === "front"
    ? { port: CX.FRONT_PORT, prefix: `/${l.frontPath}` }
    : { port, prefix: "" };
}

/** 候选钥匙（带出处）：探得通的那把才用，来源打在屏幕上 */
function candidateKeys(l) {
  const out = [];
  const push = (k, src) => { const v = typeof k === "string" ? k.trim() : ""; if (v && !out.some((o) => o.k === v)) out.push({ k: v, src }); };
  const fromFile = (f) => { try { const j = JSON.parse(fs.readFileSync(f, "utf8")); return typeof j.api_key === "string" ? j.api_key : ""; } catch { return ""; } };
  if (argv.includes("--key")) push(argOf("--key", ""), "命令行 --key");
  if (l.id === "workbuddy") {
    push(fromFile(path.join(ROOT, "workbuddy", "workbuddy-manager-v1.0.79", "upstream", "config.json")), "开发树 wb2api config.json");
    push(fromFile(path.join(HOME_DIR, ".workbuddy-gateway", "config.json")), "已装控制台 ~/.workbuddy-gateway/config.json");
  } else if (l.id === "qoder" || l.id === "qwenwork") {
    const realm = l.id === "qoder" ? "cn" : "qworkcn";
    try {
      const f = path.join(HOME_DIR, ".autoclaw-relay", "qoder-realm-keys.json");   // 控制台的出口 Key 档案
      push(JSON.parse(fs.readFileSync(f, "utf8"))[realm], `${path.basename(f)}[${realm}]`);
    } catch { /* 没有就用兜底 */ }
    push(IK.BUILTIN[l.id], "内置兜底钥");
  } else {
    const store = IK.readStore(path.join(HOME_DIR, ".autoclaw-relay", "inbound-keys.json"));
    push(IK.activeKey(store, l.id), "入站钥匙档案");
    push(IK.BUILTIN[l.id], "内置兜底钥");
  }
  return out;
}

const main = async () => {
  console.log(`== Codex 真机 E2E：${link.label}（${link.id}，${link.via === "direct" ? "直连" : "经前门"} :${link.port}）模型 ${model}`);
  console.log(`   CODEX_HOME=${E2E_HOME}（隔离，不碰 ~/.codex）`);

  // ---- 0) 隔离 home：用户真配置副本当 fixture
  fs.rmSync(E2E_HOME, { recursive: true, force: true });
  fs.mkdirSync(path.join(E2E_HOME, "work"), { recursive: true });
  const realCfg = path.join(HOME_DIR, ".codex", "config.toml");
  if (fs.existsSync(realCfg)) fs.copyFileSync(realCfg, cfgPath);
  const before = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, "utf8") : null;
  step("隔离 CODEX_HOME", true, `fixture ${before ? before.split("\n").length + " 行（用户真配置副本）" : "空（用户没有 config.toml）"}`);

  // ---- 1) 上游在不在 + 哪把钥匙能用
  const origin = originOf(link);
  const cands = candidateKeys(link);
  let key = null, models = [];
  for (const c of cands) {
    const r = await httpJson("127.0.0.1", origin.port, `${origin.prefix}/v1/models`, { key: c.k, timeoutMs: 20000 });
    console.log(`   探钥匙 ${c.src} → HTTP ${r.status}`);
    if (r.status === 200) { key = c.k; models = (r.j?.data || []).map((m) => m.id); break; }
  }
  if (!step("上游 /v1/models 探通", !!key, key ? `用「${cands.find((c) => c.k === key).src}」的钥匙，${models.length} 个模型` : `上游没起或钥匙都不对（候选：${cands.map((c) => c.src).join("、") || "无"}）`)) return;
  // 与控制台 codex:register 同一口径：写全名（wb2api 报 cn:glm-5.3，表里默认 glm-5.3）
  const useModel = CX.pickModel(model, models);
  if (useModel !== model) console.log(`   模型：${model} → ${useModel}（上游目录里的全名，写全名才拿得到元数据）`);
  if (!models.includes(useModel)) console.log(`   ⚠️ 上游目录里没有 ${useModel}（照样试：上游可能按别名接受，但 Codex 会用回退元数据）`);

  // ---- 2) 目录（自带 11 条克隆 + 这条链路的模型）→ 注册
  let bundled = [];
  try {
    const j = JSON.parse(runCodex(["debug", "models", "--bundled"], { timeout: 60000 }));
    bundled = j.models || [];
  } catch (e) { console.log(`   （自带目录取不到：${e.message}）`); }
  const catalogModels = models.map((id) => ({ slug: id, displayName: id, contextWindow: 200000, vision: false }));

  let act = null;
  try {
    act = CX.activate(cfgPath, {
      linkId, model: useModel, token: key, statePath, writeCatalog: true, catalogModels,
      bundled: bundled.length ? bundled : null, contextWindow: 200000, autoCompactLimit: 150000,
    });
    step("注册（写 provider 表 + 顶层指针 + 目录）", act.ok === true,
      `${act.providerId} → ${act.baseUrl}｜目录 ${act.catalog?.count} 条（自带 ${act.catalog?.bundled} + 我方 ${act.catalog?.ours}）`);

    // 备用网关：注册走真路径（过 G1 形状闸门），之后只把 base_url 行改指过去，
    // 让 Codex 的请求打到临时/修好的网关上（G1 不允许任意 base_url，所以这一步只能在测试里做）
    const altPort = Number(argOf("--port", 0)) || 0;
    if (altPort) {
      const altUrl = `http://127.0.0.1:${altPort}/v1`;
      const text = fs.readFileSync(cfgPath, "utf8").replace(/base_url = "http.*"/, `base_url = "${altUrl}"`);
      fs.writeFileSync(cfgPath, text);
      step("base_url 改指备用网关", text.includes(`base_url = "${altUrl}"`), `${altUrl}（注册形状仍是 8791 那种，过闸门）`);
    }

    // ---- 3) 真 Codex 认这份配置吗（读目录 + 认我们的模型）
    const seen = JSON.parse(runCodex(["debug", "models"], { timeout: 60000 })).models || [];
    const slugs = seen.map((m) => m.slug);
    step("codex debug models 认这份配置", slugs.includes(useModel),
      `目录 ${slugs.length} 条${slugs.includes(useModel) ? "" : `（缺 ${useModel}）`}`);

    // ---- 4) 真机跑一次
    // tools 档：工具循环（写文件 + 读回）。chat 档（Trae/豆包：上游没有工具通道）
    // 只验「Codex ←→ 前门 ←→ 上游」的对话往返，工具循环本就不该有。
    const work = path.join(E2E_HOME, "work");
    const tools = link.tier === "tools";
    const prompt = tools
      ? "请做两件事，然后停下：1) 在当前工作目录用命令创建 hello_codex.txt，内容恰好是 CODE_E2E_OK；"
        + "2) 用命令把该文件内容读出来，并在最终回答里原样引用它。"
      : "只回答，不要调用任何工具：用一个数字回答，1+1 等于几？";
    console.log(`   codex exec 发起（${tools ? "工具循环" : "chat 档：只验对话往返"}，最长 5 分钟）…`);
    const t0 = Date.now();
    let out = "";
    try {
      out = runCodex([
        "exec", "--skip-git-repo-check", "--color", "never",
        "-C", `"${work}"`, "-s", "danger-full-access", "-m", useModel,
        `"${prompt}"`,
      ], { timeout: 300000, cwd: work });
    } catch (e) {
      out = String((e && e.stdout) || "") + String((e && e.stderr) || "");
      console.log(`   codex exec 退出码非 0：${String(e.message).split("\n")[0]}`);
    }
    const secs = Math.round((Date.now() - t0) / 1000);
    const tail = out.trim().split("\n").slice(-12).join("\n");
    console.log(`   —— codex exec 输出尾部（${secs}s）——\n${tail.split("\n").map((l) => "   | " + l).join("\n")}`);
    if (tools) {
      const file = path.join(work, "hello_codex.txt");
      const content = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      step("Codex 在本机真的执行了工具（写文件）", /CODE_E2E_OK/.test(content), content ? `hello_codex.txt = ${JSON.stringify(content.trim().slice(0, 40))}` : "文件没生成");
      // 题面里就带 CODE_E2E_OK。失败时 codex exec 会把转写（含题面回声）打出来，
      // 成功时只打最终答话——所以先把题面整段剔掉，再看剩下的里面有没有这个记号：
      // 剩下的命中 = 模型自己写出来的（真读过文件），不是回声
      const rest = out.split(prompt).join("");
      const quoted = /CODE_E2E_OK/.test(rest);
      step("模型答话引用了读回的内容", quoted, quoted ? "" : "答话里没有该记号（题面回声不算）");
    } else {
      const answered = /(^|\D)2(\D|$)/.test(out);
      step("chat 档：Codex 拿到答复（不含工具循环，上游本就没有工具通道）", answered,
        answered ? "答话里出现 2" : "没看到答案");
    }
  } finally {
    // ---- 5) 摘除 + 逐字节还原（失败路径也要收干净）
    try {
      const d = CX.deregister(cfgPath, { linkId, statePath });
      const after = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, "utf8") : null;
      step("摘除", d.ok === true && d.changed === true, d.reason || "");
      step("config.toml 逐字节还原", after === before, after === before ? "" : "有差异！备份见 " + (d.backup || "-"));
      step("我方目录已清掉", d.catalogRemoved === true, "");
    } catch (e) {
      step("摘除", false, String((e && e.message) || e));
    }
    if (argv.includes("--keep")) console.log(`   （--keep：临时 home 保留在 ${E2E_HOME}）`);
    else fs.rmSync(path.join(E2E_HOME, "sessions"), { recursive: true, force: true });
  }
  console.log(failed ? `\n==== E2E FAIL：${failed} 项没过 ====` : "\n==== E2E PASS ====");
  process.exit(failed ? 1 : 0);
};

main().catch((e) => { console.error("E2E 崩了：", e); process.exit(1); });
