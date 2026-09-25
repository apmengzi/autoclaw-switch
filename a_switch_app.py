#!/usr/bin/env python3
"""A-SWITCH —— AutoClaw 多账号管理 + 批量签到领积分（原生桌面窗口版）。

UI 采用 pywebview（Windows 上即 Edge WebView2 原生窗口，非浏览器标签），
视觉风格对齐 Z·SWITCH（同一套配色变量、680×820 深色窗口）。

逆向要点（AutoClaw 1.17.8，勿改）：
  - 认证头必须含 X-Auth-Appid/X-Auth-TimeStamp/X-Auth-Sign(md5)
    + **小写** authorization（大写会被网关 401）
  - 签名 = md5(f"{APP_ID}&{秒级时间戳}&{APP_KEY}")
  - token 存储于 auth.json，Chromium os_crypt 加密（DPAPI 解 key + AES-256-GCM）

用法：双击 exe / `python a_switch_app.py`
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import threading
import time
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import a_switch  # noqa: E402

APP_TITLE = "A·SWITCH"
WINDOW_W, WINDOW_H = 680, 820
AUTOCLAW_EXE = a_switch.find_autoclaw_exe() or Path(r"D:\AutoClaw\AutoClaw.exe")

# 状态
_log_lines: list[str] = []
_busy = False
# 登录添加账号的进度（后台线程写，JS 轮询读）
_login_state: dict = {"active": False, "done": False, "msg": "", "result": None}
# 内置注册/登录（免桌面端）的进度，形状与 _login_state 一致
_headless_state: dict = {"active": False, "done": False, "msg": "", "result": None}
# 10 秒积分轮询的自重入保护：号多时一轮可能跑过 10 秒，宁可跳轮也不要并发刷同一批号
_points_lock = threading.Lock()
_pool_last = None          # 上一次导给反代的可用号数，只在变化时写日志

# ---------------- 自动领取（学 Z·SWITCH：默认关，手动优先） ----------------
_settings = a_switch.load_settings()          # {"auto_claim": bool, ...}
_auto = {"running": False, "last": None, "next_tick": 0.0, "last_sweep": 0.0,
         "last_error": ""}
_sweep_state: dict = {"active": False, "done": False, "msg": "", "results": None}
_switch_state: dict = {"active": False, "done": False, "msg": "", "result": None}
AUTO_CLAIM_INTERVAL = 10 * 60                 # 无所获时的冷却（Z·SWITCH 同款 10 分钟）
AUTO_CLAIM_GAIN_GAP = 60 * 60                 # 有所获后 1 小时再回头看（当日奖励是一次性的）
AUTO_CLAIM_FIRST_DELAY = 2 * 60               # 启动后首延
AUTO_CLAIM_RETRY = 60                         # 整轮失败（网络/凭证）后的短重试
AUTO_CLAIM_QUIET_GAP = 30 * 60                # 只剩"要重新登录"的号时的中档回看
AUTO_TICK_POLL = 20                           # 引擎轮询步长
AUTO_SWEEP_COOLDOWN = 4 * 3600                # 自动打卡最小间隔（登录型活动到账按天计）


def _next_reset_in() -> float:
    """距下一个每日刷新点（本地 00:05）还有多少秒。"""
    t = time.localtime()
    due = time.mktime((t.tm_year, t.tm_mon, t.tm_mday, 0, 5, 0, 0, 1, -1))
    if due <= time.time():
        due += 86400
    return max(60.0, due - time.time())


def _auto_gap_for(gained: int, statuses: list) -> tuple:
    """本轮跑完后隔多久再来看，返回 (秒数, 要说给用户的原因)。

    "本轮 0 分"有两种完全不同的含义：还能领但这次没领到（短间隔再试），
    和今天已经没有可做的事了（要么已到账、要么被服务端确定拒绝）。后者每
    10 分钟撞一轮只是刷屏，等到每日刷新点再看。
    """
    settled = (gained <= 0 and statuses
               and not any(s in ("fail", "error") for s in statuses))
    if settled and any(s == "auth" for s in statuses):
        return AUTO_CLAIM_QUIET_GAP, "仍有账号需要重新登录"
    if settled:
        return _next_reset_in(), "今日已无可领事项"
    return (AUTO_CLAIM_GAIN_GAP if gained > 0 else AUTO_CLAIM_INTERVAL), ""


def _sweep_worker():
    """活动登录打卡后台线程（手动按钮 / 自动引擎共用）。"""
    live = a_switch.load_account(a_switch.DEFAULT_STATE_DIR)
    skip = str(live.user_id) if live else ""

    def on_prog(m):
        _sweep_state["msg"] = m
        log(m)

    try:
        rs = a_switch.activity_login_sweep(on_progress=on_prog, skip_uid=skip)
        _sweep_state["results"] = rs
        ok_n = sum(1 for r in rs if r.get("ok"))
        _sweep_state["msg"] = f"打卡完成 {ok_n}/{len(rs)}"
    except Exception as e:
        _sweep_state["msg"] = f"打卡异常：{type(e).__name__}: {e}"
        log(_sweep_state["msg"])
    finally:
        _sweep_state["done"] = True
        _sweep_state["active"] = False


def _switch_worker(tgt):
    """切换后台线程：把 switch_account 的每一步进度透传给前端轮询。"""
    def on_prog(m):
        _switch_state["msg"] = m
        log(m)

    try:
        r = a_switch.switch_account(tgt, on_progress=on_prog)
        _switch_state["result"] = r
        if r.get("already_active"):
            _switch_state["msg"] = f"{tgt.nickname} 已是当前登录账号"
        elif r.get("ok"):
            _switch_state["msg"] = f"已切换到 {tgt.nickname}（观察期身份未回跳）"
        elif r.get("reverted_to"):
            _switch_state["msg"] = f"回跳到 {r['reverted_to']}：{r.get('error')}"
        else:
            _switch_state["msg"] = f"切换失败：{r.get('error') or '未知'}"
    except Exception as e:
        _switch_state["msg"] = f"切换异常：{type(e).__name__}: {e}"
        log(_switch_state["msg"])
        _switch_state["result"] = {"ok": False, "error": f"{type(e).__name__}: {e}"}
    finally:
        _switch_state["done"] = True
        _switch_state["active"] = False


def _auto_claim_loop():
    """后台自动领取引擎：开关打开时每轮探测+幂等领取，手动领取优先。"""
    _auto["warmup_until"] = time.time() + AUTO_CLAIM_FIRST_DELAY
    time.sleep(AUTO_CLAIM_FIRST_DELAY)
    _auto["warmup_until"] = 0.0
    while True:
        _auto["beat"] = _auto.get("beat", 0) + 1   # 心跳：停住不动 = 线程已死
        _auto["beat_at"] = time.time()
        try:
            if (_settings.get("auto_claim") and not _busy and not _auto["running"]
                    and not _switch_state.get("active")
                    and not _login_state.get("active")
                    and not _headless_state.get("active")
                    and time.time() >= _auto.get("next_tick", 0)):
                _auto["running"] = True
                log("〔自动领取〕开始本轮资格检测…")
                api = Api()
                r = api.claim_all()
                if not r.get("ok"):
                    # 失败不是"没得领"：如实说明，并且短间隔重试，别静默等满 10 分钟
                    _auto["last_error"] = str(r.get("error") or "未知失败")
                    _auto["next_tick"] = time.time() + AUTO_CLAIM_RETRY
                    log(f"〔自动领取〕本轮未完成：{_auto['last_error']}，"
                        f"{AUTO_CLAIM_RETRY} 秒后重试")
                else:
                    gained = r.get("total_points") or 0
                    _auto["last_error"] = ""
                    _auto["last"] = {"at": time.strftime("%H:%M:%S"), "gained": gained}
                    statuses = [x.get("status") for x in (r.get("results") or [])]
                    gap, why = _auto_gap_for(gained, statuses)
                    _auto["next_tick"] = time.time() + gap
                    nxt = time.strftime("%H:%M:%S", time.localtime(_auto["next_tick"]))
                    log(f"〔自动领取〕本轮 +{gained} 分"
                        + (f"，{why}" if why else "") + f"，下次检测 {nxt}")
                # 活动登录打卡：开关开 + 有登录型活动在窗 + 距上次打卡≥冷却
                if (_settings.get("auto_sweep") and not _sweep_state.get("active")
                        and time.time() - _auto.get("last_sweep", 0) > AUTO_SWEEP_COOLDOWN):
                    accs0 = a_switch.discover_accounts()
                    probe = accs0[0].probe_all() if accs0 else {}
                    if probe.get("login_type_active"):
                        log("〔自动打卡〕检测到登录型活动在窗，开始逐号打卡…")
                        _sweep_state.update({"active": True, "done": False,
                                             "msg": "自动打卡开始…", "results": None})
                        _sweep_worker()
                        _auto["last_sweep"] = time.time()
                    else:
                        _auto["last_sweep"] = time.time() - AUTO_SWEEP_COOLDOWN + 30 * 60
        except Exception as e:
            _auto["last_error"] = f"{type(e).__name__}: {e}"
            log("〔自动领取〕异常：" + _auto["last_error"])
            _auto["next_tick"] = time.time() + AUTO_CLAIM_INTERVAL
        finally:
            _auto["running"] = False
        time.sleep(AUTO_TICK_POLL)


def log(msg: str):
    line = time.strftime("[%H:%M:%S] ") + str(msg)
    _log_lines.append(line)
    del _log_lines[:-400]
    a_switch.safe_print(line, flush=True)


# ---------------- 内置授权窗（零端口）：官方人机验证 → 授权页 → 截回跳读 code ----------------
class _TicketBridge:
    """页面里 `window.pywebview.api.oauth_ticket(param)` 的后端。

    一张票据只够试一个主机（阿里云票据服务端核销后即失效，重放必然被拒），
    所以按队列消费：这一发失败就如实写在窗口上，请用户再点一次验证换下一发。
    """

    def __init__(self, vendor: str, device_id: str, channel: str, say):
        self.vendor = vendor
        self.device_id = device_id
        self.channel = channel
        self.say = say
        self.lock = threading.Lock()
        self.n = 0
        self.ok = threading.Event()
        self.url = ""
        self.last = {}
        self.notes = []

    def captcha_note(self, text):
        """验证页自己报上来的状态（脚本没加载/控件出错/已就绪…）。

        没有它，超时只能说"没等到验证完成"，分不清是没人在拖还是根本没东西可拖。
        """
        text = str(text or "").strip()[:200]
        if not text:
            return {"ok": True}
        with self.lock:
            if not self.notes or self.notes[-1] != text:
                self.notes.append(text)
                del self.notes[:-20]
        log(f"授权窗页面：{text}")
        return {"ok": True}

    def last_note(self) -> str:
        with self.lock:
            return self.notes[-1] if self.notes else ""

    def oauth_ticket(self, param):
        param = str(param or "")
        if not param:
            return {"ok": False, "msg": "验证控件没交出票据"}
        with self.lock:
            idx = self.n
            self.n += 1
        if idx >= len(a_switch.OAUTH_BASES):
            return {"ok": False, "msg": "候选主机都已试过，A-SWITCH 不再重试"}
        name, base = a_switch.OAUTH_BASES[idx]
        self.say(f"内置授权窗：把票据交给 {name}…")
        try:
            r = a_switch.request_oversea_oauth_url(self.vendor, self.device_id,
                                                   ticket=param, base=base,
                                                   channel=self.channel)
        except Exception as e:
            r = {"ok": False, "http": 0, "server_code": None,
                 "msg": f"{type(e).__name__}: {e}", "url": ""}
        self.last = {"host": name, "http": r.get("http"),
                     "server_code": r.get("server_code"), "ok": bool(r.get("ok")),
                     "msg": str(r.get("msg") or "")[:200]}
        log(f"内置授权窗 {name}：HTTP {r.get('http')} 业务码 {r.get('server_code')} "
            f"{str(r.get('msg') or '')[:120]}")
        if r.get("ok"):
            self.url = r["url"]
            self.ok.set()
            return {"ok": True, "msg": "服务端已放行，正在打开授权页…"}
        nxt = (a_switch.OAUTH_BASES[idx + 1][0] if idx + 1 < len(a_switch.OAUTH_BASES)
               else "")
        return {"ok": False,
                "msg": (f"{name}没放行（HTTP {r.get('http')} / "
                        f"{str(r.get('msg') or r.get('server_code'))[:70]}）"
                        + (f"；请再点一次「开始人机验证」，下一发打 {nxt}" if nxt else
                           "；两个主机都没放行，请改用「桌面端登录添加」"))}


def _hook_nav_start(win, prefixes, box: dict, wait_seconds: float = 20.0) -> bool:
    """订阅 WebView2 的 NavigationStarting，截住回跳那一跳并取消导航。

    回跳地址是官方原值（localhost:18432），我们**不去连它** —— 所以既不占端口，
    也不会被正在运行的 AutoClaw 桌面端接走。这就是"不用关桌面端"的全部机关。
    prefixes 要把 localhost / 127.0.0.1 / [::1] 三种写法都罩上：授权站回跳时
    可能把主机名换成 IP，只比 localhost 会漏截，然后谎报"没截到回跳"。
    """
    import urllib.parse
    if isinstance(prefixes, str):
        prefixes = (prefixes,)

    def handler(sender, args):
        try:
            uri = str(args.Uri or "")
        except Exception:
            return
        if not uri.startswith(prefixes):
            return
        q = urllib.parse.parse_qs(urllib.parse.urlparse(uri).query)
        box["url"] = uri
        box["code"] = (q.get("code") or [""])[0]
        box["state"] = (q.get("state") or [""])[0]
        box["err"] = (q.get("error_description") or q.get("error") or [""])[0]
        try:
            args.Cancel = True
        except Exception as e:
            log(f"取消回跳导航失败（不影响读 code）：{type(e).__name__}")
        box["ev"].set()

    deadline = time.time() + wait_seconds
    while time.time() < deadline:
        try:
            wvc = win.native.browser.webview
            wvc.NavigationStarting += handler
            return True
        except Exception:
            time.sleep(0.2)
    return False


def _authorize_via_window(vendor: str, device_id: str, channel: str, say,
                          timeout: int = 600) -> dict:
    """开一个内置窗口完成"人机验证 + 授权"，返回 {ok, code, state, url, error}。

    界面上已没有入口（服务端不放行非官方客户端）；_t_oauth_ticket_probe.py 仍直接
    驱动这一份实现复验，所以它必须留在这里，而不是搬到测试脚本里变成第二套代码。
    """
    import webview

    cfg = a_switch.oversea_oauth_captcha_config(channel=channel)
    if not cfg["ok"]:
        return {"ok": False, "error": f"读不到验证配置：{cfg.get('error') or 'HTTP ' + str(cfg['http'])}"}
    if not cfg["enabled"]:
        return {"ok": False, "error": "服务端说这个区不需要人机验证——那内置窗口这条路不该被拦，"
                                      "请直接改用「内置 Z.ai 授权」并把它反馈出来"}
    if cfg["supplier"] != "aliyun":
        return {"ok": False, "error": f"验证供应商是 {cfg['supplier'] or '未知'}，"
                                      "A-SWITCH 只接了阿里云这一套，请改用「桌面端登录添加」"}
    callback_uri = (a_switch.ZAI_CALLBACK_URI if vendor == "zai"
                    else a_switch.GOOGLE_CALLBACK_URI)
    cb_head = callback_uri.rsplit("/", 2)[0]
    prefixes = tuple({cb_head, cb_head.replace("://localhost", "://127.0.0.1"),
                      cb_head.replace("://localhost", "://[::1]")})
    box = {"ev": threading.Event(), "url": "", "code": "", "state": "", "err": ""}
    bridge = _TicketBridge(vendor, device_id, channel, say)
    win = webview.create_window(
        "A-SWITCH 授权窗口 —— 请亲手完成验证与授权",
        html=a_switch.render_captcha_page(cfg), js_api=bridge,
        width=540, height=600, on_top=True)
    try:
        if not _hook_nav_start(win, prefixes, box):
            return {"ok": False,
                    "error": "本机 WebView2 挂不上导航事件（NavigationStarting），"
                             "这一路径在这台机器上必然截不到回跳，请改用「桌面端登录添加」"}
        if not bridge.ok.wait(timeout):
            if bridge.last:
                return {"ok": False,
                        "error": f"验证点过了，但服务端没放行：{bridge.last['host']} "
                                 f"HTTP {bridge.last['http']} / {bridge.last['msg']}"}
            note = bridge.last_note()
            return {"ok": False, "error": f"{timeout} 秒内窗口里没等到人机验证完成"
                                          + (f"（页面最后状态：{note}）" if note else
                                             "（页面一个字都没回传，多半是脚本没加载或窗口被挡住）")}
        say("服务端已放行，请在同一个窗口里完成 Z.ai 授权…")
        try:
            win.load_url(bridge.url)
        except Exception as e:
            return {"ok": False, "url": bridge.url,
                    "error": f"授权页打不开：{type(e).__name__}: {e}"}
        if not box["ev"].wait(timeout):
            return {"ok": False, "url": bridge.url,
                    "error": f"没截到授权回跳（{timeout} 秒内这一跳没发生 —— "
                             f"多半是还停在登录/授权步骤没点到底）"}
        if box["err"]:
            return {"ok": False, "url": bridge.url,
                    "error": f"授权页回跳了错误：{box['err'][:160]}"}
        if not box["code"]:
            return {"ok": False, "url": bridge.url, "error": "回跳里没有 code"}
        return {"ok": True, "code": box["code"], "state": box["state"], "url": bridge.url}
    finally:
        try:
            win.destroy()
        except Exception:
            pass



# ---------------- 供前端调用的 API ----------------
class Api:
    """pywebview 暴露给 JS 的接口（window.pywebview.api.*）。"""

    def _probe_one(self, a):
        """单号探测 + 余额：一次刷新 + 若干次元数据调用，串行跑 10 个号就是几分钟，
        所以这步并发；任一号失败只影响它自己的卡片。

        ⚠️ 切换进行中必须跳过对存档号的探测：探测会刷新并轮换存档里的 refreshToken，
        而活动目录里刚写进去的还是旧的一对，等于亲手把切换好的账号顶下线（§5.1 同一类事故）。
        """
        if not a.is_live and _switch_state.get("active"):
            return None, None
        try:
            probe = a.probe_all()
        except Exception as e:
            log(f"{a.nickname} 资格探测失败：{type(e).__name__}: {e}")
            probe = {}
        try:
            pts = a.points() or {}
        except Exception as e:
            log(f"{a.nickname} 余额查询失败：{type(e).__name__}: {e}")
            pts = {}
        return probe, pts

    def _sync_cloud_pool(self, accs, bal: dict):
        """把可用凭证 + 最新余额交给反代，让它**按请求**选号：一个号积分打空就换下一个。

        反代只读这个文件，不碰 DPAPI 存档也不做签名；凭证的刷新仍然全在这边。
        """
        global _pool_last
        try:
            entries = [{"account": a, **(bal.get(str(a.user_id or "")) or {})} for a in accs]
            r = a_switch.export_cloud_pool(entries)
        except Exception as e:
            log(f"导出账号池失败（反代继续用单凭证那条路）：{type(e).__name__}: {e}")
            return
        if not r.get("ok"):
            if _pool_last != "empty":
                log(f"账号池未导出：{r.get('error')}")
                _pool_last = "empty"
            return
        if _pool_last != r["wrote"]:
            log(f"账号池已交给反代：{r['wrote']} 个号可用")
            _pool_last = r["wrote"]

    def bootstrap(self):
        """首屏数据：账号 + 任务 + 积分 + 环境状态。"""
        try:
            accs = a_switch.discover_accounts()
            # 判断哪个账号是当前登录（活动目录 = DEFAULT_STATE_DIR）
            live = a_switch.load_account(a_switch.DEFAULT_STATE_DIR)
            live_uid = str(live.user_id) if live else ""
            a_switch.detect_autoclaw_version()      # 先单线程定版，省得每个工作线程各扫一遍注册表
            from concurrent.futures import ThreadPoolExecutor
            with ThreadPoolExecutor(max_workers=min(6, max(1, len(accs)))) as ex:
                probed = list(ex.map(self._probe_one, accs))
            out = []
            bal = {}                       # uid -> {points, expiring}，喂给反代账号池排序用
            for a, (probe, pts) in zip(accs, probed):
                bal[str(a.user_id or "")] = {"points": (pts or {}).get("total"),
                                             "expiring": (pts or {}).get("expiring")}
                if probe is None:
                    out.append({"name": a.nickname, "uid": str(a.user_id or ""),
                                "email": a.email,
                                "phone": a_switch.mask_phone(a_switch.account_phone(a.appdata_dir)),
                                "dir": str(a.appdata_dir),
                                "is_active": bool(live_uid) and str(a.user_id) == live_uid,
                                "auth_expired": False, "token_expires": "", "paused": True,
                                "points": None, "wallets": [], "expiring": 0, "expiring_text": "",
                                "claimable_points": 0, "claimable_count": 0,
                                "claimable_items": [], "blocked": [], "upcoming": [],
                                "newbie_issued": None,
                                "newbie_hint": "",
                                "tasks": []})
                    continue
                probe = probe or {}
                tasks = probe.get("tasks") or []
                cl = probe.get("claimable") or []
                core = [c for c in cl if c.get("kind") in ("daily", "inspiration", "newbie")]
                uid = str(a.user_id or "")
                out.append({
                    "name": a.nickname,
                    "uid": uid,
                    "email": a.email,
                    "phone": a_switch.mask_phone(a_switch.account_phone(a.appdata_dir)),
                    "dir": str(a.appdata_dir),
                    "is_active": bool(live_uid) and uid == live_uid,
                    # 诚实上报：refreshToken 已被服务端轮换掉 → 这号要重新登录，
                    # 绝不能和"今天确实没得领"混成同一种显示
                    "auth_expired": bool(a.auth_expired),
                    "paused": False,
                    "token_expires": (time.strftime("%m-%d %H:%M",
                                                    time.localtime(a.access_expires_at()))
                                      if a.access_expires_at() else ""),
                    "points": pts.get("total"),
                    "wallets": [w for w in pts.get("wallets", []) if w.get("display")],
                    "expiring": pts.get("expiring"),
                    "expiring_text": pts.get("expiring_text", ""),
                    "claimable_points": sum(c.get("points") or 0 for c in core),
                    "claimable_count": len(core),
                    "claimable_items": cl,
                    "blocked": probe.get("blocked") or [],
                    "upcoming": probe.get("upcoming") or [],
                    "newbie_issued": probe.get("newbie_issued"),
                    "newbie_hint": probe.get("newbie_hint") or "",
                    "tasks": [{
                        "id": t.get("task_id"),
                        "title": t.get("title") or t.get("task_id"),
                        "points": t.get("reward_points", 0),
                        "status": t.get("status"),
                        "client_triggered": bool(t.get("client_triggered")),
                    } for t in tasks],
                })
            try:
                conflicts = a_switch.deviceid_conflicts()
            except Exception:
                conflicts = []
            self._sync_cloud_pool(accs, bal)
            return {"ok": True, "accounts": out,
                    "device_conflicts": conflicts,
                    "autoclaw_running": self._autoclaw_running(),
                    "live_uid": live_uid,
                    "settings": dict(_settings),
                    "auto": {"running": _auto["running"], "last": _auto["last"],
                             "next_at": time.strftime("%H:%M:%S", time.localtime(_auto["next_tick"]))
                             if _auto.get("next_tick") else ""},
                    "log": _log_lines[-120:]}
        except Exception as e:
            log("bootstrap 失败: " + repr(e))
            return {"ok": False, "error": str(e), "accounts": [],
                    "autoclaw_running": self._autoclaw_running(),
                    "log": _log_lines[-120:]}

    def points_only(self):
        """轻量轮询：积分/钱包/过期（供常驻显示实时刷新，10 秒内跟上真实消耗）。"""
        if _switch_state.get("active"):
            return {"ok": False, "busy": True}   # 切换途中不碰任何存档凭证（会轮换掉刚写入的那对）
        if not _points_lock.acquire(blocking=False):
            return {"ok": False, "busy": True}   # 上一轮还没跑完：别把同一批号并发刷两遍
        try:
            from concurrent.futures import ThreadPoolExecutor
            accs = a_switch.discover_accounts()

            def one(a):
                try:
                    pts = a.points() or {}
                except Exception as e:
                    log(f"{a.nickname} 余额查询失败：{type(e).__name__}: {e}")
                    pts = {}
                return {"name": a.nickname, "uid": str(a.user_id or ""),
                        "points": pts.get("total"),
                        "wallets": [w for w in pts.get("wallets", []) if w.get("display")],
                        "expiring": pts.get("expiring"),
                        "expiring_text": pts.get("expiring_text", "")}

            with ThreadPoolExecutor(max_workers=min(6, max(1, len(accs)))) as ex:
                out = list(ex.map(one, accs))
            self._sync_cloud_pool(accs, {r["uid"]: r for r in out})
            return {"ok": True, "accounts": out,
                    "synced_at": time.strftime("%H:%M:%S")}
        except Exception as e:
            return {"ok": False, "error": str(e)}
        finally:
            _points_lock.release()

    @staticmethod
    def _conflict() -> str:
        """领取/切换/打卡/登录彼此都会轮换同一批存档 refreshToken，并行就会互相打旧。
        返回非空即为"现在有谁在做这件事"。调用方必须在置自己的标志之前问一次。
        """
        if _busy:
            return "一键领取"
        if _switch_state.get("active"):
            return "账号切换"
        if _sweep_state.get("active"):
            return "活动打卡"
        if _login_state.get("active"):
            return "桌面端登录添加"
        if _headless_state.get("active"):
            return "内置注册/登录"
        return ""

    def claim_all(self, force: bool = False):
        """领取所有可领积分（幂等）。force=True：手动按钮专用，先解除当天的被拒冷却。"""
        global _busy
        c = self._conflict()
        if c:
            return {"ok": False, "error": f"{c}正在进行中，等它结束再领取（都会轮换存档凭证）"}
        _busy = True
        try:
            total = 0
            results = []
            expired = []
            failed = []
            for acc in a_switch.discover_accounts():
                try:
                    log(f"账号 {acc.nickname} (uid={acc.user_id})")
                    tasks = acc.task_list()
                    if acc.auth_expired:
                        # 这号根本没资格进入"+0"的统计：说的是"要重新登录"，不是"没得领"
                        log("  ✗ 登录凭证已失效（存档里的 refreshToken 已被服务端轮换），"
                            "该账号需要重新登录后才能领取")
                        results.append({"account": acc.nickname, "task": "_session",
                                        "title": "登录态", "status": "auth", "points": 0,
                                        "msg": "凭证失效，需重新登录"})
                        expired.append(acc.nickname)
                        continue
                    # 灵感中心每日 200 走独立接口（探测/领取幂等）
                    insp, insp_state = acc.claim_inspiration_daily()
                    if insp:
                        total += insp
                        log(f"  ✓ 灵感中心：+{insp} 分")
                        results.append({"account": acc.nickname, "task": "daily_inspiration_center",
                                        "title": "灵感中心", "status": "ok", "points": insp})
                    elif insp_state == "already":
                        log("  - 灵感中心：今日已领")
                        results.append({"account": acc.nickname, "task": "daily_inspiration_center",
                                        "title": "灵感中心", "status": "already", "points": 0})
                    for nr in acc.claim_newbie_tasks():
                        resp = nr.get("response")
                        data = resp.get("data") if isinstance(resp, dict) else {}
                        got = (data or {}).get("reward_points") or (data or {}).get("points") or 0
                        if got:
                            total += got
                        log(f"  {'✓' if got else '?'} 新人任务 {nr.get('task')}：{('+' + str(got) + ' 分') if got else str(resp)[:120]}")
                        results.append({"account": acc.nickname, "task": "newbie",
                                        "title": "新人任务", "status": "ok" if got else "fail",
                                        "points": got, "msg": None if got else str(resp)[:200]})
                    if not tasks:
                        log("  - 服务端未下发任务列表（该号没有 daily 任务，不影响活动/灵感领取）")
                    if force and acc.clear_all_blocked():
                        log("  ↻ 手动领取：先解除本日已记录的“被拒冷却”，逐项再试一次")
                    blocked_today = acc.blocked_tasks()
                    done_today = acc.claimed_today()
                    for t in tasks:
                        tid = t.get("task_id")
                        if not t.get("client_triggered"):
                            continue
                        ttl = t.get("title") or tid
                        if tid in done_today:
                            log(f"  - {ttl}：今日已到账（流水为准，服务端状态滞后）")
                            results.append({"account": acc.nickname, "task": tid,
                                            "title": t.get("title"), "status": "already",
                                            "points": 0})
                            continue
                        if t.get("status") == "completed":
                            acc.note_claimed(tid)
                            log(f"  - {ttl}：今日已领")
                            results.append({"account": acc.nickname, "task": tid,
                                            "title": t.get("title"), "status": "already", "points": 0})
                            continue
                        if tid in blocked_today:
                            # 服务端今天已经明确拒过一次，再撞也只是同一句回复
                            reason = blocked_today[tid].get("reason") or "服务端已拒绝"
                            log(f"  ✗ {ttl}：今日不再重试（{reason}）")
                            results.append({"account": acc.nickname, "task": tid,
                                            "title": t.get("title"), "status": "blocked",
                                            "points": 0, "msg": reason})
                            continue
                        st, d = acc.claim(tid)
                        dd = (d.get("data") or {}) if isinstance(d, dict) else {}
                        if dd.get("already_completed"):
                            log(f"  - {ttl}：今日已领")
                            acc.clear_blocked(tid)
                            acc.note_claimed(tid)
                            results.append({"account": acc.nickname, "task": tid,
                                            "title": t.get("title"), "status": "already", "points": 0})
                        elif dd.get("success"):
                            got = dd.get("reward_points") or t.get("reward_points") or 0
                            total += got
                            acc.clear_blocked(tid)
                            acc.note_claimed(tid, got)
                            log(f"  ✓ {ttl}：+{got} 分")
                            results.append({"account": acc.nickname, "task": tid,
                                            "title": t.get("title"), "status": "ok", "points": got})
                        else:
                            msg = (d.get("msg") if isinstance(d, dict) else str(d)) or f"HTTP {st}"
                            reason = acc.reject_reason(st, d)
                            if reason:
                                acc.note_blocked(tid, reason)
                                log(f"  ✗ {ttl}：{reason}（今日不再重试）")
                            else:
                                log(f"  ? {ttl}：{msg}")
                            results.append({"account": acc.nickname, "task": tid,
                                            "title": t.get("title"),
                                            "status": "blocked" if reason else "fail",
                                            "points": 0, "msg": reason or msg})
                    # 活动奖励（btnType=default 的奖励型弹窗；服务端判定资格）
                    for pr in acc.claim_active_promotions():
                        resp = pr.get("response")
                        got = 0
                        if isinstance(resp, dict):
                            got = ((resp.get("data") or {}).get("points")) or 0
                        if got:
                            total += got
                        log(f"  {'✓' if got else '-'} 活动 {pr.get('name')}："
                            f"{('+' + str(got) + ' 分') if got else str(resp)[:100]}")
                        results.append({"account": acc.nickname, "task": pr.get("modal_id"),
                                        "title": f"活动 {pr.get('name')}",
                                        "status": "ok" if got else "none", "points": got})
                except Exception as e:
                    # 一个号的异常绝不能吃掉后面所有号（多账号场景下那就是一片空白）
                    log(f"  ✗ {acc.nickname} 这一号处理失败：{type(e).__name__}: {e}")
                    results.append({"account": acc.nickname, "task": "_error",
                                    "title": "处理异常", "status": "error", "points": 0,
                                    "msg": f"{type(e).__name__}: {e}"})
                    failed.append(acc.nickname)
            log(f"完成，本次共 +{total} 分"
                + (f"；另有 {len(expired)} 个账号凭证失效需重新登录：" + "、".join(expired)
                   if expired else "")
                + (f"；{len(failed)} 个账号处理异常（已跳过，不影响其它号）：" + "、".join(failed)
                   if failed else ""))
            return {"ok": True, "total_points": total, "results": results,
                    "expired_accounts": expired, "failed_accounts": failed,
                    "log": _log_lines[-120:]}
        except Exception as e:
            log("领取异常: " + repr(e))
            return {"ok": False, "error": str(e), "log": _log_lines[-120:]}
        finally:
            _busy = False

    def claim_activities(self):
        """尝试领取当前账号的新人/活动奖励；需要外部证明的活动由服务端判定。"""
        global _busy
        c = self._conflict()
        if c:
            return {"ok": False, "error": f"{c}正在进行中，等它结束再领取（都会轮换存档凭证）"}
        _busy = True
        try:
            results = []
            for acc in a_switch.discover_accounts():
                log(f"活动账号 {acc.nickname} (uid={acc.user_id})")
                newbie = acc.claim_newbie_tasks()
                if not newbie:
                    log("  - 服务端未下发可领取新人任务")
                for r in newbie:
                    log(f"  新人任务 {r.get('task')}: {str(r.get('response'))[:180]}")
                    results.append({"account": acc.nickname, "kind": "newbie", "result": r})
                promos = acc.claim_active_promotions()
                if not promos:
                    log("  - 当前没有活动窗口")
                for r in promos:
                    log(f"  活动 {r.get('name')} / {r.get('reward_type')}: HTTP {r.get('http')} {str(r.get('response'))[:180]}")
                    results.append({"account": acc.nickname, "kind": "promotion", "result": r})
            return {"ok": True, "results": results, "log": _log_lines[-120:]}
        except Exception as e:
            log("活动领取异常: " + repr(e))
            return {"ok": False, "error": str(e), "log": _log_lines[-120:]}
        finally:
            _busy = False

    def switch_to(self, uid: str):
        """一键切换 AutoClaw 登录账号（关软件 → 成套换凭证 → 重启 → 观察回跳）。

        整件事要 30~60 秒，必须放后台线程 + JS 轮询，否则那次 js_api 调用挂死、
        界面看不到任何进度，用户会以为"点了没反应"又点一次（两个切换并发会互相抢写）。
        """
        c = self._conflict()
        if c:
            return {"ok": False, "error": f"{c}正在进行中，等它结束再切换（都会轮换存档凭证）"}
        try:
            accs = a_switch.discover_accounts()
            tgt = next((a for a in accs if str(a.user_id) == str(uid)
                        or a.nickname == uid), None)
        except Exception as e:
            return {"ok": False, "error": str(e)}
        if not tgt:
            return {"ok": False, "error": f"找不到账号 {uid}"}
        _switch_state.update({"active": True, "done": False,
                              "msg": f"准备切换到 {tgt.nickname}…", "result": None})
        threading.Thread(target=_switch_worker, args=(tgt,), daemon=True).start()
        return {"ok": True, "started": True, "switched_to": tgt.nickname}

    def switch_status(self):
        """供 JS 轮询切换进度与最终结论（含"身份回跳"的如实报告）。"""
        st = dict(_switch_state)
        st["log"] = _log_lines[-120:]
        return st

    def ac_running(self):
        """AutoClaw 桌面端当前是否在跑（点击加号时的新鲜检测，不用轮询缓存）。"""
        try:
            return {"ok": True, "running": bool(a_switch.autoclaw_running())}
        except Exception as e:
            return {"ok": False, "running": False, "error": str(e)}

    def login_add(self, timeout: int = 300):
        """官方登录窗口加号：桌面端在跑时先让它让位，完事无论成败都重启并回查反代。

        让位这几分钟桌面端进程里的 broker 确实没了；反代在拿不到 broker 时会用本机
        凭证直连云端（2026-09-20 起），所以算力中不中断由 /health 的 upstream 说了算，
        结束时把它的结论原样显示出来，不在这里替它保证。
        """
        global _login_state
        c = self._conflict()
        if c:
            return {"ok": False, "error": f"{c}正在进行中，等它结束再登录添加"}
        _login_state = {"active": True, "done": False,
                        "msg": "正在让桌面端让位…", "result": None}

        def worker():
            def on_prog(m):
                _login_state["msg"] = m
                log(m)
            r = a_switch.login_add_with_yield(timeout=timeout, on_progress=on_prog)
            _login_state["result"] = r
            note = str(r.get("yield_note") or "")
            _login_state["msg"] = (("已添加" if r.get("ok") else f"失败：{r.get('error')}")
                                   + (f"　|　{note}" if note else ""))
            _login_state["active"] = False
            _login_state["done"] = True

        threading.Thread(target=worker, daemon=True).start()
        return {"ok": True, "started": True}

    def login_status(self):
        """供 JS 轮询登录进度。"""
        st = dict(_login_state)
        st["log"] = _log_lines[-120:]
        return st

    def send_login_code(self, phone: str):
        """内置添加账号第一步：给这个号预铸独立设备身份 + 发送短信验证码。

        服务端对未注册手机号执行的就是注册（响应 first_login），AutoClaw 桌面端全程不参与；
        验证码只能人读，所以流程天然拆成两步，deviceId 在两步之间必须保持一致。
        """
        c = self._conflict()
        if c:
            return {"ok": False, "error": f"{c}正在进行中，等它结束再发码"}
        phone = re.sub(r"\D", "", str(phone or ""))
        try:
            r = a_switch.begin_headless_add(phone)
        except Exception as e:
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}
        if r.get("ok"):
            # 手机号只留在 Python 侧：前端拿得到的是掩码，换码时也不必回传
            _headless_state["phone"] = phone
        return r

    def relogin_send(self, uid: str):
        """档案里凭证已失效的号：用它自己的 deviceId 重新发码（服务端不认新身份）。"""
        phone = a_switch.account_phone(a_switch.ACCOUNTS_DIR / str(uid))
        if not phone:
            return {"ok": False, "error": "这份档案没记手机号（桌面端导入的号）——"
                                          "用「内置添加账号」输入它的手机号即可重新登录"}
        r = self.send_login_code(phone)
        r["phone"] = a_switch.mask_phone(phone)
        return r

    def headless_add(self, phone: str, code: str):
        """内置添加账号第二步：验证码换凭证 → 合成档案目录 → 绑定邀请码。"""
        global _headless_state
        c = self._conflict()
        if c:
            return {"ok": False, "error": f"{c}正在进行中，等它结束再提交验证码"}
        phone = re.sub(r"\D", "", str(phone or "")) or str(_headless_state.get("phone") or "")
        if not phone:
            return {"ok": False, "error": "先发验证码再填码"}
        _headless_state = {"active": True, "done": False, "msg": "正在校验验证码…",
                           "result": None, "phone": phone}

        def worker():
            def on_prog(m):
                _headless_state["msg"] = m
                log(m)
            try:
                r = a_switch.finish_headless_add(
                    phone, str(code or ""),
                    invite_code=str(_settings.get("invite_code") or ""),
                    on_progress=on_prog)
            except Exception as e:
                r = {"ok": False, "error": f"{type(e).__name__}: {e}"}
            _headless_state["result"] = r
            _headless_state["msg"] = "完成" if r.get("ok") else f"失败：{r.get('error')}"
            _headless_state["active"] = False
            _headless_state["done"] = True

        threading.Thread(target=worker, daemon=True).start()
        return {"ok": True, "started": True}

    def headless_status(self):
        """供 JS 轮询内置注册的进度与结论（手机号只以掩码外泄）。"""
        st = {k: v for k, v in _headless_state.items() if k != "phone"}
        st["phone_masked"] = a_switch.mask_phone(_headless_state.get("phone") or "")
        st["log"] = _log_lines[-120:]
        return st

    def add_account(self, directory: str):
        """从指定目录导入一份 AutoClaw 账号（需含 auth.json + Local State）。"""
        try:
            if not directory or not Path(directory).is_dir():
                return {"ok": False, "error": "目录不存在"}
            rc = a_switch.cmd_add(directory)
            return {"ok": rc == 0, "log": _log_lines[-120:]}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def export_accounts(self, out_dir: str = ""):
        out = out_dir or r"D:\autoclaw-switch\export"
        try:
            rc = a_switch.cmd_export(out)
            return {"ok": rc == 0, "dir": out, "log": _log_lines[-120:]}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def launch_autoclaw(self):
        # 走 a_switch 的启动路径：AutoClaw.exe 带提升清单，直接 Popen 会 WinError 740
        ok, detail = a_switch.launch_autoclaw()
        log("已启动 AutoClaw" if ok else f"启动失败：{detail}")
        return {"ok": ok, "error": None if ok else detail}

    def set_setting(self, key: str, value):
        """改设置项并落盘（auto_claim / auto_sweep）。"""
        if key not in ("auto_claim", "auto_sweep"):
            return {"ok": False, "error": "未知设置项"}
        _settings[key] = bool(value)
        a_switch.save_settings(_settings)
        log(f"设置 {key} = {bool(value)}")
        if key == "auto_claim" and value:
            _auto["next_tick"] = 0.0  # 打开后尽快跑第一轮
        return {"ok": True, "settings": dict(_settings)}

    def settings_state(self):
        st = {"settings": dict(_settings),
              "auto": {"running": _auto["running"], "last": _auto["last"],
                       "last_error": _auto.get("last_error", ""),
                       "warmup_left": max(0, int(_auto.get("warmup_until", 0.0) - time.time())),
                       "beat": _auto.get("beat", 0), "beat_at": _auto.get("beat_at", 0.0),
                       "next_at": time.strftime("%H:%M:%S", time.localtime(_auto["next_tick"]))
                       if _auto.get("next_tick") else "",
                       "enabled": bool(_settings.get("auto_claim")),
                       "sweep_enabled": bool(_settings.get("auto_sweep")),
                       "busy_claim": bool(_busy),
                       "switch_active": bool(_switch_state.get("active")),
                       "login_active": bool(_login_state.get("active")),
                       "headless_active": bool(_headless_state.get("active")),
                       "sweep_active": bool(_sweep_state.get("active"))}}
        return st

    def activity_sweep(self):
        """手动活动登录打卡：后台线程逐号拉起隔离实例。"""
        c = self._conflict()
        if c:
            return {"ok": False, "error": f"{c}正在进行中，等它结束再打卡"}
        _sweep_state.update({"active": True, "done": False,
                             "msg": "打卡开始…", "results": None})
        threading.Thread(target=_sweep_worker, daemon=True).start()
        return {"ok": True, "started": True}

    def sweep_status(self):
        return {"sweep": dict(_sweep_state), "log": _log_lines[-120:]}

    def save_invite(self, code: str):
        code = (code or "").strip().upper()
        if code and (len(code) < 4 or len(code) > 16 or not code.isalnum()):
            return {"ok": False, "error": "邀请码格式不对（4-16 位字母数字）"}
        _settings["invite_code"] = code
        a_switch.save_settings(_settings)
        log(f"邀请码已保存：{a_switch.mask_invite_code(code)}")
        return {"ok": True, "code": code}

    def invite_fetch(self):
        """取"大号"的邀请码：优先当前登录在 AutoClaw 里的那个号，其次按入库顺序。

        以前是"库里第一个有码的号"，那可能根本不是用户心里的大号 ——
        取错码等于把奖励送给别人，所以这里显式按活动目录优先排，并把是谁报出来。
        """
        live_uid = a_switch.live_identity_uid()
        accs = a_switch.discover_accounts()
        accs.sort(key=lambda a: (str(a.user_id) != str(live_uid),))
        for a in accs:
            code = a.my_invite_code()
            if code:
                _settings["invite_code"] = code
                a_switch.save_settings(_settings)
                log(f"已取到 {a.nickname}（jwt_uid={a.jwt_uid()}）的邀请码："
                    f"{a_switch.mask_invite_code(code)}")
                return {"ok": True, "code": code, "name": a.nickname,
                        "jwt_uid": a.jwt_uid(), "is_live": str(a.user_id) == str(live_uid)}
        return {"ok": False, "error": "没有账号能取到邀请码（是否都已绑定他人？）"}

    def invite_bind_all(self):
        """为所有未绑定账号补绑邀请码（老账号可能被服务端拒绝，如实回报）。"""
        c = self._conflict()
        if c:
            return {"ok": False, "error": f"{c}正在进行中，等它结束再补绑"}
        code = (_settings.get("invite_code") or "").strip()
        if not code:
            return {"ok": False, "error": "请先保存邀请码"}
        out = []
        for a in a_switch.discover_accounts():
            s = a.invite_status()
            if (s.get("share") or {}).get("invite_code") == code:
                out.append({"name": a.nickname, "status": "本人邀请码，跳过"})
                continue
            b = s.get("bind") or {}
            if b.get("status") != "unbound" or not b.get("can_bind"):
                out.append({"name": a.nickname, "status": "已绑定/不可绑定，跳过"})
                continue
            st, d = a.bind_invite_code(code)
            ok = isinstance(d, dict) and d.get("code") == 0
            msg = "✓ 已绑定" if ok else str((d.get("msg") if isinstance(d, dict) else d) or d)[:80]
            out.append({"name": a.nickname, "status": msg})
        for o in out:
            log(f"  补绑 {o['name']}: {o['status']}")
        return {"ok": True, "results": out, "log": _log_lines[-120:]}

    def invite_check(self):
        """只读复核邀请奖励：不看接口返回值，只看邀请人自己的计数与流水。"""
        c = self._conflict()
        if c:
            return {"ok": False, "error": f"{c}正在进行中，等它结束再复核"}
        log("邀请奖励复核（只读）…")
        rows = a_switch.invite_reward_check(say=log)
        return {"ok": True, "rows": rows, "log": _log_lines[-120:]}

    def relay_setup(self):
        """一键反代：部署 relay + 注册 ZCode 供应商 + 验证推理。后台线程，JS 轮询日志。"""
        def work():
            global _busy
            try:
                log("一键反代开始：凭证 → relay → ZCode 注册 → 验证…")
                r = a_switch.relay_oneclick_setup()
                if r.get("ok"):
                    for st in r.get("steps", []):
                        log("  " + st)
                    log("✅ 完成。重启 ZCode 后即可在模型列表选 AutoClaw。")
                else:
                    log("✗ 失败：" + str(r.get("error")))
                    for st in r.get("steps", []):
                        log("  " + st)
            except Exception as e:
                log(f"✗ 异常 {type(e).__name__}: {e}")
            finally:
                _busy = False
        if _busy:
            return {"ok": False, "error": "有任务进行中"}
        _busy = True
        threading.Thread(target=work, daemon=True).start()
        return {"ok": True}

    def relay_warm(self):
        """对未暖号跑暖号（新号建议点一次，8 轮真实对话建立用量基线）。"""
        def work():
            global _busy
            try:
                log("暖号开始（8 轮真实对话，约 3-5 分钟）…")
                r = a_switch.warm_unwarmed_accounts(8)
                if r.get("ok"):
                    for x in r.get("results", []):
                        log(f"  {x['name']}: {x['tail']}")
                    log("✅ 暖号结束（看上方 RATIO 是否达标）")
                else:
                    log("✗ " + str(r.get("error")))
            except Exception as e:
                log(f"✗ 异常 {type(e).__name__}: {e}")
            finally:
                _busy = False
        if _busy:
            return {"ok": False, "error": "有任务进行中"}
        _busy = True
        threading.Thread(target=work, daemon=True).start()
        return {"ok": True}

    def relay_status(self):
        """查询本机 AutoClaw -> ZCode 反代；不碰 AutoClaw 进程。"""
        import urllib.request
        try:
            req = urllib.request.Request("http://127.0.0.1:18766/health")
            with urllib.request.urlopen(req, timeout=5) as r:
                d = json.loads(r.read().decode("utf-8", "replace"))
            return {"ok": True, "status": d.get("status"), "broker": d.get("broker"),
                    "upstream": d.get("upstream"), "models": d.get("models", [])}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def restart_relay(self):
        """只重启 server.mjs；watchdog 会拉起新进程，绝不杀 AutoClaw。"""
        try:
            out = subprocess.run(
                ["powershell", "-NoProfile", "-Command",
                "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | "
                "Where-Object { $_.CommandLine -like '*server.mjs*' "
                "-and $_.CommandLine -like '*autoclaw-model-endpoint*' } | "
                "Select-Object -ExpandProperty ProcessId"],
                capture_output=True, text=True, timeout=15,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            pids = []
            for line in (out.stdout or "").splitlines():
                try:
                    pids.append(int(line.strip()))
                except ValueError:
                    pass
            if not pids:
                r = a_switch.relay_start()
                log("已重新启动反代" if r.get("ok") else "反代重启失败：" + str(r.get("error")))
                return r
            for pid in pids:
                subprocess.run(
                    ["taskkill", "/F", "/T", "/PID", str(pid)],
                    capture_output=True, timeout=15,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
            log(f"已重启反代（server.mjs pid={pids}）")
            return {"ok": True, "pids": pids}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def pick_dir(self):
        """原生目录选择对话框。"""
        try:
            import webview
            win = webview.windows[0] if webview.windows else None
            if win is None:
                return {"ok": False, "error": "窗口未就绪"}
            res = win.create_file_dialog(webview.FOLDER_DIALOG)
            if res:
                return {"ok": True, "dir": res[0]}
            return {"ok": False, "error": "未选择"}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # ---------------- 内部 ----------------
    def _autoclaw_running(self) -> bool:
        try:
            out = subprocess.run(
                ["tasklist", "/FI", "IMAGENAME eq AutoClaw.exe", "/FO", "CSV"],
                capture_output=True, timeout=10,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout
            # tasklist 在中文 Windows 输出 GBK，用 errors='replace' 容错
            return b"AutoClaw.exe" in (out or b"")
        except Exception:
            return False


# ---------------- 前端（Z·SWITCH 同款视觉） ----------------
INDEX_HTML = r"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<title>A·SWITCH</title>
<style>
:root{
  --bg:#16171b; --bg-2:#1b1d22; --panel:#1f2127; --panel-2:#23252c;
  --hairline:#2c2f37; --hairline-soft:#26282f;
  --ink:#e9e7e1; --ink-dim:#b3b6bf; --ink-mute:#838794;
  --amber:#e8a33d; --amber-deep:#c9862a; --amber-ink:#241a09;
  --mint:#62c370; --mint-dim:#3d8a4a; --red:#e05252; --red-dim:#8f3434;
  --mono:"Cascadia Code","Consolas",monospace;
  --body:"Segoe UI","Microsoft YaHei UI","PingFang SC",sans-serif;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{
  background:linear-gradient(180deg,var(--bg-2) 0%,var(--bg) 220px);
  color:var(--ink);font:13.5px/1.6 var(--body);
  -webkit-font-smoothing:antialiased;overflow:hidden;
}
#app{display:flex;flex-direction:column;height:100vh}
header{
  padding:18px 22px 14px;border-bottom:1px solid var(--hairline-soft);
  display:flex;align-items:center;justify-content:space-between;gap:12px;
  -webkit-app-region:drag;
}
.brand{display:flex;align-items:center;gap:10px}
.logo{
  width:30px;height:30px;border-radius:8px;flex:none;
  background:linear-gradient(135deg,var(--amber) 0%,var(--amber-deep) 100%);
  display:flex;align-items:center;justify-content:center;
  color:var(--amber-ink);font-weight:700;font-size:15px;
}
.brand h1{font-size:15px;font-weight:600;letter-spacing:.3px}
.brand .sub{font-size:11.5px;color:var(--ink-mute);margin-top:1px}
main{flex:1;overflow-y:auto;padding:16px 22px 24px}
main::-webkit-scrollbar{width:9px}
main::-webkit-scrollbar-thumb{background:#2f323b;border-radius:6px}
main::-webkit-scrollbar-track{background:transparent}
.card{
  background:var(--panel);border:1px solid var(--hairline);border-radius:11px;
  padding:15px 17px;margin-bottom:12px;
}
.card h2{font-size:12.5px;font-weight:600;color:var(--ink-dim);letter-spacing:.4px;
  text-transform:uppercase;margin-bottom:11px;display:flex;justify-content:space-between;align-items:center}
.row{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
button{
  background:var(--panel-2);color:var(--ink);border:1px solid var(--hairline);
  border-radius:8px;padding:7px 14px;font:13px var(--body);cursor:pointer;
  transition:background .14s,border-color .14s;
}
button:hover{background:#2a2d35;border-color:#383c46}
button:disabled{opacity:.45;cursor:not-allowed}
button.primary{background:var(--amber);color:var(--amber-ink);border-color:var(--amber-deep);font-weight:600}
button.primary:hover{background:#f0ae4a}
button.ghost{background:transparent}
button.sm{padding:5px 10px;font-size:12px}
.pill{
  display:inline-flex;align-items:center;gap:5px;font-size:11.5px;
  padding:3px 9px;border-radius:20px;background:var(--bg-2);
  border:1px solid var(--hairline);color:var(--ink-mute);
}
.pill.ok{color:var(--mint);border-color:var(--mint-dim);background:rgba(98,195,112,.09)}
.pill.warn{color:var(--amber);border-color:var(--amber-deep);background:rgba(232,163,61,.09)}
.pill.bad{color:var(--red);border-color:var(--red-dim);background:rgba(224,82,82,.09)}
.pill.pts{color:var(--amber);border-color:var(--amber-deep);background:rgba(232,163,61,.12);gap:6px}
.pill.pts b{font-family:var(--mono);font-size:13.5px;font-weight:600;color:var(--amber)}
.dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
.flash{animation:flash .7s ease}
@keyframes flash{0%{filter:brightness(2.2)}100%{filter:none}}
.bal .num{font-family:var(--mono);font-size:20px;font-weight:600;color:var(--amber);letter-spacing:.5px}
.bal .unit{font-size:11.5px;color:var(--ink-mute);margin-left:4px}
.acct{border:1px solid var(--hairline-soft);border-radius:9px;padding:12px 14px;margin-bottom:9px;background:var(--bg-2)}
.acct .top{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.acct .nm{font-weight:600;font-size:14px}
.acct .meta{font-size:11.5px;color:var(--ink-mute);font-family:var(--mono)}
label.tog{cursor:pointer;gap:6px}
label.tog input{accent-color:var(--amber);cursor:pointer}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.chips .pill{font-size:11px;padding:2px 8px}
.chips .muted{font-size:10.5px}
.inviteRow{gap:8px;margin-top:2px}
.inviteInput{
  background:var(--bg);border:1px solid var(--hairline);border-radius:7px;
  color:var(--ink);padding:6px 10px;font:12.5px var(--mono);width:180px;outline:none;
}
.inviteInput:focus{border-color:var(--amber-deep)}
.codeInput{width:96px;letter-spacing:3px;text-align:center}
table{width:100%;border-collapse:collapse;margin-top:10px}
th{font-size:11px;color:var(--ink-mute);font-weight:500;text-align:left;padding:6px 8px;border-bottom:1px solid var(--hairline-soft)}
td{padding:7px 8px;border-bottom:1px solid var(--hairline-soft);font-size:12.5px}
tr:last-child td{border-bottom:none}
td.pt{font-family:var(--mono);color:var(--amber);white-space:nowrap}
td.st{color:var(--ink-mute);font-size:11.5px;white-space:nowrap}
.star{color:var(--amber)}
#log{
  background:#101115;border:1px solid var(--hairline-soft);border-radius:8px;
  padding:11px 13px;font:12px/1.65 var(--mono);color:var(--ink-dim);
  height:190px;overflow-y:auto;white-space:pre-wrap;word-break:break-all;
}
#log::-webkit-scrollbar{width:8px}
#log::-webkit-scrollbar-thumb{background:#2f323b;border-radius:6px}
.muted{color:var(--ink-mute);font-size:12.5px}
.empty{text-align:center;color:var(--ink-mute);padding:26px 10px;font-size:12.5px;line-height:1.9}
.toast{
  position:fixed;left:50%;bottom:22px;transform:translateX(-50%) translateY(12px);
  background:var(--panel-2);border:1px solid var(--hairline);color:var(--ink);
  padding:9px 17px;border-radius:9px;font-size:12.5px;opacity:0;
  transition:opacity .2s,transform .2s;pointer-events:none;z-index:9;
  box-shadow:0 8px 26px rgba(0,0,0,.5);
}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
</style></head>
<body><div id="app">
<header>
  <div class="brand">
    <div class="logo">A</div>
    <div>
      <h1>A·SWITCH</h1>
      <div class="sub">AutoClaw 多账号管理 · 每日签到领积分</div>
    </div>
  </div>
  <div class="row" style="gap:8px">
    <span id="ptsPill" class="pill pts"><span class="dot"></span><b id="ptsText">--</b><span class="muted" style="font-size:11px">积分</span></span>
    <span id="envPill" class="pill"><span class="dot"></span><span id="envText">检查中…</span></span>
    <label class="pill tog" title="开启后每小时检测并领取一次">
      <input type="checkbox" id="tgAuto" onchange="App.setSetting('auto_claim', this.checked)"/> 自动领取</label>
    <label class="pill tog" title="登录型活动窗口期内逐号自动登录到账">
      <input type="checkbox" id="tgSweep" onchange="App.setSetting('auto_sweep', this.checked)"/> 活动打卡</label>
    <span id="autoPill" class="pill"><span id="autoText"></span></span>
    <button class="sm ghost" id="langBtn" onclick="toggleLang()" title="Switch language">EN</button>
    <button class="sm ghost" onclick="App.sweep()" title="为每个账号在隔离窗口登录打卡">🎯 打卡</button>
    <button class="sm ghost" onclick="App.launchAc()">启动</button>
    <button class="sm ghost" onclick="App.relaySetup()" title="部署反代并注册到 ZCode（幂等）">⚡ 一键反代</button>
    <button class="sm ghost" onclick="App.relay()" title="查看反代状态">反代状态</button>
    <button class="sm ghost" onclick="App.relayWarm()" title="新号建议点一次：8 轮真实对话建立用量基线">🔥 暖号</button>
  </div>
</header>
<main>
  <div class="card">
    <h2>账号 <span class="muted" id="acctSummary"></span></h2>
    <div class="row" style="margin-bottom:10px">
      <div>
        <button class="primary" id="btnClaim" onclick="App.claim()">⚡ 一键领取全部积分</button>
        <button class="sm ghost" id="btnActivities" onclick="App.claimActivities()">🎁 新人/活动积分</button>
        <button class="sm ghost" onclick="App.refresh()">刷新</button>
      </div>
      <div>
        <!-- 内置添加账号（手机号直连注册）已下线：非官方客户端调用、上游风控收紧后价值不大。
             桌面端登录添加是实测稳定路径，升为主按钮。手机号面板与 JS 保留休眠，需要时可恢复。 -->
        <button class="primary" id="btnLoginAdd" onclick="App.loginAdd()"
                title="打开 AutoClaw 官方登录窗口；桌面端在跑时自动让位，登录结束自动重启">🖥 桌面端登录添加</button>
        <button class="sm ghost" onclick="App.addAcct()">导入账号</button>
        <button class="sm ghost" onclick="App.exportAccts()">导出备份</button>
      </div>
    </div>
    <div class="row inviteRow" id="addPanel" style="display:none">
      <span class="muted" style="font-size:12px">📱 手机号</span>
      <input id="phoneInput" class="inviteInput" placeholder="11 位手机号" maxlength="11" inputmode="numeric"/>
      <button class="sm primary" id="btnSendCode" onclick="App.sendCode()">发送验证码</button>
      <input id="codeInput" class="inviteInput codeInput" placeholder="6 位码" maxlength="6" inputmode="numeric"/>
      <button class="sm" id="btnFinishAdd" onclick="App.finishAdd()" disabled>登录并入档</button>
      <button class="sm ghost" onclick="App.closeAdd()">收起</button>
    </div>
    <div class="row inviteRow" id="addHint" style="display:none">
      <span class="muted" id="addHintText" style="font-size:11.5px"></span>
    </div>
    <div class="row inviteRow" title="新添加的账号自动绑定；受邀号真实使用之后才计奖">
      <span class="muted" style="font-size:12px">🔗 邀请码</span>
      <input id="inviteInput" class="inviteInput" placeholder="你的大号邀请码" maxlength="16"/>
      <button class="sm" onclick="App.inviteSave()">保存</button>
      <button class="sm ghost" onclick="App.inviteFetch()">从大号取码</button>
      <button class="sm ghost" onclick="App.inviteBindAll()">补绑未绑定账号</button>
      <button class="sm ghost" onclick="App.inviteCheck(this)"
              title="只读核对：每个号绑给了谁、邀请人自己收到了多少">复核奖励</button>
    </div>
    <div id="accounts"></div>
  </div>

  <div class="card">
    <h2>操作日志</h2>
    <div id="log">就绪。</div>
  </div>
</main></div>
<div class="toast" id="toast"></div>
<script>

// ---------- i18n（zh/en）：渲染后文本节点翻译层 ----------
// 范围：UI 骨架 + 账号卡 + 状态/toast；#log 保持后端原文（运维日志不翻）。
// 两级：EXACT 精确匹配；PAT 正则（含变量的串）。
const I18N_EN = {
  "AutoClaw 多账号管理 · 每日签到领积分":"AutoClaw multi-account manager · daily check-in & rewards",
  "积分":"pts", "检查中…":"checking…", "自动领取":"Auto claim",
  "开启后每小时检测并领取一次":"Check and claim hourly when on",
  "活动打卡":"Event check-in", "打卡":"Check-in",
  "登录型活动窗口期内逐号自动登录到账":"During event windows, log in each account to collect",
  "为每个账号在隔离窗口登录打卡":"Log in each account in an isolated window to check in",
  "启动":"Launch", "⚡ 一键反代":"⚡ One-click relay",
  "部署反代并注册到 ZCode（幂等）":"Deploy relay and register into ZCode (idempotent)",
  "反代状态":"Relay status", "查看反代状态":"Show relay status",
  "🔥 暖号":"🔥 Warm-up",
  "新号建议点一次：8 轮真实对话建立用量基线":"Run once for new accounts: 8 real conversations to build a human-shaped usage baseline",
  "账号":"Accounts", "⚡ 一键领取全部积分":"⚡ Claim all points",
  "🎁 新人/活动积分":"🎁 Newbie/event points", "刷新":"Refresh",
  "➕ 内置添加账号":"➕ Built-in add account",
  "免桌面端：手机号验证码直接注册/登录并入档":"No desktop needed: register/login by SMS code and archive",
  "🖥 桌面端登录添加":"🖥 Add via desktop login",
  "打开 AutoClaw 官方登录窗口；桌面端在跑时自动让位，登录结束自动重启":"Opens the official login window; the running desktop steps aside and is restored afterwards",
  "导入账号":"Import", "导出备份":"Export backup",
  "📱 手机号":"📱 Phone", "11 位手机号":"11-digit phone", "发送验证码":"Send code",
  "6 位码":"6-digit code", "登录并入档":"Login & archive", "收起":"Collapse",
  "🔗 邀请码":"🔗 Invite code", "你的大号邀请码":"Invite code of your main account",
  "保存":"Save", "从大号取码":"Fetch from main", "补绑未绑定账号":"Bind unbound accounts",
  "复核奖励":"Audit rewards",
  "只读核对：每个号绑给了谁、邀请人自己收到了多少":"Read-only audit: who each account is bound to, and what the invoker received",
  "新添加的账号自动绑定；受邀号真实使用之后才计奖":"New accounts bind automatically; invitee rewards settle after real usage",
  "操作日志":"Log", "就绪。":"Ready.",
  "未发现 AutoClaw 账号":"No AutoClaw accounts found",
  "点上方「➕ 内置添加账号」用手机号注册/登录，或「导入账号」从其它目录导入":"Use ➕ Built-in add above to register by phone, or Import from another directory",
  "当前登录":"current", "凭证已失效 · 需重新登录":"credential expired · re-login needed",
  "切换中 · 暂停探测":"switching · probing paused", "今日已领完":"claimed today",
  "暂无任务下发":"no tasks", "可领":"claimable", "新人":"newbie", "每日":"daily",
  "灵感":"inspiration", "活动":"event", "外部活动":"external", "活动预告":"upcoming",
  "任务":"tasks", "状态":"status", "运行中":"running", "未运行":"not running",
  "重新登录":"Re-login", "切换到此账号":"Switch to this account",
  "个可领 · ":" claimable · ", " 分即将过期":" pts expiring soon",
  " 项服务端未放行":" blocked server-side",
  "组账号共用同一份设备身份（新人资格一台设备只算一次）":"accounts share one device identity (new-user bonus counted once per device)",
  "个账号 · ":" accounts · ", "个任务可领 ":" tasks worth ",
  "自动领取已开启":"Auto claim on", "自动领取已关闭":"Auto claim off",
  "活动打卡已开启":"Event check-in on", "活动打卡已关闭":"Event check-in off",
  "自动：已关闭":"Auto: off", "自动：启动中":"Auto: starting ",
  "自动：引擎已停止（重启程序恢复）":"Auto: engine stopped (restart to recover)",
  "自动：检测中…":"Auto: checking…", "自动：等手动领取结束":"Auto: waiting for manual claim",
  "自动：等账号切换结束":"Auto: waiting for account switch", "自动：等登录结束":"Auto: waiting for login",
  "自动：等打卡结束":"Auto: waiting for check-in", "自动：待命":"Auto: standby",
  "自动：上轮未完成，":"Auto: last round unfinished, retry at ",
  "自动：下次":"Auto: next ",
  "（上轮 +":" (last round +", "）":")",
  "一键反代：部署本地反代 + 把 AutoClaw 注册进 ZCode（幂等，可重复点）。继续？":"One-click relay: deploy local relay + register AutoClaw into ZCode (idempotent). Continue?",
  "反代正常 · 云端直连，不用开桌面端":"Relay OK · direct cloud, desktop not needed",
  "反代正常 · broker 已连接":"Relay OK · broker connected",
  "反代当前不可用，重新部署并启动？":"Relay is down. Redeploy and start?",
  "反代已重启":"Relay restarted", "重启失败：":"Restart failed: ",
  "进行中，看操作日志":"In progress, see the log",
  "对新号跑 8 轮真实对话建立用量基线（防止被判机器号）。继续？":"Run 8 real conversations for new accounts to build a usage baseline (avoids bot-flagging). Continue?",
  "暖号进行中，看操作日志":"Warming up, see the log",
  "领取中…":"Claiming…", "领取活动中…":"Claiming events…", "刷新中…":"Refreshing…",
  "发送中…":"Sending…", "发码中…":"Sending code…", "切换中…":"Switching…",
  "提交失败":"Submit failed", "发送失败":"Send failed", "保存失败":"Save failed",
  "设置失败：":"Save setting failed: ", "导入失败：":"Import failed: ",
  "导出失败：":"Export failed: ", "添加失败：":"Add failed: ",
  "入档失败":"Archive failed", "启动失败：":"Launch failed: ",
  "启动登录失败":"Login launch failed", "启动登录失败：":"Login launch failed: ",
  "启动切换失败":"Switch launch failed", "启动切换失败：":"Switch launch failed: ",
  "切换失败：":"Switch failed: ", "⚠ 切换失败：身份回跳到":"⚠ Switch failed: identity bounced to ",
  "打卡失败：":"Check-in failed: ", "打卡完成":"Check-in done",
  "无法开始打卡":"Cannot start check-in", "复核失败":"Audit failed",
  "提交失败：":"Submit failed: ", "发送失败：":"Send failed: ",
  "验证码是 6 位数字":"Code must be 6 digits", "验证码已发送":"Code sent",
  "手机号得是 11 位中国大陆号码":"Phone must be an 11-digit mainland CN number",
  "填手机号 → 发送验证码 → 登录并入档，全程不开桌面端。":"Phone -> send code -> login & archive. Desktop app stays closed.",
  "正在校验验证码并入档…":"Verifying code and archiving…", "等待登录中…":"Waiting for login…",
  "已启动 AutoClaw":"AutoClaw launched", "已添加账号":"Account added",
  "已入档":"archived", "账号已导入":"Account imported", "已切换到":"Switched to ",
  "该账号本来就是当前登录账号，未做改动":"Already the current account; nothing changed",
  "老号已重新登录":"Existing account re-logged-in",
  "已导出到":"Exported to ", "邀请码已保存：":"Invite code saved: ",
  "开始补绑…":"Binding unbound accounts…", "活动/新人奖励请求已完成":"Event/newbie reward requests finished",
  "活动打卡开始：将逐号拉起登录窗口（每号约 80 秒，不影响当前登录）":"Event check-in starting: one login window per account (~80s each, current login unaffected)",
  "致命错误:\n":"Fatal error:\n", "失败：":"Failed: ", "未知":"unknown",
  "切换账号会关闭并重启 AutoClaw，全程约 1 分钟（含身份回跳观察），确定继续？":"Switching closes and restarts AutoClaw, ~1 minute. Continue?",
  "手机号":"Phone", "邀请码":"Invite code",
  "（新铸身份 → 全新账号）":"(new identity -> brand-new account)",
  "（沿用已有身份 → 老号重新登录）":"(existing identity -> re-login)",
  "（观察期身份未回跳）":"(identity not bounced during observation)",
  "，开始领取积分":", claiming points",
  "未放行·":"blocked · ", "新人·":"newbie · ", "未下发":"not issued",
  "暂无计奖（好友号要真实使用后才结算，可稍后再复核）":"No rewards settled yet (invitees count after real usage; re-audit later)",
  "· 邀请码已绑定":"· invite bound",
  "读取失败：":"Read failed: ",
  "桌面端先让位，登录完会自动重启并校验算力":"Desktop steps aside first; it restarts automatically after login",
};
const I18N_EN_PAT = [
  [/^凭证 (.+) 到期$/, (m)=>"credential expires " + m[1]],
  [/^自动：下次 (.+)（上轮 \+(\d+)）$/, (m)=>"Auto: next " + m[1] + " (last round +" + m[2] + ")"],
  [/^(\d+) 个可领 · (\d+) 分$/, (m)=>m[1] + " claimable · " + m[2] + " pts"],
  [/^(\d+) 个账号 · (.+)$/, (m)=>m[1] + " accounts · " + m[2]],
  [/^新人·(.+)$/, (m)=>"newbie · " + m[1]],
  [/^未放行·(.+)$/, (m)=>"blocked · " + m[1]],
  [/^预告·(.+) (.+)~(.+)$/, (m)=>"upcoming · " + m[1] + " " + m[2] + "~" + m[3]],
  [/^(\d+) 分$/, (m)=>m[1] + " pts"],
  [/^\+(\d+)分$/, (m)=>"+" + m[1] + " pts"],
];
function _i18nNode(n){
  if(n.nodeType===3){
    const t=n.textContent; if(!t||!/[一-鿿]/.test(t)) return;
    let v=t.trim();
    if(I18N_EN[v]!==undefined){ n.textContent=t.replace(v,I18N_EN[v]); return; }
    const v2=v.replace(/^[^一-鿿]+/,"");   // 剥掉 emoji/符号前缀再试（🎯 打卡 等）
    if(v2 && I18N_EN[v2]!==undefined){ n.textContent=t.replace(v,I18N_EN[v2]); return; }
    for(const [re,fn] of I18N_EN_PAT){
      const m=v.match(re);
      if(m){ n.textContent=t.replace(v,fn(m)); return; }
    }
    return;
  }
  if(n.nodeType===1){
    if(n.id==="log"){                              // 后端日志保持原文；仅静态占位翻
      if(LANG==="en" && n.textContent.trim()==="就绪。") n.textContent="Ready.";
      return;
    }
    if(n.tagName==="INPUT"){
      if(n.dataset.phEn===undefined) n.dataset.phEn=n.placeholder;
      const ph=n.dataset.phEn;
      if(/[一-鿿]/.test(ph)){
        const v=ph.trim();
        if(I18N_EN[v]!==undefined) n.placeholder=I18N_EN[v];
      }
      return;
    }
    for(const c of n.childNodes) _i18nNode(c);
    if(n.title && I18N_EN[n.title]) n.title=I18N_EN[n.title];
  }
}
let LANG = localStorage.getItem("asw_lang") || "zh";
function applyLang(){
  document.documentElement.lang = LANG==="en" ? "en" : "zh-CN";
  if(LANG==="en") _i18nNode(document.body);
  const b=document.getElementById("langBtn");
  if(b) b.textContent = LANG==="en" ? "中" : "EN";
}
function toggleLang(){
  LANG = LANG==="en" ? "zh" : "en";
  localStorage.setItem("asw_lang", LANG);
  if(LANG==="en") applyLang(); else location.reload();   // 回中文：整页重载最干净
}
// 渲染出的动态内容也要翻
let _i18nBusy=false;
new MutationObserver(()=>{ if(LANG==="en" && !_i18nBusy){ _i18nBusy=true; try{ _i18nNode(document.body); } finally { _i18nBusy=false; } } })
  .observe(document.body,{childList:true,subtree:true});

const $=(s)=>document.querySelector(s);
const esc=(s)=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
let LAST_TOTAL=null;

function toast(m){const t=$("#toast");t.textContent=m;t.classList.add("show");
  clearTimeout(t._h);t._h=setTimeout(()=>t.classList.remove("show"),2600);}
function setLog(lines){ if(!Array.isArray(lines))return;
  $("#log").textContent = lines.length?lines.join("\n"):"就绪。";
  $("#log").scrollTop=$("#log").scrollHeight; }

const App={
  async boot(){
    applyLang();
    const d=await window.pywebview.api.bootstrap();
    this.render(d);
    this.startPoll();
  },
  startPoll(){
    if(this._poll) clearInterval(this._poll);
    // 每 10 秒刷新积分：顶部合计 + 每张账号卡余额原地更新（跟上反代实时消耗）
    this._poll=setInterval(async ()=>{
      try{
        const s=await window.pywebview.api.settings_state();
        const a=s&&s.auto, t=$("#autoText");
        if(a&&t){
          const stale=a.beat_at&&(Date.now()/1000-a.beat_at>150);
          t.textContent = !a.enabled ? "自动：已关闭"
            : (a.warmup_left>0 && !a.beat) ? "自动：启动中 "+a.warmup_left+"s"
            : stale ? "自动：引擎已停止（重启程序恢复）"
            : a.running ? "自动：检测中…"
            : a.busy_claim ? "自动：等手动领取结束"
            : a.switch_active ? "自动：等账号切换结束"
            : a.login_active||a.headless_active ? "自动：等登录结束"
            : a.sweep_active ? "自动：等打卡结束"
            : a.last_error ? "自动：上轮未完成，"+a.next_at+" 重试"
            : a.next_at ? "自动：下次 "+a.next_at+(a.last?"（上轮 +"+a.last.gained+"）":"")
            : "自动：待命";
          // 自动引擎跑完一轮之后，"可领"角标必须跟着变 —— 否则它已经领完/已被服务端
          // 确定拒绝，界面还挂着"2 个可领 · 600 分"，那就又是"一直显示有积分可以领"。
          const round=a.last?String(a.last.at):"";
          if(this._autoRound===undefined) this._autoRound=round;
          else if(round && round!==this._autoRound){ this._autoRound=round; this.refresh(); }
        }
      }catch(e){}
      try{
        const r=await window.pywebview.api.points_only();
        if(!r.ok) return;
        let total=0, missing=0;
        for(const a of (r.accounts||[])){
          if(typeof a.points==="number") total+=a.points;
          // 原地更新账号卡（data-uid 定位，不动任务表格）
          const card=document.querySelector(`.acct[data-uid="${CSS.escape(a.uid)}"]`);
          if(!card){ missing++; continue; }
          if(typeof a.points==="number"){
            const num=card.querySelector(".bal .num");
            if(num && num.textContent!==String(a.points)){
              num.textContent=a.points;
              const bal=card.querySelector(".bal"); if(bal){ bal.classList.remove("flash"); void bal.offsetWidth; bal.classList.add("flash"); }
            }
            const sub=card.querySelector(".walletSub");
            if(sub) sub.textContent=(a.wallets||[]).map(w=>esc(w.name)+" "+w.balance).join(" · ");
            const exp=card.querySelector(".expSub");
            if(exp) exp.textContent=(a.expiring!=null&&a.expiring>0)?`${a.expiring} 分即将过期`:"";
          }
        }
        // 合计里有号、列表里却没有卡片 = 上一次整表重绘漏了（添加新号后最容易撞上）。
        // 不补的话用户会以为号没加进去，所以这里自愈一次。
        if(missing && !this._healBusy){
          this._healBusy=true;
          this.render(await window.pywebview.api.bootstrap());
          this._healBusy=false;
        }
        const el=$("#ptsText");
        if(el && el.textContent!==String(total) && (r.accounts||[]).length){
          el.textContent=total;
          const p=$("#ptsPill"); p.classList.remove("flash"); void p.offsetWidth; p.classList.add("flash");
        }
      }catch(e){}
    }, 10000);
  },
  render(d){
    if(!d||!d.ok){ $("#accounts").innerHTML=`<div class="empty">读取失败：${esc(d&&d.error||"未知")}</div>`; return; }
    const running=d.autoclaw_running;
    $("#envPill").className="pill "+(running?"ok":"bad");
    $("#envText").textContent=running?"运行中":"未运行";
    if(d.settings){ const ta=$("#tgAuto"), ts=$("#tgSweep"), ti=$("#inviteInput");
      if(ta) ta.checked=!!d.settings.auto_claim; if(ts) ts.checked=!!d.settings.auto_sweep;
      if(ti && document.activeElement!==ti) ti.value=d.settings.invite_code||""; }
    if(d.auto){ const t=$("#autoText");
      t.textContent = d.auto.running ? "自动：检测中…" : (d.auto.next_at ? "自动：下次 "+d.auto.next_at : ""); }
    setLog(d.log);

    // 常驻积分（多账号求和）
    const totalPts=d.accounts.reduce((n,a)=>n+(typeof a.points==="number"?a.points:0),0);
    const ptsEl=$("#ptsText");
    const changed = ptsEl.textContent !== String(totalPts);
    ptsEl.textContent = d.accounts.length ? totalPts : "--";
    if(changed && totalPts>0){ const p=$("#ptsPill"); p.classList.remove("flash"); void p.offsetWidth; p.classList.add("flash"); }

    const totalCnt=d.accounts.reduce((n,a)=>n+(a.claimable_count||0),0);
    const claimPts=d.accounts.reduce((n,a)=>n+(a.claimable_points||0),0);
    const cf=d.device_conflicts||[];
    $("#acctSummary").textContent=(d.accounts.length
      ? `${d.accounts.length} 个账号 · ${totalCnt} 个任务可领 ${claimPts} 分` : "")
      + (cf.length ? ` · ⚠ ${cf.length} 组账号共用同一份设备身份（新人资格一台设备只算一次）` : "");
    // 领取是纯 HTTP，和桌面端开没开无关；只在"这一轮还在跑"时禁用
    $("#btnClaim").disabled = !!this._claiming;

    if(!d.accounts.length){
      $("#accounts").innerHTML=`<div class="empty">未发现 AutoClaw 账号<br/>
        <span class="muted">点上方「➕ 内置添加账号」用手机号注册/登录，或「导入账号」从其它目录导入</span></div>`;
      return;
    }
    $("#accounts").innerHTML=d.accounts.map(a=>`
      <div class="acct" data-uid="${esc(a.uid)}">
        <div class="top">
          <span class="nm">${esc(a.name)}</span>
          <span class="meta">uid ${esc(a.uid||"-")}${a.phone?" · "+esc(a.phone):""}</span>
          ${a.is_active?'<span class="pill ok"><span class="dot"></span>当前登录</span>':''}
          ${a.paused?`<span class="pill"><span class="dot"></span>切换中 · 暂停探测</span>`
            :a.auth_expired?`<span class="pill bad"><span class="dot"></span>凭证已失效 · 需重新登录</span>`
            :a.claimable_count?`<span class="pill warn"><span class="dot"></span>${a.claimable_count} 个可领 · ${a.claimable_points} 分</span>`
            :(a.blocked||[]).length?`<span class="pill bad" title="${esc(a.blocked.map(b=>`${b.title}：${b.reason}`).join("\n"))}"><span class="dot"></span>${a.blocked.length} 项服务端未放行</span>`
            :(a.tasks||[]).length?`<span class="pill ok"><span class="dot"></span>今日已领完</span>`
            :`<span class="pill"><span class="dot"></span>暂无任务下发</span>`}
          <span style="flex:1"></span>
          ${a.is_active?'':a.auth_expired&&a.phone
            ?`<button class="sm primary" onclick="App.relogin('${esc(a.uid)}', this)">重新登录</button>`
            :`<button class="sm" onclick="App.switchTo('${esc(a.uid)}', this)">切换到此账号</button>`}
        </div>
        <div class="chips">
          ${a.token_expires?`<span class="pill"><span class="dot"></span>凭证 ${esc(a.token_expires)} 到期</span>`:""}
          ${(a.claimable_items||[]).map(c=>{
            const lab={daily:"每日",inspiration:"灵感",inspiration_done:"灵感",newbie:"新人",promotion:"活动",
                       promo_link:"外部活动",promo_soon:"活动预告"}[c.kind]||c.kind;
            const cls={promotion:"ok",newbie:"ok",daily:"warn",inspiration:"warn"}[c.kind]||"";
            const pts=c.points?` +${c.points}分`:"";
            const win=(c.kind==="promo_link"||c.kind==="promo_soon")&&(c.start_text||c.end_text)
              ? ` <span class="muted">${esc(c.start_text||"")}~${esc(c.end_text||"")}</span>`:"";
            return `<span class="pill ${cls}"><span class="dot"></span>${lab}·${esc(c.title)}${pts}${win}</span>`;}).join("")}
          ${(a.blocked||[]).map(b=>`<span class="pill bad" title="${esc(b.reason||'')}"><span class="dot"></span>未放行·${esc(b.title)}</span>`).join("")}
          ${(a.upcoming||[]).map(u=>`<span class="pill"><span class="dot"></span>预告·${esc(u.name)} ${esc(u.start_text)}~${esc(u.end_text)}</span>`).join("")}
          ${!a.newbie_issued&&!a.auth_expired?`<span class="pill"><span class="dot"></span>新人·${esc(a.newbie_hint||"未下发")}</span>`:""}
        </div>
        <div class="row" style="margin-top:7px;align-items:baseline">
          <div class="meta">${esc(a.email||"")}</div>
          <div style="text-align:right">
            <div class="bal"><span class="num">${a.points!=null?a.points:"--"}</span><span class="unit">积分</span></div>
            <div class="meta walletSub">${a.wallets&&a.wallets.length?a.wallets.map(w=>esc(w.name)+" "+w.balance).join(" · "):""}</div>
            <div class="meta expSub" style="color:var(--amber)">${a.expiring!=null&&a.expiring>0?`${a.expiring} 分即将过期`:""}</div>
          </div>
        </div>
        <table><tr><th></th><th>任务</th><th>积分</th><th>状态</th></tr>
        ${a.tasks.map(t=>`<tr>
          <td class="star">${t.client_triggered&&t.status!=="completed"?"★":""}</td>
          <td>${esc(t.title)}</td>
          <td class="pt">+${t.points||0}</td>
          <td class="st">${esc(t.status||"-")}</td></tr>`).join("")}
        </table>
      </div>`).join("");
  },
  async switchTo(uid, btn){
    if(!confirm("切换账号会关闭并重启 AutoClaw，全程约 1 分钟（含身份回跳观察），确定继续？")) return;
    let r;
    try{ r=await window.pywebview.api.switch_to(uid); }
    catch(e){ toast("启动切换失败："+e); return; }
    if(!r.ok){ toast(r.error||"启动切换失败"); return; }
    const old = btn ? btn.textContent : "";
    if(btn){ btn.disabled=true; btn.textContent="切换中…"; }
    const timer=setInterval(async ()=>{
      let st;
      try{ st=await window.pywebview.api.switch_status(); }catch(e){ return; }
      if(st.log) setLog(st.log);
      if(st.msg && btn) btn.textContent = st.msg.slice(0,14);
      if(st.done){
        clearInterval(timer);
        if(btn){ btn.textContent=old; btn.disabled=false; }
        const res=st.result||{};
        if(res.already_active) toast("该账号本来就是当前登录账号，未做改动");
        else if(res.ok) toast("已切换到 "+res.switched_to+"（观察期身份未回跳）");
        else if(res.reverted_to) toast("⚠ 切换失败：身份回跳到 "+res.reverted_to);
        else toast("切换失败："+(res.error||"未知"));
        setTimeout(()=>this.refresh(), 1500);
      }
    }, 1200);
  },
  async refresh(){ toast("刷新中…"); this.render(await window.pywebview.api.bootstrap()); },
  async claim(){
    this._claiming=true; $("#btnClaim").disabled=true; $("#btnClaim").textContent="领取中…";
    try{
      const d=await window.pywebview.api.claim_all(true);
      setLog(d.log);
      const bad=[...(d.failed_accounts||[]), ...(d.expired_accounts||[])];
      const tail=bad.length? `（${bad.length} 个号本轮没处理成：${bad.join('、')}）`:"";
      if(d.ok) toast((d.total_points>0 ? `完成，本次 +${d.total_points} 分`
                                       : "完成：可领的都已领过（本次 +0 分)") + tail);
      else toast("失败："+(d.error||"未知"));
    } finally {
      this._claiming=false;
      $("#btnClaim").textContent="⚡ 一键领取全部积分";
      $("#btnClaim").disabled=false;
      setTimeout(()=>this.refresh(), 700);
    }
  },
  async claimActivities(){
    const btn=$("#btnActivities");
    if(btn.disabled) return;
    btn.disabled=true; const old=btn.textContent; btn.textContent="领取活动中…";
    try{
      const d=await window.pywebview.api.claim_activities();
      setLog(d.log);
      toast(d.ok?"活动/新人奖励请求已完成":"失败："+(d.error||"未知"));
    } finally {
      btn.disabled=false; btn.textContent=old;
      setTimeout(()=>this.refresh(),700);
    }
  },
  async setSetting(k, v){
    try{ await window.pywebview.api.set_setting(k, v); }catch(e){ toast("设置失败："+e); return; }
    toast(k==="auto_claim" ? (v?"自动领取已开启":"自动领取已关闭")
                           : (v?"活动打卡已开启":"活动打卡已关闭"));
    if(v) setTimeout(()=>this.refresh(), 400);
  },
  async sweep(){
    let r; try{ r=await window.pywebview.api.activity_sweep(); }catch(e){ toast("打卡失败："+e); return; }
    if(!r.ok){ toast(r.error||"无法开始打卡"); return; }
    toast("活动打卡开始：将逐号拉起登录窗口（每号约 80 秒，不影响当前登录）");
    const timer=setInterval(async ()=>{
      let st; try{ st=await window.pywebview.api.sweep_status(); }catch(e){ return; }
      if(st.log) setLog(st.log);
      if(st.sweep && st.sweep.done){
        clearInterval(timer);
        toast(st.sweep.msg||"打卡完成");
        setTimeout(()=>this.refresh(), 600);
      }
    }, 2000);
  },
  async inviteSave(){
    const d=await window.pywebview.api.save_invite($("#inviteInput").value);
    toast(d.ok?("邀请码已保存："+d.code):(d.error||"保存失败"));
  },
  async inviteFetch(){
    const d=await window.pywebview.api.invite_fetch();
    if(d.ok){ $("#inviteInput").value=d.code; toast(`已取到 ${d.name} 的邀请码：${d.code}`); }
    else toast(d.error||"取码失败");
  },
  async inviteBindAll(){
    toast("开始补绑…");
    const d=await window.pywebview.api.invite_bind_all();
    setLog(d.log); this.refresh();
  },
  async inviteCheck(btn){
    if(btn) btn.disabled=true;
    try{
      const d=await window.pywebview.api.invite_check();
      if(!d.ok){ toast(d.error||"复核失败"); return; }
      const got=(d.rows||[]).filter(r=>(r.inviter_reward_total||0)>0);
      toast(got.length?`已计奖：${got.map(r=>`${r.name} ${r.inviter_reward_total}分`).join("、")}`
                      :"暂无计奖（好友号要真实使用后才结算，可稍后再复核）");
      setLog(d.log);
    }finally{ if(btn) btn.disabled=false; }
  },
  async launchAc(){ const d=await window.pywebview.api.launch_autoclaw();
    toast(d.ok?"已启动 AutoClaw":"启动失败："+(d.error||"")); setTimeout(()=>this.refresh(),2500); },
  async relay(){
    const d=await window.pywebview.api.relay_status();
    if(d.ok){ toast(d.upstream==="cloud" ? "反代正常 · 云端直连，不用开桌面端"
                                        : "反代正常 · broker 已连接"); return; }
    if(!confirm("反代当前不可用，重新部署并启动？")) return;
    const r=await window.pywebview.api.restart_relay();
    toast(r.ok?"反代已重启":"重启失败："+(r.error||""));
  },
  async relaySetup(){
    if(!confirm("一键反代：部署本地反代 + 把 AutoClaw 注册进 ZCode（幂等，可重复点）。继续？")) return;
    const r=await window.pywebview.api.relay_setup();
    if(r.ok) toast("进行中，看操作日志");
  },
  async relayWarm(){
    if(!confirm("对新号跑 8 轮真实对话建立用量基线（防止被判机器号）。继续？")) return;
    const r=await window.pywebview.api.relay_warm();
    if(r.ok) toast("暖号进行中，看操作日志");
  },
  async loginAdd(){
    const btn = $("#btnLoginAdd");
    if(!btn || btn.disabled) return;
    // 加号会让位（=关闭）桌面端：点下去之前先新鲜检测一次，在跑就弹确认
    try{
      const ac=await window.pywebview.api.ac_running();
      if(ac && ac.ok && ac.running &&
         !confirm(LANG==="en"
           ? "AutoClaw is running. Continuing will close the desktop app (tray included); it restarts automatically after login. Don't reopen it manually meanwhile. Continue?"
           : "检测到 AutoClaw 正在运行。继续添加会先关闭桌面端（含托盘），登录完成后会自动重启，期间请勿手动打开 AutoClaw。确定继续？")) return;
    }catch(e){}
    let r;
    try{ r=await window.pywebview.api.login_add(); }
    catch(e){ toast("启动登录失败："+e); return; }
    if(!r.ok){ toast(r.error||"启动登录失败"); return; }
    const old=btn.textContent;
    btn.disabled=true; btn.textContent="等待登录中…";
    toast("桌面端先让位，登录完会自动重启并校验算力");
    const timer=setInterval(async ()=>{
      let st;
      try{ st=await window.pywebview.api.login_status(); }catch(e){ return; }
      if(st.log) setLog(st.log);
      if(st.done){
        clearInterval(timer);
        btn.disabled=false; btn.textContent=old;
        const res=st.result||{};
        toast(res.ok?("已添加账号 "+(res.name||res.uid)):("添加失败："+(res.error||"未知"))
              +(res.yield_note?("　|　"+res.yield_note):""));
        setTimeout(()=>this.refresh(), 600);
      } else if(st.msg){
        toast(st.msg);
      }
    }, 1500);
  },
  openAdd(){
    $("#addPanel").style.display="flex"; $("#addHint").style.display="flex";
    $("#phoneInput").disabled=false;
    if(!$("#addHintText").textContent) this.setHint(
      "填手机号 → 发送验证码 → 登录并入档，全程不开桌面端。");
    $("#phoneInput").focus();
  },
  closeAdd(){
    $("#addPanel").style.display="none"; $("#addHint").style.display="none";
    $("#phoneInput").disabled=false; $("#btnFinishAdd").disabled=true;
    $("#codeInput").value=""; this.setHint("");
  },
  setHint(t){ $("#addHintText").textContent=t; },
  armCode(){ $("#codeInput").disabled=false; $("#btnFinishAdd").disabled=false; $("#codeInput").focus(); },
  async sendCode(){
    const phone=($("#phoneInput").value||"").replace(/\D/g,"");
    if(!/^1[3-9]\d{9}$/.test(phone)){ toast("手机号得是 11 位中国大陆号码"); return; }
    const b=$("#btnSendCode"); if(b.disabled) return;
    b.disabled=true; b.textContent="发送中…";
    let r;
    try{ r=await window.pywebview.api.send_login_code(phone); }
    catch(e){ b.disabled=false; b.textContent="发送验证码"; toast("发送失败："+e); return; }
    if(!r.ok){ b.disabled=false; b.textContent="发送验证码";
      this.setHint("✗ "+(r.error||"发送失败")); toast(r.error||"发送失败"); return; }
    this.armCode();
    this.setHint(`✓ 验证码已发往 ${r.phone} · 设备身份 ${r.device_id}`
      +`${r.reused_identity?"（沿用已有身份 → 老号重新登录）":"（新铸身份 → 全新账号）"}`
      +` · ${Math.round((r.expires_in||300)/60)} 分钟内有效`);
    toast("验证码已发送");
    let left=60; b.textContent=`${left}s 后可重发`;
    const t=setInterval(()=>{ left-=1;
      if(left<=0){ clearInterval(t); b.disabled=false; b.textContent="发送验证码"; }
      else b.textContent=`${left}s 后可重发`; },1000);
  },
  async finishAdd(){
    const code=($("#codeInput").value||"").replace(/\D/g,"");
    if(!/^\d{6}$/.test(code)){ toast("验证码是 6 位数字"); return; }
    let r;
    try{ r=await window.pywebview.api.headless_add(($("#phoneInput").value||"").replace(/\D/g,""),code); }
    catch(e){ toast("提交失败："+e); return; }
    if(!r.ok){ this.setHint("✗ "+(r.error||"提交失败")); toast(r.error||"提交失败"); return; }
    $("#btnFinishAdd").disabled=true; this.setHint("正在校验验证码并入档…");
    const timer=setInterval(async ()=>{
      let st; try{ st=await window.pywebview.api.headless_status(); }catch(e){ return; }
      if(st.log) setLog(st.log);
      if(!st.done){ if(st.msg) this.setHint(st.msg); return; }
      clearInterval(timer);
      this.afterAdd(st.result||{});
    }, 1200);
  },
  afterAdd(res){
    if(res.ok){
      const ib=res.invite_bound;
      let bind="";
      if(ib){
        bind = ib.bound ? " · 邀请码已绑定"
                        : ` · 邀请码未绑上(${esc(String(ib.msg||ib.bind_status||ib.server_code||"").slice(0,28))})`;
        if(ib.inviter) bind += (ib.baseline_ok
            ? ` · ${esc(ib.inviter)} 现邀请数 ${(ib.after||{}).invited_count}`
              + `、奖励 ${(ib.after||{}).inviter_reward_total}（要本号真实使用后才结算，稍后点「复核奖励」）`
            : ` · ${esc(ib.inviter)} 奖励计数未读到，点「复核奖励」再看`);
      }
      const dg=res.diagnosis||{};
      this.setHint(`✓ ${res.new_account?"新号已注册":"老号已重新登录"} ${res.nickname}`
        +` · token 归属 jwt_uid=${res.jwt_uid} · 设备 ${res.device_id}${bind}`
        +(dg.verdict?` · ${esc(dg.verdict)}`:""));
      toast("已入档 "+res.nickname+"，开始领取积分");
      this.closeAdd(); $("#phoneInput").value="";
      setTimeout(()=>this.claim(), 400);
    }else{
      $("#btnFinishAdd").disabled=false;
      this.setHint("✗ "+(res.error||"入档失败"));
      toast("失败："+(res.error||"未知"));
    }
    setTimeout(()=>this.refresh(), 500);
  },
  async relogin(uid, btn){
    if(btn){ btn.disabled=true; btn.textContent="发码中…"; }
    let r;
    try{ r=await window.pywebview.api.relogin_send(uid); }
    catch(e){ toast("发送失败："+e); if(btn){ btn.disabled=false; btn.textContent="重新登录"; } return; }
    if(btn){ btn.disabled=false; btn.textContent="重新登录"; }
    if(!r.ok){ toast(r.error||"发送失败"); return; }
    $("#addPanel").style.display="flex"; $("#addHint").style.display="flex";
    $("#phoneInput").value=""; $("#phoneInput").disabled=true;
    this.armCode();
    this.setHint(`✓ 验证码已发往 ${r.phone}（沿用该号自己的设备身份）· 填码后即恢复这号的登录态`);
    toast("已发码到 "+r.phone);
  },
  async addAcct(){
    const p=await window.pywebview.api.pick_dir();
    if(!p.ok){ if(p.error&&p.error!=="未选择") toast(p.error); return; }
    const d=await window.pywebview.api.add_account(p.dir);
    toast(d.ok?"账号已导入":"导入失败："+(d.error||"")); this.refresh();
  },
  async exportAccts(){ const d=await window.pywebview.api.export_accounts();
    toast(d.ok?("已导出到 "+d.dir):("导出失败："+(d.error||""))); },
};
window.addEventListener("pywebviewready", ()=>App.boot());
</script></body></html>
"""


def main():
    import webview
    api = Api()
    log(f"{APP_TITLE} 启动")
    threading.Thread(target=_auto_claim_loop, daemon=True).start()
    webview.create_window(
        APP_TITLE, html=INDEX_HTML, js_api=api,
        width=WINDOW_W, height=WINDOW_H, min_size=(560, 640),
        background_color="#0a0a0c", text_select=True,
    )
    webview.start()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        log("致命错误:\n" + traceback.format_exc())
        raise
