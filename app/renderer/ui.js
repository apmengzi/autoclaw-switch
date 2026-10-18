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
/** 同一份平台状态在三个地方露出：页面药丸、侧栏状态点、总览磁贴状态字 */
function setDot(key, cls) {
  for (const p of ["nav-dot-", "ov-dot-"]) {
    const el = $(p + key);
    if (el) el.className = "dot " + cls;
  }
}
function mark(key, cls, text) {
  setPill(key + "-pill", cls, text);
  setDot(key, cls);
  const ov = $("ov-state-" + key);
  if (ov) { ov.className = "ovstate " + cls; ov.textContent = text; }
}
/** HTML 转义：余额卡片用 innerHTML 渲染，上游文案（报错、昵称）里可能有 <>&"，不转义会被当标签吞掉 */
function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
/** 模型目录 chips：超过 12 个折叠成 +N；网关没起来时清单为空，计数显示 "-" */
function renderModels(key, models) {
  const list = models || [];
  $(key + "-model-count").textContent = list.length || "-";
  $(key + "-models").innerHTML = list.slice(0, 12)
    .map((m) => `<span title="${String(m).replace(/"/g, "&quot;")}">${m}</span>`).join("") +
    (list.length > 12 ? `<span>+${list.length - 12}</span>` : "");
}

