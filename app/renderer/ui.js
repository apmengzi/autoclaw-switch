// 控制台渲染逻辑：状态轮询（本地 health，无上游出站）+ 按钮动作 + 日志查看
const $ = (id) => document.getElementById(id);
let currentLog = "relay";

function fmtUptime(s) {
  if (!s || s < 0) return "-";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}时${m}分` : m ? `${m}分${sec}秒` : `${sec}秒`;
}
function fmtExp(ts) {
  if (!ts) return "-";
  const d = new Date(ts * 1000);
  const ms = ts * 1000 - Date.now();
  if (ms <= 0) return `${d.toLocaleDateString()}（已过期）`;
  const days = Math.floor(ms / 86400000);
  if (days >= 1) return `${d.toLocaleDateString()}（余 ${days} 天）`;
  return `${d.toLocaleDateString()}（余 ${Math.floor(ms / 3600000)} 小时）`;
}
function setPill(id, cls, text) { const el = $(id); el.className = "pill " + cls; el.textContent = text; }
/** 模型目录 chips：超过 12 个折叠成 +N；网关没起来时清单为空，计数显示 "-" */
function renderModels(key, models) {
  const list = models || [];
  $(key + "-model-count").textContent = list.length || "-";
  $(key + "-models").innerHTML = list.slice(0, 12)
    .map((m) => `<span title="${String(m).replace(/"/g, "&quot;")}">${m}</span>`).join("") +
    (list.length > 12 ? `<span>+${list.length - 12}</span>` : "");
}

