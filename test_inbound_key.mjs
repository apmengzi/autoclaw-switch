// 入站 api_key 闸门的离线测试：`node test_inbound_key.mjs`
//
// 零出站、零额度消耗：三个 relay 各起一个一次性实例（假 STATE_DIR / 假 APPDATA /
// 假上游），只验闸门本身。判别式：闸门 401 的报文里有 "missing or invalid api
// key" 特征串；任何其它状态（200 放行 / 502·503 上游缺失 / 超时挂起）都说明
// 请求已越过闸门进入业务路径——正好把"带对钥匙不再被拦"和"钥匙没配成放行"
// 区分开，无需真实上游。
//
// 覆盖：缺失/错钥 401；x-api-key 与 Authorization: Bearer 两种形状；
// 非环回监听仍 401（入站钥匙与旧 PROXY_TOKEN 并存不冲突）；
// /health、OPTIONS 预检豁免；AUTOCLAW_INBOUND_KEYS 追加轮换钥；
// *_INBOUND_AUTH=0 关闭开关；comate /v1/models 带钥 200（假上游目录）；
// trae / doubao（C 档补闸）：三种模型端点都拦、/admin/* 豁免、轮换钥并存；
// 控制台「生成」档案（~/.autoclaw-relay/inbound-keys.json，键 = 链路 id）：
// 四条 env 链路启动时读它并钥，生成钥与内置兜底钥并存（HOME/USERPROFILE
// 指向假目录做隔离，绝不碰真实档案）。
// 标准钥（别名·sk- 形，档案顶层保留键 _aliases[链路]）：四条 env 链路启动时
// 把「主钥 ∪ 别名」一并并进闸门集合——别名越过闸门、别家链路的别名不串门、
// 从档案删掉别名重启后即失效（撤销语义），旧格式档案（无 _aliases）照常工作。
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const results = [];
const ok = (name, cond, note = "") => results.push([name, !!cond, note]);

const GATE_MSG = "missing or invalid api key";

