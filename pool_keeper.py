"""A-SWITCH 池看护（无头）—— 补上 GUI 关着的空窗。

根因：A-SWITCH 是 GUI 工具，开着时每 20s 刷 aswitch_cloud_pool.json；一关，
池文件 2h 后过端点的陈旧闸（POOL_STALE_MS=7200s，按 mtime 判），端点把 9 个号
全丢掉 → 退化成单凭证 → 满血 GLM-5.3 秒空、池号被 pile-on 打封。

本看护：常驻循环，每 60 分钟（远低于 2h 闸、低自动化指纹）跑一次
`a_switch.py pool` 刷新池文件。GUI 在跑时跳过（GUI 自己每 20s 刷，且并行
刷同批号会互相把 refreshToken 轮换打旧 = 真封号雷）。

由 aswitch-pool-watchdog.vbs 拉起并保活（零窗口）。
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
POOL_FILE = r"C:\Users\30369\.openclaw-autoclaw\aswitch_cloud_pool.json"
BANLIST_FILE = r"C:\Users\30369\.openclaw-autoclaw\aswitch_pool_banned.json"
ENDPOINT_STATE = r"D:\.openclaw-autoclaw\workspace\autoclaw-model-endpoint\pool_state.json"
LOG = os.path.join(HERE, "pool_keeper.log")
PYTHON = sys.executable  # the pythonw that launched us
A_SWITCH = os.path.join(HERE, "a_switch.py")
CYCLE_S = 3600            # 60 min refresh cadence (gate is 7200s)
GUI_EXE = "A-SWITCH.exe"


def log(msg):
    line = "[%s] %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg)
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def gui_running():
    try:
        out = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq %s" % GUI_EXE],
            capture_output=True, text=True, timeout=15).stdout
        return GUI_EXE.lower() in out.lower()
    except Exception:
        return False


def sync_bans():
    """把端点已确认封禁(410004)的号同步进池子黑名单。

    端点封号只写它自己的 pool_state.json（byUid[uid].kind=='banned'），
    不写 aswitch_pool_banned.json；而 a_switch.py pool 导出时读的正是黑名单
    文件。不同步 → keeper 每轮把端点刚封的号重新导出 → 端点再封 → 死循环，
    等于 keeper 在帮倒忙反复复活死号。
    """
    try:
        st = json.load(open(ENDPOINT_STATE, encoding="utf-8"))
    except Exception:
        return 0
    banned_now = {str(u) for u, v in (st.get("byUid") or {}).items()
                  if isinstance(v, dict) and v.get("kind") == "banned"}
    if not banned_now:
        return 0
    try:
        data = json.load(open(BANLIST_FILE, encoding="utf-8"))
    except Exception:
        data = {"banned": []}
    cur = [str(x).strip() for x in (data.get("banned") or []) if str(x).strip()]
    curset = set(cur)
    added = [u for u in banned_now if u not in curset]
    if not added:
        return 0
    cur.extend(added)
    data["banned"] = cur
    data["at"] = int(time.time())
    tmp = BANLIST_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, BANLIST_FILE)
    log("sync_bans: +%d → %s" % (len(added), ",".join(u[:8] for u in added)))
    return len(added)


def migrate_warm_states():
    """给存量号补标 warmed=true —— 但只标**确实有过真实推理**的号。

    无差别补标是缺陷：新导入的号推理流水为 0，补标等于放它进池白撞 406/被探针烧。
    判据用服务端流水（不可被本地改写），不用本地标记。
    """
    try:
        sys.path.insert(0, HERE)
        import a_switch as A
        marked = 0
        for acc in A.discover_accounts():
            ad = getattr(acc, "appdata_dir", None)
            if not ad:
                continue
            wf = Path(ad) / A.WARM_STATE_FILE
            if wf.is_file():
                continue
            # 只认"打过真实推理"的号：拉最近流水，有 model usage 记录才算存量活号
            try:
                n = A.real_inference_count(acc)
            except Exception:
                n = -1
            if n and n > 0:
                try:
                    wf.parent.mkdir(parents=True, exist_ok=True)
                    wf.write_text(json.dumps({"warmed": True, "warmed_at": int(time.time()),
                                              "human_shape_ratio": 1.0, "migrated": True,
                                              "inference_count": n},
                                             ensure_ascii=False, indent=1), encoding="utf-8")
                    marked += 1
                    log("migrate_warm: %s 有 %d 条真实推理 → 补标 warmed=true" % (str(acc.user_id)[:8], n))
                except Exception as e:
                    log("migrate_warm %s 失败: %s" % (str(acc.user_id)[:8], e))
            else:
                log("migrate_warm: %s 零推理流水，保持未暖（交给探针放行后暖号）" % str(acc.user_id)[:8])
        return marked
    except Exception as e:
        log("migrate_warm err: %s" % e)
        return 0


def pool_age_s():
    try:
        return time.time() - os.path.getmtime(POOL_FILE)
    except Exception:
        return 1e9


def refresh_tokens_once():
    """Run `a_switch.py refresh-tokens` (24h token renewal). Never raise."""
    try:
        p = subprocess.run(
            [PYTHON, A_SWITCH, "refresh-tokens"],
            capture_output=True, text=True, timeout=300, cwd=HERE)
        tail = (p.stdout or "").strip().splitlines()
        msg = tail[-1] if tail else (p.stderr or "").strip()[:120]
        return p.returncode, msg
    except Exception as e:
        return -1, "%s: %s" % (type(e).__name__, str(e)[:120])


def refresh_once():
    """Run a_switch.py pool; never raise."""
    try:
        p = subprocess.run(
            [PYTHON, A_SWITCH, "pool"],
            capture_output=True, text=True, timeout=180, cwd=HERE)
        tail = (p.stdout or "").strip().splitlines()
        msg = tail[-1] if tail else (p.stderr or "").strip()[:120]
        return p.returncode, msg
    except Exception as e:
        return -1, "%s: %s" % (type(e).__name__, str(e)[:120])


def main():
    log("keeper start (pid=%d) cycle=%ds gate=7200s" % (os.getpid(), CYCLE_S))
    while True:
        try:
            if gui_running():
                pass  # GUI owns the refresh; stay silent to avoid log spam
            else:
                # Sync endpoint-confirmed bans into the banlist FIRST, so the
                # pool export below drops freshly-banned accounts instead of
                # resurrecting them (keeper was re-exporting accounts the
                # endpoint had just 410004-banned → ban/revive loop).
                sync_bans()
                migrate_warm_states()   # 一次性补标存量活号 warmed=true（幂等）
                # token 续期：access token 约 24h 过期，过期号在池里就是死的
                # （推理 401、流水查不到 → 被暖号逻辑误判成冷号）。每轮先续期
                # 再导出池子，保证写进池的凭证都是活的。
                rc_t, msg_t = refresh_tokens_once()
                log("tokens rc=%d | %s" % (rc_t, msg_t))
                age = pool_age_s()
                # Refresh if file older than 30min (well under 7200s gate).
                # A keeper restart sees a stale file and heals on the first pass.
                if age > 1800:
                    rc, msg = refresh_once()
                    log("pool rc=%d age=%.0fs | %s" % (rc, age, msg))
                else:
                    log("skip: pool fresh age=%.0fs" % age)
        except Exception as e:
            log("loop err %s: %s" % (type(e).__name__, str(e)[:120]))
        time.sleep(CYCLE_S)


if __name__ == "__main__":
    main()