async function refreshStatus() {
  try {
    const s = await window.api.queryStatus();
    // relay
    const relayOk = s.relay.running && s.relay.ok;
    const msLeftPill = s.token.exp * 1000 - Date.now();
    setPill("relay-pill", relayOk && msLeftPill > 0 ? "ok" : relayOk ? "warn" : "err",
      relayOk ? (msLeftPill > 0 ? "运行中" : "Token过期") : s.relay.running ? "异常" : "已停止");
    $("relay-status").textContent = relayOk ? `ok（${s.relay.status}）` : s.relay.running ? "无上游" : "未运行";
    $("relay-upstream").textContent = s.relay.upstream || "-";
    $("relay-uptime").textContent = fmtUptime(s.relay.uptimeS);
    $("relay-models").innerHTML = (s.relay.models || []).map((m) => `<span>${m}</span>`).join("");

    // workbuddy
    const wbOk = s.workbuddy.running && s.workbuddy.ok;
    setPill("wb-pill", wbOk ? "ok" : s.workbuddy.running ? "warn" : "err",
      wbOk ? "运行中" : s.workbuddy.running ? "异常" : "已停止");
    $("wb-status").textContent = wbOk ? "ok" : s.workbuddy.running ? "无上游" : "未运行";
    $("wb-credits").textContent = s.workbuddy.account ? `${s.workbuddy.account.credits} 分` : "-";
    $("wb-account").textContent = s.workbuddy.account ? (s.workbuddy.account.nickname || String(s.workbuddy.account.uid).slice(0, 8)) : "-";
    const wbModels = s.workbuddy.models || [];
    $("wb-models").innerHTML = wbModels.slice(0, 10).map((m) => `<span>${m}</span>`).join("") +
      (wbModels.length > 10 ? `<span>+${wbModels.length - 10}</span>` : "");

    // trae（网关自带凭证解密与会话池，控制台只做展示）
    const tr = s.trae || { running: false, ok: false };
    setPill("trae-pill", tr.running && tr.ok ? "ok" : tr.running ? "warn" : "err",
      tr.running && tr.ok ? "运行中" : tr.running ? "凭证异常" : "已停止");
    $("trae-status").textContent = tr.ok ? "ok" : tr.running ? "无上游/凭证失效" : "未运行";
    $("trae-account").textContent = tr.credential?.account || (tr.credential?.userId ? String(tr.credential.userId) : "-");
    $("trae-exp").textContent = tr.credential?.expiresAt ? tr.credential.expiresAt.slice(0, 16).replace("T", " ") : "-";
    $("trae-sessions").textContent = tr.running ? (tr.mode === "stateless" ? "无状态（每请求新建，不复用）" : tr.mode || "-") : "-";
    const trModels = tr.models || [];
    $("trae-model-count").textContent = trModels.length || "-";
    // 目录随账号变（免费组之外还有 agent/work 组），超过 12 个就把余下的挂到「+N」的悬浮提示里
    $("trae-models").innerHTML = trModels.slice(0, 12).map((m) => `<span title="${m}">${m}</span>`).join("") +
      (trModels.length > 12 ? `<span title="${trModels.slice(12).join("、")}">+${trModels.length - 12}</span>` : "");

    // 豆包工作（登录态是客户端 cookie 快照，relay 不依赖客户端常驻）
    const db = s.doubao || { running: false, ok: false };
    const dbCookieOk = !!db.cookies?.ok;
    setPill("doubao-pill", db.running && db.ok ? "ok" : db.running ? "warn" : "err",
      db.running && db.ok ? "运行中" : db.running ? "登录态异常" : "已停止");
    $("doubao-status").textContent = db.ok ? "ok" : db.running ? "cookie 失效/缺失" : "未运行";
    $("doubao-cookies").textContent = db.cookies
      ? (dbCookieOk ? `有效（${db.cookies.count} 条，${db.cookies.ageMinutes} 分钟前同步）` : `缺失 ${(db.cookies.missing || []).join(",") || "未知"}`)
      : "未同步";
    $("doubao-conv").textContent = db.conversation && db.conversation !== "(auto/new)" ? db.conversation : "自动（用当前活跃对话）";
    $("doubao-sessions").textContent = db.running ? (db.mode === "stateless" ? "无状态（每请求全量铺平）" : db.mode || "-") : "-";
    const dbModels = db.models || [];
    $("doubao-model-count").textContent = dbModels.length || "-";
    $("doubao-models").innerHTML = dbModels.map((m) => `<span>${m}</span>`).join("");

    // Comate（登录态 = IDE settings.json 的 license，relay 运行时自读）
    const cm = s.comate || { running: false, ok: false };
    setPill("comate-pill", cm.running && cm.ok ? "ok" : cm.running ? "warn" : "err",
      cm.running && cm.ok ? "运行中" : cm.running ? "登录态缺失" : "已停止");
    $("comate-status").textContent = cm.ok ? "ok" : cm.running ? "未登录 Comate IDE" : "未运行";
    $("comate-cred").textContent = cm.credential || "-";
    // 无状态是传输层的事实；工具调用靠“同会话续跑”补齐，两件事分开写清楚。
    // 上游默认 /v2/execute（SSE 真流式），出现降级才补一句，免得“看着像流式其实在等整段”。
    const cmMode = cm.mode === "stateless" ? "无状态（每请求新建会话）" : cm.mode || "-";
    const cmStream = cm.streamFallbacks ? `；流式降级 ${cm.streamFallbacks} 次` : "";
    $("comate-mode").textContent = cm.running
      ? (cm.toolLoop ? `${cmMode}｜上游：SSE 真流式；工具调用：会话续跑（路由表 ${cm.toolRoutingCached ?? 0} 条）${cmStream}` : cmMode + cmStream)
      : "-";
    renderModels("comate", cm.models);

    // Qoder CN（账号池来自桌面凭证导入）
    const qd = s.qoder || { running: false, ok: false };
    setPill("qoder-pill", qd.running && qd.ok ? "ok" : qd.running ? "warn" : "err",
      qd.running && qd.ok ? "运行中" : qd.running ? "账号池为空" : "已停止");
    $("qoder-status").textContent = qd.ok ? "ok" : qd.running ? "待同步账号" : "未运行";
    $("qoder-accounts").textContent = qd.running ? `${qd.accounts ?? "-"} 个（可用 ${qd.ready ?? "-"}）` : "-";
    renderModels("qoder", qd.models);

    // 千问办公（与 Qoder 同一网关进程，qworkcn 出口）
    const qw = s.qwenwork || { running: false, ok: false };
    setPill("qwenwork-pill", qw.running && qw.ok ? "ok" : qw.running ? "warn" : "err",
      qw.running && qw.ok ? "运行中" : qw.running ? "账号池为空" : "未运行");
    $("qwenwork-status").textContent = qw.ok ? "ok" : qw.running ? "待同步账号" : "未运行";
    $("qwenwork-accounts").textContent = qw.running ? String(qw.accounts ?? "-") : "-";
    renderModels("qwenwork", qw.models);

    // token / credential（并入 AutoClaw 卡）
    $("token-exp").textContent = fmtExp(s.token.exp);
    $("credential").textContent = s.credential || "-";
    $("watcher-status").textContent = s.watcher.running ? "运行中" : "已停止";

    // zcode
    const zc = s.zcode;
    const zcOk = zc.registered && zc.enabled && zc.inOrder;
    setPill("zcode-pill", zcOk ? "ok" : "err", zcOk ? "已注册" : "未注册");
    // 动态增删的最近一次同步结果（链路开→注册 / 链路关→注销）一并露出
    const zs = zc.zcodeSync;
    let zsTxt = "";
    if (zs && zs.result) {
      const bits = [];
      if (Array.isArray(zs.result.upserted) && zs.result.upserted.length) bits.push("+" + zs.result.upserted.join(" +"));
      if (Array.isArray(zs.result.removed) && zs.result.removed.length) bits.push("-" + zs.result.removed.join(" -"));
      if (bits.length) zsTxt = `｜同步 ${String(zs.at).slice(5, 16).replace("T", " ")}（${bits.join(" ")}）`;
    }
    $("zcode-registered").textContent = (zc.registered ? (zc.enabled ? "已启用" : "已禁用") : "未注册") + zsTxt;
    $("zcode-models").innerHTML = (zc.models || []).slice(0, 12).map((m) => `<span>${m}</span>`).join("") +
      ((zc.models || []).length > 12 ? `<span>+${zc.models.length - 12}</span>` : "");
    // ZCode 侧的注册数量以配置文件为准（网关没启动时也要显示已注册多少）
    $("zcode-ac-count").textContent = (zc.models || []).length || "-";
    $("zcode-wb-count").textContent = zc.wbModels != null ? zc.wbModels : "-";
    $("zcode-trae-count").textContent = zc.traeModels != null ? zc.traeModels : "-";
    $("zcode-doubao-count").textContent = zc.doubaoModels != null ? zc.doubaoModels : "-";
    $("zcode-comate-count").textContent = zc.comateModels != null ? zc.comateModels : "-";
    $("zcode-qoder-count").textContent = zc.qoderModels != null ? zc.qoderModels : "-";
    $("zcode-qwenwork-count").textContent = zc.qwenworkModels != null ? zc.qwenworkModels : "-";


    // overall
    updateBootNote({ relay: !!s.relay.running, workbuddy: !!s.workbuddy.running, trae: !!tr.running, doubao: !!db.running, comate: !!cm.running, qoder: !!qd.running, watcher: !!s.watcher.running });
    const msLeft2 = s.token.exp * 1000 - Date.now();
    const all = relayOk && zcOk && msLeft2 > 6 * 3600000;
    setPill("overall", all ? "ok" : "warn", all ? "链路正常" : "部分异常");
  } catch (e) {
    setPill("overall", "err", "状态获取失败");
  }
}