function req(port, method, pathname, headers = {}, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const data = method === "POST" ? JSON.stringify({ model: "x", messages: [{ role: "user", content: "hi" }] }) : null;
    const r = http.request(
      { host: "127.0.0.1", port, path: pathname, method, headers: { ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}), ...headers } },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve({ status: res.statusCode, body: b }));
      },
    );
    r.on("error", (e) => resolve({ status: 0, body: String(e.message) }));
    r.setTimeout(timeoutMs, () => { r.destroy(); resolve({ status: -1, body: "timeout" }); });
    if (data) r.write(data);
    r.end();
  });
}
const gated = ({ status, body }) => status === 401 && body.includes(GATE_MSG);
const passed = ({ status, body }) => !(status === 401 && body.includes(GATE_MSG));

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function startScript(script, env, readyPath = "/health") {
  const child = spawn(process.execPath, [path.join(ROOT, script)], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  const port = Number(env.AUTOCLAW_PORT || env.COMATE_RELAY_PORT || env.TRAE_RELAY_PORT || env.DOUBAO_RELAY_PORT);
  const t0 = Date.now();
  const wait = async () => {
    while (Date.now() - t0 < 20000) {
      if (child.exitCode !== null) throw new Error(`relay 退出(${child.exitCode}): ${out.slice(0, 400)}`);
      const r = await req(port, "GET", readyPath, {}, 2000);
      if (r.status > 0) return;
      await new Promise((s) => setTimeout(s, 250));
    }
    throw new Error(`relay ${script}:${port} 20s 未就绪: ${out.slice(0, 300)}`);
  };
  return { port, wait, stop: () => { try { child.kill(); } catch {} } };
}

// ------------------------------------------------- 假上游（comate 目录端点）
const fakeUpstream = http.createServer((rq, rs) => {
  let b = "";
  rq.on("data", (c) => (b += c));
  rq.on("end", () => {
    if (rq.url.includes("/models/available")) {
      rs.writeHead(200, { "Content-Type": "application/json" });
      rs.end(JSON.stringify({ code: 200, data: { models: [{ modelId: "ERNIE-4.5-Turbo", displayName: "EREG4.5T" }] } }));
    } else { rs.writeHead(404); rs.end("{}"); }
  });
});
await new Promise((r) => fakeUpstream.listen(0, "127.0.0.1", r));
const FAKE_PORT = fakeUpstream.address().port;

// ------------------------------------------ 控制台「生成」档案的假 home
// 形状同 app/inbound-keys.js 的生成钥（前缀 + 36 位 hex），内容固定便于断言。
// relay 只把它当「集合里再多一把钥」，没有任何额外语义。
const storeKey = (id) => `${id}-${"0".repeat(36)}`;
// 标准钥（别名·sk- 形）合成值：形状同 app/inbound-keys.js 的 generateStandardKey
const aliasKey = (id) => `sk-${id}-${"1".repeat(36)}`;
function fakeHomeWithStore(ids, aliases = {}) {
  const home = tmp("asw-inbound-home");
  const store = {};
  for (const id of ids) store[id] = storeKey(id);
  if (Object.keys(aliases).length) store._aliases = aliases;
  fs.mkdirSync(path.join(home, ".autoclaw-relay"), { recursive: true });
  fs.writeFileSync(path.join(home, ".autoclaw-relay", "inbound-keys.json"), JSON.stringify(store));
  return home;
}

// ---------------------------------------------------------- AutoClaw 两份实例
const baseA = {
  AUTOCLAW_BIND_HOST: "127.0.0.1",
  AUTOCLAW_STATE_DIR: tmp("asw-inbound-state"),
  AUTOCLAW_LOG_FILE: path.join(tmp("asw-inbound-log"), "server.log"),
};
// bridge 实例（= 控制台部署的 server.mjs 本体）把 HOME 指进带档案的假目录：
// 生成钥通道只在 bridge 里（relay/server.mjs 是上游本体，控制台不部署它）
const acHome = fakeHomeWithStore(["autoclaw"], { autoclaw: [aliasKey("autoclaw")], trae: [aliasKey("trae")] });
const autoclawInstances = [
  ["relay/server.mjs", { ...baseA, AUTOCLAW_PORT: "18899" }],
  ["bridge/server_2x.mjs", { ...baseA, AUTOCLAW_PORT: "18900", AUTOCLAW_INBOUND_KEYS: "rotated-key-1, rotated-key-2",
    HOME: acHome, USERPROFILE: acHome }],
];
for (const [script, env] of autoclawInstances) {
  const s = startScript(script, env);
  await s.wait();
  const tag = script === "relay/server.mjs" ? "unified" : "bridge";
  ok(`[${tag}] 无钥 POST /v1/messages → 401`, gated(await req(s.port, "POST", "/v1/messages")));
  ok(`[${tag}] 错钥 GET /v1/models → 401`, gated(await req(s.port, "GET", "/v1/models", { "x-api-key": "nope-nope-nope" })));
  ok(`[${tag}] Bearer 短钥(长度不同) → 401`, gated(await req(s.port, "GET", "/v1/models", { authorization: "Bearer short" })));
  ok(`[${tag}] 内置 autoclaw-local (x-api-key) 越过闸门`, passed(await req(s.port, "POST", "/v1/messages", { "x-api-key": "autoclaw-local" }, 15000)));
  ok(`[${tag}] 内置 autoclaw-local (Bearer) 越过闸门`, passed(await req(s.port, "GET", "/v1/models", { authorization: "Bearer autoclaw-local" })));
  ok(`[${tag}] PROXY_TOKEN autoclaw-dsh 也是入站钥匙`, passed(await req(s.port, "GET", "/v1/models", { authorization: "Bearer autoclaw-dsh" })));
  ok(`[${tag}] /health 无钥放行(503=上游缺失,非闸门)`, gated(await req(s.port, "GET", "/health")) === false);
  ok(`[${tag}] OPTIONS 预检(无钥) → 204`, (await req(s.port, "OPTIONS", "/v1/messages")).status === 204);
  ok(`[${tag}] GET /fwd 非模型路径不被闸门拦`, gated(await req(s.port, "GET", "/fwd")) === false);
  if (tag === "bridge") {
    ok("[bridge] AUTOCLAW_INBOUND_KEYS 轮换钥生效", passed(await req(s.port, "GET", "/v1/models", { "x-api-key": "rotated-key-2" })));
    ok("[bridge] 「生成」档案钥 (autoclaw-000…) 越过闸门", passed(await req(s.port, "GET", "/v1/models", { "x-api-key": storeKey("autoclaw") })));
    ok("[bridge] 档案钥与内置兜底钥并存", passed(await req(s.port, "GET", "/v1/models", { "x-api-key": "autoclaw-local" })));
    ok("[bridge] 标准钥别名 (sk-autoclaw-111…) 越过闸门", passed(await req(s.port, "GET", "/v1/models", { "x-api-key": aliasKey("autoclaw") })));
    ok("[bridge] 别名 Bearer 形状同权", passed(await req(s.port, "GET", "/v1/models", { authorization: `Bearer ${aliasKey("autoclaw")}` })));
    ok("[bridge] 别家链路的标准钥不串门（trae 的别名） → 401", gated(await req(s.port, "GET", "/v1/models", { "x-api-key": aliasKey("trae") })));
  }
  s.stop();
}

// 关闭开关：AUTOCLAW_INBOUND_AUTH=0 → 无钥直通（旧行为）
{
  const s = startScript("relay/server.mjs", { ...baseA, AUTOCLAW_PORT: "18901", AUTOCLAW_INBOUND_AUTH: "0" });
  await s.wait();
  ok("[unified] AUTH=0 开关退回匿名放行", passed(await req(s.port, "GET", "/v1/models")));
  s.stop();
}

// 非环回监听：入站钥匙与旧 PROXY_TOKEN 并存不冲突（错钥仍拦，dsh Bearer 放行）
{
  const s = startScript("relay/server.mjs", { ...baseA, AUTOCLAW_BIND_HOST: "0.0.0.0", AUTOCLAW_PORT: "18902" });
  await s.wait();
  ok("[unified] 0.0.0.0 监听错钥 → 401", gated(await req(s.port, "GET", "/v1/models", { "x-api-key": "wrong" })));
  ok("[unified] 0.0.0.0 监听 dsh Bearer 放行", passed(await req(s.port, "GET", "/v1/models", { authorization: "Bearer autoclaw-dsh" })));
  ok("[unified] 0.0.0.0 监听 autoclaw-local 放行", passed(await req(s.port, "GET", "/v1/models", { "x-api-key": "autoclaw-local" })));
  s.stop();
}

// ------------------------------------------------------------- Comate 实例
{
  const appdata = tmp("comate-inbound-appdata");
  fs.mkdirSync(path.join(appdata, "Comate", "User"), { recursive: true });
  fs.writeFileSync(path.join(appdata, "Comate", "User", "settings.json"),
    JSON.stringify({ "baidu.comate.license": "test-license", "baidu.comate.username": "tester" }));
  const HOME_BAK = process.env.HOME;
  const s = startScript("comate/relay.mjs", {
    APPDATA: appdata, COMATE_RELAY_PORT: "18903", COMATE_RELAY_HOST: "127.0.0.1",
    COMATE_RELAY_BASE: `http://127.0.0.1:${FAKE_PORT}`,
    // relay 的 STATE_DIR 硬编码 homedir()/.comate-relay（device.json 落盘）：
    // 把 HOME 指进假目录，测试进程零污染。
    HOME: appdata, USERPROFILE: appdata,
  }, "/health");
  await s.wait();
  ok("[comate] 无钥 POST /v1/messages → 401", gated(await req(s.port, "POST", "/v1/messages")));
  ok("[comate] 无钥 GET /v1/models → 401", gated(await req(s.port, "GET", "/v1/models")));
  ok("[comate] 错钥 /v1/chat/completions → 401", gated(await req(s.port, "POST", "/v1/chat/completions", { "x-api-key": "bad" })));
  ok("[comate] comate-local 带钥 /v1/models → 200+目录", await (async () => {
    const r = await req(s.port, "GET", "/v1/models", { "x-api-key": "comate-local" });
    return r.status === 200 && r.body.includes("object") && r.body.includes("list");
  })());
  ok("[comate] COMATE_RELAY_KEY Bearer 形状同权", await (async () => {
    const r = await req(s.port, "GET", "/v1/models", { authorization: "Bearer comate-local" });
    return r.status === 200;
  })());
  ok("[comate] /health 无钥放行", (await req(s.port, "GET", "/health")).status === 200);
  s.stop();
  if (HOME_BAK === undefined) delete process.env.HOME; else process.env.HOME = HOME_BAK;
}

// COMATE_RELAY_KEY 轮换 + AUTH=0 关闭
{
  const appdata = tmp("comate-inbound-appdata2");
  fs.mkdirSync(path.join(appdata, "Comate", "User"), { recursive: true });
  fs.writeFileSync(path.join(appdata, "Comate", "User", "settings.json"),
    JSON.stringify({ "baidu.comate.license": "test-license", "baidu.comate.username": "tester" }));
  // 同一假 home 里放一份「生成」档案：comate 启动时并钥；另带本链路与 trae 各一把标准钥别名
  fs.mkdirSync(path.join(appdata, ".autoclaw-relay"), { recursive: true });
  fs.writeFileSync(path.join(appdata, ".autoclaw-relay", "inbound-keys.json"),
    JSON.stringify({ comate: storeKey("comate"), _aliases: { comate: [aliasKey("comate")], trae: [aliasKey("trae")] } }));
  const s = startScript("comate/relay.mjs", {
    APPDATA: appdata, COMATE_RELAY_PORT: "18904", COMATE_RELAY_HOST: "127.0.0.1",
    COMATE_RELAY_BASE: `http://127.0.0.1:${FAKE_PORT}`, COMATE_RELAY_KEY: "rotated-comate-key",
    HOME: appdata, USERPROFILE: appdata,
  });
  await s.wait();
  ok("[comate] 轮换钥生效", (await req(s.port, "GET", "/v1/models", { "x-api-key": "rotated-comate-key" })).status === 200);
  ok("[comate] 内置旧钥仍在（并存）", (await req(s.port, "GET", "/v1/models", { "x-api-key": "comate-local" })).status === 200);
  ok("[comate] 「生成」档案钥 (comate-000…) 并存生效", (await req(s.port, "GET", "/v1/models", { "x-api-key": storeKey("comate") })).status === 200);
  ok("[comate] 标准钥别名 (sk-comate-111…) 越过闸门", (await req(s.port, "GET", "/v1/models", { "x-api-key": aliasKey("comate") })).status === 200);
  ok("[comate] 别家链路的标准钥不串门（trae 的别名） → 401", gated(await req(s.port, "GET", "/v1/models", { "x-api-key": aliasKey("trae") })));
  s.stop();

  const s2 = startScript("comate/relay.mjs", {
    APPDATA: appdata, COMATE_RELAY_PORT: "18905", COMATE_RELAY_HOST: "127.0.0.1",
    COMATE_RELAY_BASE: `http://127.0.0.1:${FAKE_PORT}`, COMATE_INBOUND_AUTH: "0",
    HOME: appdata, USERPROFILE: appdata,
  });
  await s2.wait();
  ok("[comate] AUTH=0 开关退回匿名放行", (await req(s2.port, "GET", "/v1/models")).status === 200);
  s2.stop();
}

// ------------------------------------------------------------- Trae 实例
// Trae relay 需要 storage.json 里的加密凭证才能起业务路径，但闸门 401 发生在
// 读凭证之前——不喂真凭证，只验闸门行为；/health 会 200 但 credential.ok=false。
{
  const home = tmp("trae-inbound-home");
  const storage = path.join(home, "TRAE SOLO CN", "User");
  fs.mkdirSync(storage, { recursive: true });
  fs.writeFileSync(path.join(storage, "storage.json"), JSON.stringify({}));
  // 假 home 里放一份「生成」档案（HOME/USERPROFILE 都指过来，Windows 上 homedir() 认 USERPROFILE）；
  // 另带本链路与 doubao 各一把标准钥别名：前者必须越过闸门，后者必须被拦（不串门）
  fs.mkdirSync(path.join(home, ".autoclaw-relay"), { recursive: true });
  fs.writeFileSync(path.join(home, ".autoclaw-relay", "inbound-keys.json"),
    JSON.stringify({ trae: storeKey("trae"), _aliases: { trae: [aliasKey("trae")], doubao: [aliasKey("doubao")] } }));
  const envBase = { HOME: home, USERPROFILE: home, TRAE_RELAY_HOST: "127.0.0.1", TRAE_STORAGE: path.join(storage, "storage.json") };
  const s = startScript("trae/relay.mjs", { ...envBase, TRAE_RELAY_PORT: "18906" }, "/health");
  await s.wait();
  ok("[trae] 无钥 GET /v1/models → 401", gated(await req(s.port, "GET", "/v1/models")));
  ok("[trae] 错钥 POST /v1/chat/completions → 401", gated(await req(s.port, "POST", "/v1/chat/completions", { "x-api-key": "bad" })));
  ok("[trae] 无钥 POST /v1/messages → 401（anthropic 形状报文）", gated(await req(s.port, "POST", "/v1/messages")));
  ok("[trae] trae-local-key (x-api-key) 越过闸门", passed(await req(s.port, "GET", "/v1/models", { "x-api-key": "trae-local-key" })));
  ok("[trae] Bearer 形状同权", passed(await req(s.port, "GET", "/v1/models", { authorization: "Bearer trae-local-key" })));
  ok("[trae] 「生成」档案钥 (trae-000…) 越过闸门（与内置钥并存）", passed(await req(s.port, "GET", "/v1/models", { "x-api-key": storeKey("trae") })));
  ok("[trae] 标准钥别名 (sk-trae-111…) 越过闸门", passed(await req(s.port, "GET", "/v1/models", { "x-api-key": aliasKey("trae") })));
  ok("[trae] 别名 Bearer 形状同权", passed(await req(s.port, "GET", "/v1/models", { authorization: `Bearer ${aliasKey("trae")}` })));
  ok("[trae] 别家链路的标准钥不串门（doubao 的别名） → 401", gated(await req(s.port, "GET", "/v1/models", { "x-api-key": aliasKey("doubao") })));
  ok("[trae] /health 无钥放行", (await req(s.port, "GET", "/health")).status === 200);
  s.stop();

  // 轮换钥并存 + 关闭开关
  const s2 = startScript("trae/relay.mjs", {
    ...envBase, TRAE_RELAY_PORT: "18906",
    TRAE_INBOUND_KEYS: "rotated-trae-1", TRAE_INBOUND_AUTH: "0",
  }, "/health");
  await s2.wait();
  ok("[trae] AUTH=0 开关退回匿名放行", passed(await req(s2.port, "GET", "/v1/models")));
  s2.stop();

  const s3 = startScript("trae/relay.mjs", {
    ...envBase, TRAE_RELAY_PORT: "18906",
    TRAE_INBOUND_KEYS: "rotated-trae-1",
  }, "/health");
  await s3.wait();
  ok("[trae] TRAE_INBOUND_KEYS 轮换钥生效", passed(await req(s3.port, "GET", "/v1/models", { "x-api-key": "rotated-trae-1" })));
  ok("[trae] 内置旧钥仍并存", passed(await req(s3.port, "GET", "/v1/models", { "x-api-key": "trae-local-key" })));
  s3.stop();
}

// ------------------------------------------------------------ Doubao 实例
// 豆包 relay 只需要 cookie 才能打上游；闸门与 /v1/models（合成目录）都在
// cookie 之前，直接验。DIR 由 DOUBAO_RELAY_DIR 指到假目录？——relay 的
// ~/.doubao-relay 是硬编码 homedir()/.doubao-relay，把 HOME 指进假目录即可。
{
  const home = tmp("doubao-inbound-home");
  // 假 home 里放一份「生成」档案：doubao 启动时并钥（档案与内置钥、config.json key 三者并存）；
  // 另带本链路与 comate 各一把标准钥别名：前者越过闸门，后者被拦（不串门）
  fs.mkdirSync(path.join(home, ".autoclaw-relay"), { recursive: true });
  fs.writeFileSync(path.join(home, ".autoclaw-relay", "inbound-keys.json"),
    JSON.stringify({ doubao: storeKey("doubao"), _aliases: { doubao: [aliasKey("doubao")], comate: [aliasKey("comate")] } }));
  const s = startScript("doubao/relay.mjs", {
    HOME: home, USERPROFILE: home,
    DOUBAO_RELAY_PORT: "18907", DOUBAO_RELAY_HOST: "127.0.0.1",
  }, "/health");
  await s.wait();
  ok("[doubao] 无钥 GET /v1/models → 401（目录端点也入闸）", gated(await req(s.port, "GET", "/v1/models")));
  ok("[doubao] 错钥 POST /v1/chat/completions → 401", gated(await req(s.port, "POST", "/v1/chat/completions", { "x-api-key": "bad" })));
  ok("[doubao] doubao-local-key (x-api-key) 越过闸门（200=合成目录）", (await req(s.port, "GET", "/v1/models", { "x-api-key": "doubao-local-key" })).status === 200);
  ok("[doubao] Bearer 形状同权", (await req(s.port, "GET", "/v1/models", { authorization: "Bearer doubao-local-key" })).status === 200);
  ok("[doubao] 「生成」档案钥 (doubao-000…) 越过闸门（与内置钥并存）", (await req(s.port, "GET", "/v1/models", { "x-api-key": storeKey("doubao") })).status === 200);
  ok("[doubao] 标准钥别名 (sk-doubao-111…) 越过闸门", (await req(s.port, "GET", "/v1/models", { "x-api-key": aliasKey("doubao") })).status === 200);
  ok("[doubao] 别家链路的标准钥不串门（comate 的别名） → 401", gated(await req(s.port, "GET", "/v1/models", { "x-api-key": aliasKey("comate") })));
  ok("[doubao] /health 无钥放行", (await req(s.port, "GET", "/health")).status === 200);
  // /admin/* 豁免的证明：匿名 POST 没被闸门 401 拦下（空 HOME 下 cookie 缺失 → 500 业务错误，非 401）
  ok("[doubao] /admin/* 仍豁免（匿名进业务路径=500 缺 cookie，非闸门 401）",
    gated(await req(s.port, "POST", "/admin/reload-cookies", { "content-type": "application/json" })) === false);
  s.stop();

  const s2 = startScript("doubao/relay.mjs", {
    HOME: home, USERPROFILE: home,
    DOUBAO_RELAY_PORT: "18907", DOUBAO_RELAY_HOST: "127.0.0.1",
    DOUBAO_INBOUND_KEYS: "rotated-dk-1", DOUBAO_INBOUND_AUTH: "0",
  }, "/health");
  await s2.wait();
  ok("[doubao] AUTH=0 开关退回匿名放行", passed(await req(s2.port, "GET", "/v1/models")));
  s2.stop();

  const s3 = startScript("doubao/relay.mjs", {
    HOME: home, USERPROFILE: home,
    DOUBAO_RELAY_PORT: "18907", DOUBAO_RELAY_HOST: "127.0.0.1",
    DOUBAO_INBOUND_KEYS: "rotated-dk-1",
  }, "/health");
  await s3.wait();
  ok("[doubao] DOUBAO_INBOUND_KEYS 轮换钥生效", (await req(s3.port, "GET", "/v1/models", { "x-api-key": "rotated-dk-1" })).status === 200);
  ok("[doubao] 内置旧钥仍并存", (await req(s3.port, "GET", "/v1/models", { "x-api-key": "doubao-local-key" })).status === 200);
  s3.stop();

  // 撤销 = 控制台「✕」从档案删掉别名 → 重启后别名不再被认，主钥不受影响。
  // 顺带覆盖旧格式档案（纯扁平、无 _aliases）：主钥照常生效（向后兼容）。
  fs.writeFileSync(path.join(home, ".autoclaw-relay", "inbound-keys.json"), JSON.stringify({ doubao: storeKey("doubao") }));
  const s4 = startScript("doubao/relay.mjs", {
    HOME: home, USERPROFILE: home,
    DOUBAO_RELAY_PORT: "18907", DOUBAO_RELAY_HOST: "127.0.0.1",
  }, "/health");
  await s4.wait();
  ok("[doubao] 旧格式档案（无 _aliases）主钥仍生效", (await req(s4.port, "GET", "/v1/models", { "x-api-key": storeKey("doubao") })).status === 200);
  ok("[doubao] 别名随档案撤销（重启后不再被认） → 401", gated(await req(s4.port, "GET", "/v1/models", { "x-api-key": aliasKey("doubao") })));
  s4.stop();
}

// ------------------------------------------------------------------ 汇总
fakeUpstream.close();
let fail = 0;
for (const [name, pass, note] of results) {
  if (!pass) fail++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${note ? `  (${note})` : ""}`);
}
console.log(fail ? `\n${fail} FAIL / ${results.length}` : `\n全部 ${results.length} 项通过`);
process.exit(fail ? 1 : 0);