let statusBusy = false;
async function refreshStatus() {
  if (statusBusy) return;   // 状态查询可能超过 3 秒轮询间隔：上一发没回来就跳过这一拍，避免请求堆积
  statusBusy = true;
  try {
    const s = await window.api.queryStatus();
    // relay
    const relayOk = s.relay.running && s.relay.ok;
    const msLeftPill = s.token.exp * 1000 - Date.now();
    mark("relay", relayOk && msLeftPill > 0 ? "ok" : relayOk ? "warn" : "err",
      relayOk ? (msLeftPill > 0 ? "运行中" : "Token过期") : s.relay.running ? "异常" : "已停止");
    $("relay-status").textContent = relayOk ? `ok（${s.relay.status}）` : s.relay.running ? "无上游" : "未运行";
    $("relay-upstream").textContent = s.relay.upstream || "-";
    $("relay-uptime").textContent = fmtUptime(s.relay.uptimeS);
    $("relay-models").innerHTML = (s.relay.models || []).map((m) => `<span>${m}</span>`).join("");

    // workbuddy
    const wbOk = s.workbuddy.running && s.workbuddy.ok;
    mark("wb", wbOk ? "ok" : s.workbuddy.running ? "warn" : "err",
      wbOk ? "运行中" : s.workbuddy.running ? "异常" : "已停止");
    $("wb-status").textContent = wbOk ? "ok" : s.workbuddy.running ? "无上游" : "未运行";
    $("wb-credits").textContent = s.workbuddy.account ? `${s.workbuddy.account.credits} 分` : "-";
    $("wb-account").textContent = s.workbuddy.account ? (s.workbuddy.account.nickname || String(s.workbuddy.account.uid).slice(0, 8)) : "-";
    const wbModels = s.workbuddy.models || [];
    $("wb-models").innerHTML = wbModels.slice(0, 10).map((m) => `<span>${m}</span>`).join("") +
      (wbModels.length > 10 ? `<span>+${wbModels.length - 10}</span>` : "");

    // trae（网关自带凭证解密与会话池，控制台只做展示）
    const tr = s.trae || { running: false, ok: false };
    mark("trae", tr.running && tr.ok ? "ok" : tr.running ? "warn" : "err",
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
    mark("doubao", db.running && db.ok ? "ok" : db.running ? "warn" : "err",
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
    mark("comate", cm.running && cm.ok ? "ok" : cm.running ? "warn" : "err",
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
    mark("qoder", qd.running && qd.ok ? "ok" : qd.running ? "warn" : "err",
      qd.running && qd.ok ? "运行中" : qd.running ? "账号池为空" : "已停止");
    $("qoder-status").textContent = qd.ok ? "ok" : qd.running ? "待同步账号" : "未运行";
    $("qoder-accounts").textContent = qd.running ? `${qd.accounts ?? "-"} 个（可用 ${qd.ready ?? "-"}）` : "-";
    renderModels("qoder", qd.models);

    // 千问办公（与 Qoder 同一网关进程，qworkcn 出口）
    const qw = s.qwenwork || { running: false, ok: false };
    mark("qwenwork", qw.running && qw.ok ? "ok" : qw.running ? "warn" : "err",
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
    setDot("zcode", zcOk ? "ok" : "err");
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

    // codex（这条只报廉价事实：前门在不在 / 注册了哪几条 / 当前指向谁；
    // 七条链路明细 + 目录 + CLI 版本要跑 codex debug models，按需拉 → 「体检」按钮）
    const cx = s.codex || {};
    const cxRegs = (cx.providers || []).length;
    const cxCur = (cx.providers || []).find((p) => p.providerId === cx.current);
    const cxCls = cx.current ? "ok" : cxRegs ? "warn" : "unknown";
    setPill("codex-pill", cxCls,
      cx.current ? `当前：${String(cxCur?.name || cx.current).replace("A-SWITCH ", "")}`
        : cxRegs ? `已注册 ${cxRegs} 条·未指向` : cx.frontRunning ? "前门在跑·未接入" : "未接入");
    setDot("codex", cxCls);


    // overall
    updateBootNote({ relay: !!s.relay.running, workbuddy: !!s.workbuddy.running, trae: !!tr.running, doubao: !!db.running, comate: !!cm.running, qoder: !!qd.running, watcher: !!s.watcher.running });
    const msLeft2 = s.token.exp * 1000 - Date.now();
    const all = relayOk && zcOk && msLeft2 > 6 * 3600000;
    setPill("overall", all ? "ok" : "warn", all ? "链路正常" : "部分异常");
    setDot("overview", all ? "ok" : "warn");
  } catch (e) {
    setPill("overall", "err", "状态获取失败");
    setDot("overview", "err");
  } finally {
    statusBusy = false;
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

// --- 余额 / 额度总览：一次拉齐七条链路的「还能用多少」 ---
// 有额度接口的（AutoClaw / WorkBuddy / Qoder / 千问办公）给真实数字并标绿；
// 上游确实没有接口的（Comate / Trae / 豆包）如实标注为「无接口」并把登录态摆出来。
async function refreshBalance() {
  const btns = document.querySelectorAll(".btn-bal-refresh");
  btns.forEach((b) => { b.disabled = true; });
  setPill("balance-pill", "unknown", "查询中…");
  $("balance-note").textContent = "正在向各链路查询余额（Qoder/千问办公要刷账号池额度，可能 10-30 秒）…";
  try {
    const r = await window.api.balanceAll();
    const rows = r.links || [];
    $("balance-list").innerHTML = rows.map((l) => {
      const known = l.available === true;
      // 三种状态分清：有真实读数 / 上游根本没有额度接口 / 有接口但这次没拿到数
      const valueHtml = known
        ? `<span class="bavalue">${esc(l.value)}</span><span class="baunit">${esc(l.unit || "")}</span>`
        : l.noApi ? `<span class="bavalue">无接口</span>`
        : `<span class="bavalue">—</span>`;
      const errHtml = l.error ? `<div class="baerr" title="${esc(l.error)}">⚠️ ${esc(l.error)}</div>` : "";
      return `<div class="barow ${known ? "known" : "unknown"}">`
        + `<div class="batop"><span class="balabel">${esc(l.label)}</span>${valueHtml}</div>`
        + (l.detail ? `<div class="badetail">${esc(l.detail)}</div>` : "") + errHtml + `</div>`;
    }).join("");
    // Qoder / 千问办公页面上的紧凑额度条：同一次查询的数据，不再单独发请求
    for (const l of rows) {
      const v = $("bal-" + l.id), d = $("bal-detail-" + l.id);
      if (v) {
        v.classList.toggle("unknown", l.available !== true);
        v.textContent = l.available === true
          ? `${l.value}${l.unit ? " " + l.unit : ""}`
          : l.noApi ? "无接口" : "—";
        v.title = l.error || "";
      }
      if (d) { d.textContent = l.detail || (l.error ? "⚠️ " + l.error : ""); d.title = l.error || l.detail || ""; }
    }
    const known = rows.filter((l) => l.available === true).length;
    const noApi = rows.filter((l) => l.noApi === true).length;
    const failed = rows.filter((l) => l.available !== true && l.noApi !== true).length;
    setPill("balance-pill", failed ? "warn" : "ok", `${known}/${rows.length} 条有读数`);
    $("balance-note").textContent = `${known} 条链路能拿到真实读数，${noApi} 条上游没有额度接口（如实标注，不编数字）`
      + (failed ? `，${failed} 条有接口但这次没拿到数（见各行黄字）` : "")
      + `｜查询于 ${new Date(r.at).toLocaleTimeString("zh-CN")}`;
  } catch (e) {
    setPill("balance-pill", "err", "查询失败");
    $("balance-note").textContent = "❌ 查询异常：" + e.message;
  }
  btns.forEach((b) => { b.disabled = false; });
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
document.querySelectorAll(".btn-bal-refresh").forEach((b) => { b.onclick = refreshBalance; });
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

// --- Codex CLI 卡片：注册 = 写 ~/.codex/config.toml 的托管区（A-SWITCH 表 + 顶层指针 + 目录），
// 摘除 = 只删托管区并把顶层键还原成注册前的值。链路明细要跑 codex debug models / netstat 七次，
// 所以不做轮询，只在「体检」和每次动作后拉一遍（前门在不在这类廉价事实由 3 秒轮询的 status:query 报）。
let codexLinkList = [];
const codexSel = () => $("codex-link").value || (codexLinkList[0] && codexLinkList[0].id) || "workbuddy";
const codexLabelOf = (id) => (codexLinkList.find((l) => l.id === id) || {}).label || id;

async function refreshCodexDetail() {
  let r = null;
  try { r = await window.api.codexStatus(); } catch (e) { $("codex-note").textContent = "❌ 体检异常：" + e.message; return null; }
  if (!r || r.error) { $("codex-note").textContent = "❌ 体检失败：" + ((r && r.error) || "无返回"); return null; }
  codexLinkList = r.links || [];
  const sel = $("codex-link");
  const keep = sel.value;
  sel.innerHTML = codexLinkList.map((l) => `<option value="${l.id}">${l.label}（${l.tier === "chat" ? "聊天档" : "工具档"}）</option>`).join("");
  if (keep) sel.value = keep;
  const mark = (cls, text, tip) => `<span class="kzcode ${cls}" title="${String(tip).replace(/"/g, "&quot;")}">${text}</span>`;
  $("codex-links").innerHTML = codexLinkList.map((l) => `<div class="keyrow"><span class="klabel">${l.label}</span>`
    + `<span class="cxinfo" title="托管表 ${l.providerId}｜base_url ${l.baseUrl}｜默认模型 ${l.model}">:${l.port} · ${l.model}${l.via === "front" ? " · 经前门" : " · 直连"}</span>`
    + mark(l.tier === "chat" ? "stale" : "match", l.tier === "chat" ? "聊天档" : "工具档", l.note)
    + mark(l.upstreamAlive ? "match" : "mismatch", l.upstreamAlive ? "上游在" : "上游停",
      l.upstreamAlive ? `上游网关 :${l.port} 在跑` : `上游网关 :${l.port} 没跑：现在注册的话，Codex 里发请求会 502，先启动它`)
    + mark(l.registered ? "match" : "none", l.registered ? "已注册" : "未注册",
      l.registered ? "config.toml 里有这条链路的托管表" : "config.toml 里还没有它")
    + (l.current ? mark("match", "◆ 当前", "Codex 现在指向它（顶层 model_provider）") : "") + `</div>`).join("");
  $("codex-cli").textContent = r.cli.version || "未找到";
  $("codex-cli").title = r.cli.path || "";
  $("codex-config").textContent = (r.configPath || "-").replace(/^.*[\\/]\.codex/, "~/.codex");
  $("codex-config").title = r.configPath || "";
  $("codex-current").textContent = r.current && r.current.model_provider
    ? `${r.current.model_provider} · ${r.current.model || "?"}` : "（未设置，Codex 用自带默认）";
  $("codex-registered").textContent = (r.providers || []).length
    ? r.providers.map((p) => String(p.providerId || "").replace("aswitch-", "")).join("、") : "（无）";
  $("codex-front").textContent = r.front.running
    ? `运行中 · ${r.front.responsesCalls} 次 /v1/responses${r.front.upstreamErrors ? ` · 上游错 ${r.front.upstreamErrors}` : ""}`
    : "未运行（聊天档链路才需要它）";
  $("codex-bundled").textContent = r.bundled.count ? `${r.bundled.count} 个官方条目` : `取不到：${r.bundled.error || "codex debug models 无输出"}`;
  // 体检的问题/告警就写进备注区（红/黄各一行，长时间挂着，提醒用户去处理）
  const lines = [];
  if (!r.cli.ok) lines.push("⚠️ 没找到 Codex CLI：注册写的配置它才读得到（npm i -g @openai/codex）");
  if (!r.exists) lines.push("ℹ️ config.toml 还不存在：首次「注册」会自动创建");
  for (const p of r.problems || []) lines.push("❌ " + p);
  for (const w of r.warnings || []) lines.push("⚠️ " + w);
  $("codex-note").textContent = lines.join("\n");
  return r;
}

// 动作按钮的公共外壳：禁用按钮 → 干活 → 打印结果 → 拉一遍明细 → 刷新廉价状态
async function codexAct(btnId, busy, fn) {
  const btn = $(btnId); btn.disabled = true;
  $("codex-note").textContent = busy;
  try { $("codex-note").textContent = await fn(); }
  catch (e) { $("codex-note").textContent = "❌ 异常：" + e.message; }
  btn.disabled = false;
  await refreshCodexDetail();
  refreshStatus();
}

$("btn-codex-refresh").onclick = async () => {
  const btn = $("btn-codex-refresh"); btn.disabled = true;
  $("codex-note").textContent = "体检中（读 config.toml + 问 codex debug models + 探七条上游）…";
  const r = await refreshCodexDetail();
  if (r && !r.problems.length && !r.warnings.length) {
    $("codex-note").textContent = `✅ 配置干净：${r.providers.length} 条托管链路｜当前 ${
      r.current && r.current.model_provider ? r.current.model_provider : "（未指向我们）"}｜前门 ${r.front.running ? "在跑" : "停"}`;
  }
  btn.disabled = false;
};

$("btn-codex-register").onclick = () => {
  const linkId = codexSel(), label = codexLabelOf(linkId);
  const link = codexLinkList.find((l) => l.id === linkId) || {};
  if (!window.confirm(`把 Codex 指向「${label}」？\n\n`
    + `· 只动 config.toml 的托管区（一条 A-SWITCH provider 表 + 顶层 model_provider/model 指针），其它内容一个字节不动，改动前自动备份\n`
    + `· 同时写模型目录 aswitch-model-catalog.json：Codex 自带目录会被克隆保留，官方模型不丢\n`
    + `· 凭据放在 provider 表的 experimental_bearer_token，不碰 ~/.codex/auth.json\n`
    + (link.tier === "chat" ? `· ⚠️ 这条是聊天档：上游没有工具通道，Codex 里只能当纯文本助手用\n` : `· 工具循环可用：Codex 会在本机执行命令（sandbox 按 Codex 自己的配置）\n`)
    + (link.upstreamAlive ? "" : `· ⚠️ 上游网关 :${link.port} 现在没跑，先启动它\n`)
    + `\n注册后要新开 Codex 进程才刷 /model 菜单（0.160.1 实测不热加载）。`)) return;
  codexAct("btn-codex-register", `注册中：写 config.toml + 生成目录（拉 ${label} 模型目录）…`, async () => {
    const r = await window.api.codexRegister(linkId);
    if (!r.ok) return "❌ " + (r.error || "失败");
    let s = `✅ 已把 Codex 指向 ${codexLabelOf(r.linkId)}（${r.providerId}）\n`
      + `模型 ${r.model}｜base_url ${r.baseUrl}`
      + (r.modelPicked ? `\nℹ️ 上游目录里没有「${r.modelPicked.want}」，顶层模型改用它的全名「${r.modelPicked.used}」（写全名才拿得到目录元数据）` : "")
      + "\n"
      + `目录：${r.catalog ? `${r.catalog.count} 条 = 自带 ${r.catalog.bundled} + 本条链路 ${r.catalog.ours}`
        + (r.catalog.skipped.length ? `（重名跳过 ${r.catalog.skipped.join("、")}）` : "") : "未写"}`
      + `\n托管链路：${(r.activeLinks || []).length ? r.activeLinks.join("、") : "-"}${r.backup ? `｜备份 ${r.backup}` : ""}`;
    for (const w of r.warnings || []) s += "\n⚠️ " + w;
    for (const p of (r.report && r.report.problems) || []) s += "\n❌ " + p;
    return s + "\n新开一个 Codex 进程生效。";
  });
};

$("btn-codex-deregister").onclick = () => {
  const linkId = codexSel(), label = codexLabelOf(linkId);
  if (!window.confirm(`摘除「${label}」在 Codex 里的托管区？\n\n`
    + `· 只删这条链路的 A-SWITCH provider 表\n`
    + `· 如果它正好是当前供应商，顶层 model_provider/model 会还原成注册前的旧值（用户原本没有就删干净，绝不替你留半截配置）\n`
    + `· 我们的托管表全摘完时，顺便清掉 aswitch-model-catalog.json`)) return;
  codexAct("btn-codex-deregister", `摘除中：改 config.toml（${label}）…`, async () => {
    const r = await window.api.codexDeregister(linkId);
    if (!r.ok) return "❌ " + (r.error || "失败");
    if (!r.changed) return `ℹ️ config.toml 里没有「${label}」的痕迹（${r.reason || "无事可做"}）`;
    return `✅ 已摘除 ${label}`
      + (r.restored ? "｜顶层指针已还原成注册前的样子" : "｜它本来就不是当前供应商")
      + (r.catalogRemoved ? "｜我们的模型目录已清掉" : "") + `｜还剩 ${r.remaining} 条托管链路`
      + (r.backup ? `｜备份 ${r.backup}` : "");
  });
};

$("btn-codex-catalog").onclick = () => {
  const linkId = codexSel(), label = codexLabelOf(linkId);
  codexAct("btn-codex-catalog", `预览中：读 ${label} 的模型目录…`, async () => {
    const r = await window.api.codexCatalog(linkId);
    if (!r.ok) return "❌ " + (r.error || "失败");
    return `目录预览（${label}）：共 ${r.count} 条 = Codex 自带 ${r.bundled} + 我方 ${r.ours}`
      + (r.skipped.length ? `；重名跳过 ${r.skipped.join("、")}` : "") + "\n"
      + `本条链路给 Codex 的模型（${r.liveModels.length}）：${r.liveModels.join("、") || "-"}`
      + `\n顶层模型预览：${r.pickedModel}${r.pickedModel !== r.wantModel ? `（表里默认 ${r.wantModel}，取了对得上的全名）` : ""}`
      + (r.ensured.length ? `（目录里没有它，真注册时会补一条合成条目）` : "")
      + (r.liveEmpty ? `\n⚠️ 上游模型目录是空的：网关没起、或控制台手里那把钥匙和网关的不一致（注册时目录只剩 Codex 自带条目）` : "")
      + (r.bundledOk ? "" : `\n⚠️ Codex 自带目录取不到（${r.error}）：真注册时只写我方条目，官方模型会从选择器里消失`);
  });
};

$("btn-codex-smoke").onclick = () => {
  const linkId = codexSel(), label = codexLabelOf(linkId);
  codexAct("btn-codex-smoke", `冒烟中：按 Codex 的形状打一发 /v1/responses（${label}，最长 240 秒）…`, async () => {
    const r = await window.api.codexSmoke(linkId);
    return (r.ok ? "✅ 冒烟通过" : "❌ 冒烟失败")
      + `｜${codexLabelOf(r.link)} → ${r.path}（HTTP ${r.status}）\n回复：${r.reply || "（空）"}\n输出项：${(r.items || []).join("、") || "-"}`;
  });
};

$("btn-codex-front-start").onclick = () => codexAct("btn-codex-front-start", "启动前门（:18776，带 wb/trae/doubao 三条上游）…", async () => {
  const r = await window.api.codexFrontStart();
  if (!r.ok) return "❌ " + (r.error || "失败");
  return (r.already ? "ℹ️ 前门本来就在跑" : "✅ 前门已启动")
    + `｜:18776 · 上游 ${Object.keys(r.links || {}).join("、") || "-"}`
    + ((r.missing || []).length ? `\n⚠️ 前门不认得 ${r.missing.map((k) => "/" + k).join("、")}（老进程或手工起的）：这条链路会 404，点「前门停止」再「前门启动」重启它` : "");
});

$("btn-codex-front-stop").onclick = () => codexAct("btn-codex-front-stop", "停前门…", async () => {
  const r = await window.api.codexFrontStop();
  return r.ok ? "✅ 前门已停（聊天档链路会跟着不可用，工具档不受影响）" : "❌ " + (r.error || "失败");
});

// --- 入站 api_key 卡片：钥匙盘点渲染 + 点击复制 + 生成 + 鉴权体检 ---
async function refreshKeys() {
  try {
    const r = await window.api.keysQuery();
    if (!r.ok) { $("keys-list").textContent = "盘点失败：" + (r.error || "?"); setDot("keys", "err"); return; }
    $("keys-list").innerHTML = r.links.map((l) => l.keys.map((k, i) => {
      const z = l.zcode || {};
      const zc = z.registered == null ? '<span class="kzcode none" title="未注册进 ZCode 或配置不可读">未注册</span>'
        : z.matches !== true ? '<span class="kzcode mismatch" title="ZCode 注册值已和这里盘点的不一致——点「生成」或「一键注册」切到当前主钥，重启 ZCode 生效">✗ 注册不一致</span>'
        : z.current === true ? '<span class="kzcode match" title="ZCode 注册的正是当前主钥（列表第一位）">✓ 注册一致</span>'
        : '<span class="kzcode stale" title="ZCode 注册的是列表里的备用钥——仍能用，但非当前主钥。点「生成」或「一键注册」切到当前主钥，重启 ZCode 生效">◇ 注册为备用钥</span>';
      const gen = i === 0
        ? `<button class="kgen" data-link="${l.id}" title="生成新 api_key：随机新钥写入网关档案 → 自动重启在跑的链路 → 排队切换 ZCode 注册值（生成是加钥：内置兜底钥与旧钥仍有效）">生成</button>`
        : "";
      // 标准钥（sk- 形·别名）：只对四条 env 链路开放（wb2api 单钥二进制 / qoder 系走网关出口 Key）
      const skBtn = i === 0 && l.aliasable
        ? `<button class="kalias" data-link="${l.id}" title="加一把 sk- 形标准钥（别名）：给只认 sk- 开头钥匙的标准工具（DeepSeek Harness / Codex / OpenAI SDK）用。别名只进本链路入站闸门，ZCode 注册值不变；可留空自动生成，也可填自己的 sk-xxx">sk 钥</button>`
        : "";
      const del = k.alias
        ? `<button class="kdel" data-link="${l.id}" data-key="${k.value.replace(/"/g, "&quot;")}" title="撤销这把标准钥（从档案移除并重启本链路；主钥与 ZCode 注册值不受影响）">✕</button>`
        : "";
      const tag = k.alias ? "（sk）" : (i > 0 ? "（备）" : "");
      return `<div class="keyrow${k.alias ? " kaliasrow" : ""}"><span class="klabel">${l.label}${tag}</span>`
        + `<span class="kvalue" title="${l.label} · ${k.source}｜点击复制" data-copy="${k.value.replace(/"/g, "&quot;")}">${k.value}</span>${i === 0 ? zc + gen + skBtn : del}</div>`;
    }).join("")).join("");
    document.querySelectorAll("#keys-list .kvalue").forEach((el) => {
      el.onclick = async () => {
        try { await navigator.clipboard.writeText(el.dataset.copy); el.title = "已复制 ✓（" + el.title; setTimeout(() => {}, 0); } catch { /* 无剪贴板权限时降级：用户可手动选中 */ }
      };
    });
    document.querySelectorAll("#keys-list .kgen").forEach((el) => {
      el.onclick = async () => {
        const linkId = el.dataset.link;
        const label = (el.closest(".keyrow")?.querySelector(".klabel")?.textContent || linkId).replace("（备）", "");
        if (!window.confirm(`为「${label}」生成新 api_key？\n\n· 随机新钥写入网关档案（在跑的链路会被重启以吃进新钥）\n· ZCode 注册值自动切到新钥（ZCode 重启后生效）\n· 生成是加钥：内置兜底钥与旧钥仍然有效，随时可再生成覆盖`)) return;
        el.disabled = true;
        setPill("keys-pill", "unknown", "生成中…");
        $("keys-note").textContent = `正在为 ${label} 生成新钥匙（写档案 → 重启链路 → 排队重注册，最长约 30 秒）…`;
        let line = "", code = "err", pill = "生成失败";
        try {
          const r = await window.api.keysGenerate(linkId);
          if (r.ok) {
            line = `✅ ${label} 新钥匙：${r.key}\n${r.note || ""}${r.hint ? "\n" + r.hint : ""}`;
            code = "ok"; pill = "已生成";
          } else {
            line = `❌ ${label} 生成失败：${r.error || "未知原因"}`;
          }
        } catch (e) { line = "❌ 生成异常：" + e.message; }
        await refreshKeys();
        $("keys-note").textContent = line;
        setPill("keys-pill", code, pill);
      };
    });
    document.querySelectorAll("#keys-list .kalias").forEach((el) => {
      el.onclick = async () => {
        const linkId = el.dataset.link;
        const label = (el.closest(".keyrow")?.querySelector(".klabel")?.textContent || linkId).replace(/（备）|（sk）/g, "");
        const typed = window.prompt(`为「${label}」加一把 sk- 形标准钥（别名）——给 DeepSeek Harness / Codex / OpenAI SDK 这类只认 sk- 开头钥匙的标准工具用：\n\n· 留空直接确定 = 现场生成一把 sk-<前缀>-<36 位 hex>\n· 也可粘贴你自己的 sk-xxx（4..128 个可打印字符、无空白）\n· 别名只进本链路入站闸门，ZCode 注册值不变；本链路会被重启一次`, "");
        if (typed === null) return;   // 取消
        el.disabled = true;
        setPill("keys-pill", "unknown", "加标准钥中…");
        $("keys-note").textContent = `正在为 ${label} 登记标准钥（写档案 → 重启本链路，最长约 30 秒）…`;
        let line = "", code = "err", pill = "加标准钥失败";
        try {
          const r = await window.api.keysAlias(linkId, String(typed).trim(), "add");
          if (r.ok) {
            line = `✅ ${label} 标准钥：${r.key}\n${r.note || ""}\n标准工具里填：Authorization: Bearer ${r.key}（或 x-api-key: ${r.key}）`;
            code = "ok"; pill = "已加标准钥";
          } else {
            line = `❌ ${label} 加标准钥失败：${r.error || "未知原因"}`;
          }
        } catch (e) { line = "❌ 加标准钥异常：" + e.message; }
        await refreshKeys();
        $("keys-note").textContent = line;
        setPill("keys-pill", code, pill);
      };
    });
    document.querySelectorAll("#keys-list .kdel").forEach((el) => {
      el.onclick = async () => {
        const linkId = el.dataset.link, key = el.dataset.key;
        const label = (el.closest(".keyrow")?.querySelector(".klabel")?.textContent || linkId).replace(/（备）|（sk）/g, "");
        if (!window.confirm(`撤销「${label}」的标准钥？\n\n${key}\n\n· 从档案移除并重启本链路；已在用它的工具会立刻失去访问\n· 主钥（ZCode 注册值）与内置兜底钥不受影响`)) return;
        el.disabled = true;
        setPill("keys-pill", "unknown", "撤销中…");
        $("keys-note").textContent = `正在撤销 ${label} 的标准钥（改档案 → 重启本链路）…`;
        let line = "", code = "err", pill = "撤销失败";
        try {
          const r = await window.api.keysAlias(linkId, key, "remove");
          if (r.ok) {
            line = `✅ ${label} 标准钥已撤销\n${r.note || ""}`;
            code = "ok"; pill = "已撤销";
          } else {
            line = `❌ ${label} 撤销失败：${r.error || "未知原因"}`;
          }
        } catch (e) { line = "❌ 撤销异常：" + e.message; }
        await refreshKeys();
        $("keys-note").textContent = line;
        setPill("keys-pill", code, pill);
      };
    });
    const mismatch = r.links.some((l) => l.zcode && l.zcode.matches === false);
    const allKnown = r.links.every((l) => l.zcode && l.zcode.registered != null);
    setDot("keys", mismatch ? "warn" : allKnown ? "ok" : "unknown");
    setPill("keys-pill", "unknown", "已盘点");
  } catch (e) { $("keys-list").textContent = "盘点异常：" + e.message; setDot("keys", "err"); }
}
$("btn-keys-reload").onclick = async () => {
  const btn = $("btn-keys-reload"); btn.disabled = true;
  $("keys-pill").className = "pill unknown"; $("keys-pill").textContent = "盘点中…";
  await refreshKeys();
  btn.disabled = false;
};
$("btn-keys-probe").onclick = async () => {
  const btn = $("btn-keys-probe"); btn.disabled = true;
  setPill("keys-pill", "unknown", "体检中…");
  $("keys-note").textContent = "鉴权体检中（每条链路两发探针：匿名必须 401，带钥越过闸门）…";
  try {
    const r = await window.api.keysProbe();
    const lines = (r.probes || []).map((p) => `${p.ok ? "✓" : "✗"} ${p.label}：${p.detail}`
      + `（匿名 ${p.anonStatus ?? "-"} / 带钥 ${p.keyProbeStatus ?? "-"}）`);
    $("keys-note").textContent = (r.ok ? "✅ 七条链路闸门全部在岗、钥匙全部有效\n" : "⚠️ 有链路未达标\n") + lines.join("\n");
    setPill("keys-pill", r.ok ? "ok" : "warn", r.ok ? "闸门正常" : "有未达标");
  } catch (e) {
    $("keys-note").textContent = "❌ 体检异常：" + e.message;
    setPill("keys-pill", "err", "异常");
  }
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

// --- 按平台分页：侧栏 / 总览磁贴 / 各平台页里的日志快捷入口 ---
const VIEW_KEY = "aswitch.console.view";
function showView(name) {
  const view = $("view-" + name) || $("view-overview");
  const id = view.id.slice(5);
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v === view));
  document.querySelectorAll(".navitem").forEach((n) => n.classList.toggle("active", n.dataset.view === id));
  try { localStorage.setItem(VIEW_KEY, id); } catch {}
  $("views").scrollTop = 0;
}
function activateLogTab(name) {
  const tab = document.querySelector(`.tab[data-log="${name}"]`);
  if (!tab) return;
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === tab));
  currentLog = name;
  refreshLog();
}
document.querySelectorAll(".navitem, .ovtile").forEach((n) => {
  n.onclick = () => showView(n.dataset.view);
});
document.querySelectorAll(".tab").forEach((t) => { t.onclick = () => activateLogTab(t.dataset.log); });
document.querySelectorAll("[data-logview]").forEach((b) => {
  b.onclick = () => { showView("logs"); activateLogTab(b.dataset.logview); };
});
let savedView = "overview";
try { savedView = localStorage.getItem(VIEW_KEY) || "overview"; } catch {}
showView(savedView);

setInterval(refreshStatus, 3000);
setInterval(() => { if ($("autorefresh").checked) refreshLog(); }, 3000);
refreshStatus();
refreshPoints();
refreshKeys();
refreshCodexDetail();   // Codex 卡片的链路明细只在开机与动作后拉（要跑 codex debug models，不进 3 秒轮询）
refreshLog();