async function refreshPoints() {
  const btn = $("btn-points"); btn.disabled = true;
  $("acc-points").textContent = "查询中…";
  try {
    const r = await window.api.refreshPoints();
    if (r.ok) {
      $("acc-points").textContent = r.total != null ? r.total + " 分" : "无钱包数据";

      $("acc-name").textContent = r.nickname || r.user_id || "-";
      $("points-note").textContent = "";
    } else {
      $("acc-points").textContent = "-";
      $("points-note").textContent = "查询失败：" + (r.error || JSON.stringify(r)).slice(0, 160);
    }
  } catch (e) { $("points-note").textContent = "查询异常：" + e.message; }
  btn.disabled = false;
}

async function refreshLog() {
  try { $("logview").textContent = await window.api.tailLog(currentLog); } catch {}
}

// 绑定按钮
$("btn-relay-start").onclick = async () => { $("btn-relay-start").disabled = true; await window.api.relayStart(); $("btn-relay-start").disabled = false; refreshStatus(); };
$("btn-relay-stop").onclick = async () => { $("btn-relay-stop").disabled = true; await window.api.relayStop(); $("btn-relay-stop").disabled = false; refreshStatus(); };
$("btn-smoke").onclick = async () => {
  const btn = $("btn-smoke"); btn.disabled = true;
  $("smoke-result").textContent = "测试中（最长 3 分钟，遇限流会自动退避）…";
  try {
    const r = await window.api.smokeTest();
    $("smoke-result").textContent = r.ok ? `✅ 连通正常（${r.status}）模型回复：${r.reply}` : `❌ 失败（${r.status}）：${r.reply}`;
  } catch (e) { $("smoke-result").textContent = "❌ 异常：" + e.message; }
  btn.disabled = false; refreshStatus();
};
$("btn-points").onclick = refreshPoints;
$("btn-sync").onclick = async () => {
  const btn = $("btn-sync"); btn.disabled = true;
  try {
    const r = await window.api.syncCredential();
    $("points-note").textContent = r.ok ? "✅ 凭证已重新同步" : "❌ 同步失败：" + JSON.stringify(r).slice(0, 160);
  } catch (e) { $("points-note").textContent = "❌ 异常：" + e.message; }
  btn.disabled = false;
};
$("btn-watcher").onclick = async () => {
  const s = await window.api.queryStatus();
  if (s.watcher.running) await window.api.watcherStop(); else await window.api.watcherStart();
  refreshStatus();
};
$("btn-wb-start").onclick = async () => { $("btn-wb-start").disabled = true; await window.api.workbuddyStart(); $("btn-wb-start").disabled = false; refreshStatus(); };
$("btn-wb-stop").onclick = async () => { $("btn-wb-stop").disabled = true; await window.api.workbuddyStop(); $("btn-wb-stop").disabled = false; refreshStatus(); };
$("btn-wb-smoke").onclick = async () => {
  const btn = $("btn-wb-smoke"); btn.disabled = true;
  $("wb-smoke-result").textContent = "测试中（最长 3 分钟）…";
  try {
    const r = await window.api.workbuddySmoke();
    $("wb-smoke-result").textContent = r.ok ? `✅ 连通正常（${r.status}）回复：${r.reply}` : `❌ 失败（${r.status}）：${r.reply}`;
  } catch (e) { $("wb-smoke-result").textContent = "❌ 异常：" + e.message; }
  btn.disabled = false; refreshStatus();
};
$("btn-trae-start").onclick = async () => { $("btn-trae-start").disabled = true; await window.api.traeStart(); $("btn-trae-start").disabled = false; refreshStatus(); };
$("btn-trae-stop").onclick = async () => { $("btn-trae-stop").disabled = true; await window.api.traeStop(); $("btn-trae-stop").disabled = false; refreshStatus(); };
$("btn-trae-smoke").onclick = async () => {
  const btn = $("btn-trae-smoke"); btn.disabled = true;
  $("trae-smoke-result").textContent = "测试中（Trae 需远端拉起沙箱会话，通常 10-40 秒）…";
  try {
    const r = await window.api.traeSmoke();
    $("trae-smoke-result").textContent = r.ok
      ? `✅ 连通正常（${r.status}）${r.model} 回复：${r.reply}`
      : `❌ 失败（${r.status}）：${r.reply}`;
  } catch (e) { $("trae-smoke-result").textContent = "❌ 异常：" + e.message; }
  btn.disabled = false; refreshStatus();
};
$("btn-doubao-start").onclick = async () => { $("btn-doubao-start").disabled = true; await window.api.doubaoStart(); $("btn-doubao-start").disabled = false; refreshStatus(); };
$("btn-doubao-stop").onclick = async () => { $("btn-doubao-stop").disabled = true; await window.api.doubaoStop(); $("btn-doubao-stop").disabled = false; refreshStatus(); };
$("btn-doubao-smoke").onclick = async () => {
  const btn = $("btn-doubao-smoke"); btn.disabled = true;
  $("doubao-smoke-result").textContent = "测试中（豆包首字通常 3-10 秒）…";
  try {
    const r = await window.api.doubaoSmoke();
    $("doubao-smoke-result").textContent = r.ok
      ? `✅ 连通正常（${r.status}）${r.model} 回复：${r.reply}`
      : `❌ 失败（${r.status || "-"}）：${r.reply || r.error || "无响应"}`;
  } catch (e) { $("doubao-smoke-result").textContent = "❌ 异常：" + e.message; }
  btn.disabled = false; refreshStatus();
};
$("btn-doubao-cookies").onclick = async () => {
  const btn = $("btn-doubao-cookies"); btn.disabled = true;
  $("doubao-smoke-result").textContent = "同步登录态中（需客户端已开启调试端口）…";
  try {
    const r = await window.api.doubaoSyncCookies({});
    $("doubao-smoke-result").textContent = r.ok
      ? `✅ 登录态已同步（${r.cookies?.count || "?"} 条 cookie）`
      : "❌ " + (r.error || "同步失败");
  } catch (e) { $("doubao-smoke-result").textContent = "❌ 异常：" + e.message; }
  btn.disabled = false; refreshStatus();
};
$("btn-doubao-restart").onclick = async () => {
  const btn = $("btn-doubao-restart"); btn.disabled = true;
  $("doubao-smoke-result").textContent = "正在重启豆包工作客户端（会先关闭再带调试端口拉起，最长约 40 秒）…";
  try {
    const r = await window.api.doubaoSyncCookies({ restart: true });
    $("doubao-smoke-result").textContent = r.ok
      ? `✅ 客户端已重启，登录态已同步（${r.cookies?.count || "?"} 条 cookie）`
      : "❌ " + (r.error || "失败");
  } catch (e) { $("doubao-smoke-result").textContent = "❌ 异常：" + e.message; }
  btn.disabled = false; refreshStatus();
};
$("btn-comate-start").onclick = async () => { $("btn-comate-start").disabled = true; await window.api.comateStart(); $("btn-comate-start").disabled = false; refreshStatus(); };
$("btn-comate-stop").onclick = async () => { $("btn-comate-stop").disabled = true; await window.api.comateStop(); $("btn-comate-stop").disabled = false; refreshStatus(); };
$("btn-comate-smoke").onclick = async () => {
  const btn = $("btn-comate-smoke"); btn.disabled = true;
  $("comate-smoke-result").textContent = "测试中（Comate 走云端 agent 三步链，通常 10-40 秒）…";
  try {
    const r = await window.api.comateSmoke();
    $("comate-smoke-result").textContent = r.ok
      ? `✅ 连通正常（${r.status}）${r.model} 回复：${r.reply}`
      : `❌ 失败（${r.status || "-"}）：${r.reply || r.error || "无响应"}`;
  } catch (e) { $("comate-smoke-result").textContent = "❌ 异常：" + e.message; }
  btn.disabled = false; refreshStatus();
};
$("btn-qoder-start").onclick = async () => { $("btn-qoder-start").disabled = true; await window.api.qoderStart(); $("btn-qoder-start").disabled = false; refreshStatus(); };
$("btn-qoder-stop").onclick = async () => { $("btn-qoder-stop").disabled = true; await window.api.qoderStop(); $("btn-qoder-stop").disabled = false; refreshStatus(); };
$("btn-qoder-smoke").onclick = async () => {
  const btn = $("btn-qoder-smoke"); btn.disabled = true;
  $("qoder-smoke-result").textContent = "测试中（COSY 签名链路，通常 3-15 秒）…";
  try {
    const r = await window.api.qoderSmoke();
    $("qoder-smoke-result").textContent = r.ok
      ? `✅ 连通正常（${r.status}）${r.model} 回复：${r.reply}`
      : `❌ 失败（${r.status || "-"}）：${r.reply || r.error || "无响应"}`;
  } catch (e) { $("qoder-smoke-result").textContent = "❌ 异常：" + e.message; }
  btn.disabled = false; refreshStatus();
};
$("btn-qoder-sync").onclick = async () => {
  const btn = $("btn-qoder-sync"); btn.disabled = true;
  $("qoder-smoke-result").textContent = "扫描本机 Qoder/千问办公登录态并导入账号池…";
  try {
    const r = await window.api.qoderSyncAccounts();
    $("qoder-smoke-result").textContent = r.ok
      ? `✅ 已导入：${(r.imported || []).join("、")}`
      : "❌ " + (r.error || "未发现可导入的凭证");
  } catch (e) { $("qoder-smoke-result").textContent = "❌ 异常：" + e.message; }
  btn.disabled = false; refreshStatus();
};
// 千问办公：启动/停止作用在共用的那个网关进程上（幂等，已在跑会直接返回）
$("btn-qwenwork-start").onclick = async () => { $("btn-qwenwork-start").disabled = true; await window.api.qoderStart(); $("btn-qwenwork-start").disabled = false; refreshStatus(); };
$("btn-qwenwork-stop").onclick = async () => { $("btn-qwenwork-stop").disabled = true; await window.api.qoderStop(); $("btn-qwenwork-stop").disabled = false; refreshStatus(); };
$("btn-qwenwork-smoke").onclick = async () => {
  const btn = $("btn-qwenwork-smoke"); btn.disabled = true;
  $("qwenwork-smoke-result").textContent = "测试中（qworkcn 出口，通常 3-15 秒）…";
  try {
    const r = await window.api.qwenworkSmoke();
    $("qwenwork-smoke-result").textContent = r.ok
      ? `✅ 连通正常（${r.status}）${r.model} 回复：${r.reply}`
      : `❌ 失败（${r.status || "-"}）：${r.reply || r.error || "无响应"}`;
  } catch (e) { $("qwenwork-smoke-result").textContent = "❌ 异常：" + e.message; }
  btn.disabled = false; refreshStatus();
};
$("btn-qwenwork-sync").onclick = async () => {
  const btn = $("btn-qwenwork-sync"); btn.disabled = true;
  $("qwenwork-smoke-result").textContent = "扫描本机登录态（Qoder CN + 千问办公）并导入账号池…";
  try {
    const r = await window.api.qoderSyncAccounts();
    $("qwenwork-smoke-result").textContent = r.ok
      ? `✅ 已导入：${(r.imported || []).join("、")}`
      : "❌ " + (r.error || "未发现可导入的凭证");
  } catch (e) { $("qwenwork-smoke-result").textContent = "❌ 异常：" + e.message; }
  btn.disabled = false; refreshStatus();
};
$("btn-register").onclick = async () => {
  const btn = $("btn-register"); btn.disabled = true;
  $("register-note").textContent = "注册中…";
  try {
    const r = await window.api.registerZcode();
    let note = r.ok ? "✅ 已注册（重启 ZCode 生效），模型：" + (r.models || []).join("/") : "❌ " + (r.error || "失败");
    if (r.workbuddy) note += r.workbuddy.registered ? ` · WorkBuddy：已写入 ${r.workbuddy.models.length} 个模型` : ` · WorkBuddy 未同步：${r.workbuddy.error}`;
    if (r.trae) note += r.trae.registered ? ` · Trae：已写入 ${r.trae.models.length} 个模型` : ` · Trae 未同步：${r.trae.error}`;
    if (r.doubao) note += r.doubao.registered ? ` · 豆包工作：已写入 ${r.doubao.models.length} 个模型` : ` · 豆包工作未同步：${r.doubao.error}`;
    if (r.comate) note += r.comate.registered ? ` · Comate：已写入 ${r.comate.models.length} 个模型` : ` · Comate 未同步：${r.comate.error}`;
    if (r.qoder) note += r.qoder.registered ? ` · Qoder：已写入 ${r.qoder.models.length} 个模型` : ` · Qoder 未同步：${r.qoder.error}`;
    if (r.qwenwork) note += r.qwenwork.registered ? ` · 千问办公：已写入 ${r.qwenwork.models.length} 个模型` : ` · 千问办公未同步：${r.qwenwork.error}`;
    if (r.realmKeys && r.realmKeys.error) note += `\n⚠️ 出口 Key 未就绪（千问办公会走默认出口）：${r.realmKeys.error}`;
    if (r.backup) note += ` · 备份 ${r.backup}`;
    if (r.registerError) note += `\n⚠️ 写入被闸门拦下，配置未改动：${r.registerError}`;
    $("register-note").textContent = note;
  } catch (e) { $("register-note").textContent = "❌ 异常：" + e.message; }
  btn.disabled = false; refreshStatus();
};
$("btn-zcheck").onclick = async () => {
  const btn = $("btn-zcheck"); btn.disabled = true;
  $("zcheck-note").textContent = "体检中…";
  try {
    const r = await window.api.zcodeCheck();
    if (r.error) { $("zcheck-note").textContent = "❌ " + r.error; }
    else {
      const list = (r.providers || []).map((p) => `${p.providerId}=${p.apiType || "（无 api.type）"}(${p.models})`).join(" · ");
      $("zcheck-note").textContent = (r.ok ? "✅ 配置健康" : `❌ 有 ${r.illegal.length} 个供应商 api.type 非法`)
        + `｜规则键：${r.modelConfigRulesKeys.join("/")}｜手工规则：${r.hasManualRules ? "在" : "缺失"}｜模型条目 ${r.modelRuleCount}\n${list}`;
    }
  } catch (e) { $("zcheck-note").textContent = "❌ 异常：" + e.message; }
  btn.disabled = false;
};
// 首次使用/冷启动：把“还没起来的服务”直接点名，并指向右上角的一键启动
let startAllRan = false;
function setBootNote(text) {
  const el = $("boot-note");
  el.textContent = text || "";
  el.style.display = text ? "block" : "none";
}
function updateBootNote(svc) {
  // 千问办公不单列：它和 Qoder CN 是同一个网关进程的两个出口
  const names = { relay: "AutoClaw relay", workbuddy: "WorkBuddy 网关", trae: "Trae 网关", doubao: "豆包工作网关", comate: "Comate 网关", qoder: "Qoder 网关（含千问办公出口）", watcher: "凭证同步器" };
  const down = Object.keys(names).filter((k) => !svc[k]);
  if (!down.length) { startAllRan = false; setBootNote(""); return; }
  if (startAllRan) return;   // 保留「一键启动」的结果说明，等补齐后自动收掉
  setBootNote(down.length === Object.keys(names).length
    ? "服务均未启动：点右上角「一键启动全部」一次拉起（首次使用建议先点「环境体检」看看缺什么）"
    : `未启动：${down.map((k) => names[k]).join("、")} —— 点右上角「一键启动全部」补齐`);
}

async function runEnvCheck() {
  const btn = $("btn-envcheck"); btn.disabled = true;
  const el = $("env-note");
  el.style.display = "block";
  el.textContent = "环境体检中（探测 node / python / 各家网关与凭证）…";
  try {
    const r = await window.api.envCheck();
    el.textContent = (r.ok ? "✅ 环境就绪" : "⚠️ 有缺失项（✗ 的部分会限制对应功能，右侧为补充说明）") + "\n" +
      (r.items || []).map((i) => `${i.ok ? "✓" : "✗"} ${i.name}：${i.detail}${i.ok ? "" : "　→ " + i.hint}`).join("\n");
  } catch (e) { el.textContent = "❌ 体检异常：" + e.message; }
  btn.disabled = false;
}

$("btn-envcheck").onclick = runEnvCheck;

$("btn-startall").onclick = async () => {
  const btn = $("btn-startall"); btn.disabled = true;
  startAllRan = true;
  setBootNote("正在按顺序启动：AutoClaw relay → WorkBuddy → Trae → 豆包工作 → Comate → Qoder → 凭证同步器（各自独立，缺前置只影响自己）…");
  try {
    const r = await window.api.startAll();
    setBootNote((r.ok ? "✅ 全部就绪：" : "⚠️ 部分未启动：") +
      (r.steps || []).map((s) => `${s.name} ${s.ok ? s.detail : "✗ " + s.detail}`).join(" · "));
    if (!r.ok) runEnvCheck();   // 有失败就顺手把环境体检结果摆出来（缺什么一眼看到）
  } catch (e) { setBootNote("❌ 启动异常：" + e.message); }
  btn.disabled = false; refreshStatus();
};

document.querySelectorAll(".tab").forEach((t) => {
  t.onclick = () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    currentLog = t.dataset.log;
    refreshLog();
  };
});

setInterval(refreshStatus, 3000);
setInterval(() => { if ($("autorefresh").checked) refreshLog(); }, 3000);
refreshStatus();
refreshPoints();
refreshLog();
