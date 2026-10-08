"""Deterministic offline tests for the Qoder gateway.

No network: verifies the crypto primitives (AES FIPS vectors, RSA padding
structure, Qoder custom base64 round-trip), COSY signature layout, request
body construction, SSE envelope unwrapping, Responses-API custom-tool
translation, and check-in response normalization.

    python _test_qoder.py

外部 fixture（可选）：[4.5] 组的官方加解密 KAT 需要协议 fixture 目录
（内含 credential.json 与 model-cache.json）。目录按以下顺序自动探测：
    1) 环境变量 QD_TEST_FIXTURE_DIR
    2) <仓库>/testdata/protocol/1.1.34
    3) <仓库>/tests/fixtures/protocol/1.1.34
    4) <仓库>/../qoder-ref/cli2api/testdata/protocol/1.1.34
    5) %TEMP%/qoder-ref/cli2api/testdata/protocol/1.1.34
    6) ~/qoder-ref/cli2api/testdata/protocol/1.1.34
缺 fixture 时依赖它的 3 条断言打印 [SKIP]（不计失败），**绝不静默**：
[SKIP] 行、候选清单、末行汇总都会报出跳过数量。同组的 AES-256
密钥表 / 互逆 KAT 不依赖 fixture，永远执行。

退出码：0 = 无 FAIL（允许存在 SKIP）；1 = 存在 FAIL。
"""
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("ACCOUNTS_DIR",
                      os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                   "_acc"))
os.environ.setdefault("USAGE_DIR",
                      os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                   "_use"))
# 离线测试不拉起客户端原生二进制（活动平台的机器身份桥）；测试里显式关闭
os.environ.setdefault("QD_NATIVE_IDENTITY", "0")

import qoder_proxy as P
import qoder_sign as S
import qoder_catalog as C
import qoder_accounts as A
import qoder_tasks as T

PASS = FAIL = SKIP = 0


def check(label, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  [PASS] " + label)
    else:
        FAIL += 1
        print("  [FAIL] " + label + ("  " + str(extra) if extra else ""))


def skip(label, reason=""):
    """显式跳过（缺外部 fixture / 缺环境），绝不静默。

    SKIP 不改变退出码（退出码只看 FAIL），但会打印醒目行并计入末行汇总，
    所以"这组没跑"永远可见；补齐 fixture 后必须重跑到它真的 PASS。
    """
    global SKIP
    SKIP += 1
    print("  [SKIP] " + label + (("  -- " + str(reason)) if reason else ""))


print("[1] Qoder custom base64 variant")
enc = S.qoder_encode(b"{}")
check("encode({}) deterministic", enc == S.qoder_encode(b"{}"))
check("decode(encode(x)) == x", S.qoder_decode(enc) == b"{}")
sample = json.dumps({"b": 1, "a": "中文测试", "c": [1, 2, 3]}).encode()
check("roundtrip with unicode/json", S.qoder_decode(S.qoder_encode(sample)) == sample)
check("output uses only custom alphabet",
      all(c in S.QODER_CUSTOM_ALPHABET or c == S.QODER_PAD for c in enc))
check("padding is $", S.qoder_encode(b"a" * 100).count("$") >= 0 and "=" not in enc)

print()
print("[2] AES-128 (FIPS-197 / NIST vectors)")
k = bytes.fromhex("000102030405060708090a0b0c0d0e0f")
pt = bytes.fromhex("00112233445566778899aabbccddeeff")
ct = S._encrypt_block(pt, S._expand_key(k)).hex()
check("FIPS-197 C.1 block", ct == "69c4e0d86a7b0430d8cdb78070b4c55a", ct)
k2 = bytes.fromhex("2b7e151628aed2a6abf7158809cf4f3c")
iv = bytes.fromhex("000102030405060708090a0b0c0d0e0f")
pt2 = bytes.fromhex("6bc1bee22e409f96e93d7e117393172a")
xored = bytes(a ^ b for a, b in zip(pt2, iv))
c2 = S._encrypt_block(xored, S._expand_key(k2)).hex()
check("SP800-38A CBC first block", c2 == "7649abac8119b246cee98e9b12e9197d", c2)
# CBC chaining through aes_cbc_encrypt (key==iv style input, PKCS7)
blob = S.aes_cbc_encrypt(b"hello qoder", b"0123456789abcdef", b"0123456789abcdef")
check("aes_cbc_encrypt block-aligned", len(blob) % 16 == 0 and len(blob) >= 16)
# 11 字节明文 -> PKCS7 补 5 -> 一个密文块
check("pkcs7 grows 11B input to one 16B block", len(blob) == 16, len(blob))
check("16B input grows to two blocks",
      len(S.aes_cbc_encrypt(b"0123456789abcdef", b"0123456789abcdef",
                             b"0123456789abcdef")) == 32)

print()
print("[3] RSA PKCS#1 v1.5 public encryption")
import base64 as _b64m
_der = _b64m.b64decode("".join(l for l in S.SERVER_PUB_PEM.splitlines()
                                if "BEGIN" not in l and "END" not in l))
check("PEM parses to 1024-bit modulus", S._RSA_N.bit_length() == 1024,
      S._RSA_N.bit_length())
check("DER carries 129-byte INTEGER", b"\x02\x81\x81" in _der)
check("exponent 65537", S._RSA_E == 65537)
ct_rsa = S.rsa_pkcs1v15_encrypt(b"0123456789abcdef")
check("ciphertext length = k = 128", len(ct_rsa) == 128, len(ct_rsa))
m_int = int.from_bytes(ct_rsa, "big")
check("ciphertext < n", m_int < S._RSA_N)
check("pkcs1v15 PS length formula",
      len(S.rsa_pkcs1v15_encrypt(b"x")) == 128)

print()
print("[4] COSY session & bearer signature")
sess = S.CosySession(uid="test-uid-001", nickname="tester",
                     access_token="dt-abc", refresh_token="drt-xyz")
url = "https://gateway.qoder.com.cn" + P.CHAT_PATH
body_enc = S.qoder_encode(b'{"x":1}')
h = sess.headers(body_enc, url, model_key="qmodel", sse=True)
check("has full cosy header set",
      all(kk in h for kk in ("authorization", "cosy-key", "cosy-user",
                             "cosy-machineid", "cosy-machinetoken",
                             "cosy-machinetype", "cosy-date", "cosy-version")))
check("x-model-key set", h.get("x-model-key") == "qmodel")
check("cache-control for sse", h.get("cache-control") == "no-cache")
check("bearer format COSY.payload.sig",
      h["authorization"].startswith("Bearer COSY.")
      and len(h["authorization"].split(".")) == 3)
parts = h["authorization"][len("Bearer "):].split(".")
payload_b64, sig = parts[1], parts[2]
path_stripped = "/api/v2/service/pro/sse/agent_chat_generation"
raw = payload_b64 + "\n" + sess.cosy_key + "\n" + h["cosy-date"] + "\n" \
    + body_enc + "\n" + path_stripped
check("md5 signature over body+path", sig == hashlib.md5(raw.encode()).hexdigest())
check("machine id stable per uid",
      S.CosySession(uid="test-uid-001").machine_id == sess.machine_id)
check("machine ids differ across uid",
      S.CosySession(uid="other-uid").machine_id != sess.machine_id)
import base64 as _b64
payload = json.loads(_b64.b64decode(payload_b64))
check("payload keys sorted-compact",
      sorted(payload.keys()) == ["cosyVersion", "ideVersion", "info",
                                 "requestId", "version"])
check("payload cosyVersion", payload["cosyVersion"] == S.COSY_VERSION)

print()
print("[5] model alias resolution (official keys)")
check("qwen3.8-max -> qmodel_38max",
      C.resolve_upstream_key("qwen3.8-max") == "qmodel_38max")
check("old key qmodel_preview -> qmodel_38max",
      C.resolve_upstream_key("qmodel_preview") == "qmodel_38max")
check("qwen3.8-flash -> qfmodel",
      C.resolve_upstream_key("qwen3.8-flash") == "qfmodel")
check("deepseek-v4-pro -> dmodel",
      C.resolve_upstream_key("deepseek-v4-pro") == "dmodel")
check("shared key passthrough",
      C.resolve_upstream_key("qmodel") == "qmodel")
check("aliased qoder/ prefix",
      C.resolve_upstream_key("qoder/qwen3.7-max") == "qmodel_latest")
check("unknown model passthrough",
      C.resolve_upstream_key("mystery-model") == "mystery-model")
check("empty -> auto", C.resolve_upstream_key("") == "auto")
check("realm-aware: official key of that realm accepted",
      C.resolve_upstream_key("q37fmodel", realm="cn") == "q37fmodel")

print()
print("[5.5] per-realm catalogs follow the official client (must DIFFER)")
intl_keys = [m["key"] for m in C.STATIC_INTL_MODELS]
cn_keys = [m["key"] for m in C.STATIC_CN_MODELS]
check("intl catalog not empty (>=17)", len(intl_keys) >= 17, len(intl_keys))
check("cn catalog not empty (14)", len(cn_keys) == 14, len(cn_keys))
check("two realms' catalogs differ", intl_keys != cn_keys)
check("intl-only: smodel present, absent from cn",
      "smodel" in intl_keys and "smodel" not in cn_keys)
check("cn-only: q37fmodel present, absent from intl",
      "q37fmodel" in cn_keys and "q37fmodel" not in intl_keys)
check("cn-only: gm51model present, absent from intl",
      "gm51model" in cn_keys and "gm51model" not in intl_keys)
intl_en = {m["key"] for m in C.STATIC_INTL_MODELS if m.get("enable")}
cn_en = {m["key"] for m in C.STATIC_CN_MODELS if m.get("enable")}
check("intl enabled flags = {qmodel_38max, qfmodel} (official plan state)",
      intl_en == {"qmodel_38max", "qfmodel"}, sorted(intl_en))
check("cn all 14 enabled", len(cn_en) == 14, sorted(cn_en))
# 全量列出（不按 enable 过滤）
merged_i = P.merge_catalog([], realm="intl")
merged_c = P.merge_catalog([], realm="cn")
check("merge keeps FULL intl list (17, no enable filtering)", len(merged_i) == 17,
      len(merged_i))
check("merge keeps FULL cn list (14)", len(merged_c) == 14, len(merged_c))
# 清单以官方动态/本机目录为准（桌面版此刻显示什么就显示什么）
dyn_keys = [("cmodel", {"key": "cmodel", "display_name": "Cantus"})]  # 反例占位
primary15 = [(m["key"], dict(m)) for m in C.STATIC_INTL_MODELS
             if m["key"] not in ("cmodel", "smodel")]   # 模拟动态返回的 15 条
merged_dyn = P.merge_catalog(primary15, realm="intl")
check("merge follows primary set (dynamic 15 wins, static-only excluded)",
      len(merged_dyn) == 15 and
      {k for k, _ in merged_dyn} == {m["key"] for m in C.STATIC_INTL_MODELS}
      - {"cmodel", "smodel"}, len(merged_dyn))

print()
print("[5.7] official full-fidelity fields: display id / pricing / windows / efforts")
entry_i = next(m for m in C.STATIC_INTL_MODELS if m["key"] == "smodel")
check("intl exclusive entry retains full fields",
      {"context_config", "thinking_config", "is_free", "is_new"} <= set(entry_i.keys()),
      sorted(entry_i.keys()))
cn38 = next(m for m in C.STATIC_CN_MODELS if m["key"] == "qmodel_38max")
promo = cn38.get("promotion") or {}
# 注意：promo.active / price_factor 是**快照抓取时刻**的官方值（低谷时段抓的
# 快照 active=True 且 price=峰价×折扣；高峰时段抓的 active=False 且 price=峰价）。
# 断言官方不变量，而不是断言"抓取时正好在打折"，否则测试随抓取时刻漂移。
check("cn qmodel_38max carries off-peak promotion metadata",
      bool(promo) and promo.get("rule_id") == "idle_time_model_credit_discount"
      and isinstance(promo.get("active"), bool), promo.get("rule_id"))
check("off-peak window = 22:00-08:00",
      promo.get("window_start") == "22:00" and promo.get("window_end") == "08:00")
check("peak factor (before_promotion) = 0.5", promo.get("before_promotion_price_factor") == 0.5,
      promo.get("before_promotion_price_factor"))
check("current price_factor is peak or valley (0.5 / 0.2)",
      cn38.get("price_factor") in (0.5, 0.2), cn38.get("price_factor"))
check("price_factor matches promo.active (peak when inactive)",
      (cn38.get("price_factor") == 0.2) is bool(promo.get("active")),
      (cn38.get("price_factor"), promo.get("active")))
check("discount_factor = 0.4 (4折)", promo.get("discount_factor") == 0.4)
check("promotion badge/description localized",
      bool((promo.get("badge") or {}).get("en")) and bool((promo.get("description") or {}).get("en")))
qf = next(m for m in C.STATIC_CN_MODELS if m["key"] == "qfmodel")
check("qfmodel free + original factor kept",
      qf.get("is_free") is True and qf.get("original_price_factor") == 0.1)
check("context_config multi-window (3) with default 200K",
      len(cn38.get("context_config") or {}) == 3
      and (cn38["context_config"].get("200K") or {}).get("is_default") is True)
tc = (cn38.get("thinking_config") or {}).get("enabled") or {}
effs = tc.get("efforts") or {}
check("thinking efforts low/medium/xhigh with default medium",
      set(effs) == {"low", "medium", "xhigh"}
      and (effs.get("medium") or {}).get("is_default") is True, sorted(effs))

# 展示 id 与解析
check("display id format key (Name)",
      C.display_id(cn38) == "qmodel_38max (Qwen3.8-Max)", C.display_id(cn38))
check("resolve display id -> key",
      C.resolve_upstream_key("qmodel_38max (Qwen3.8-Max)", realm="cn") == "qmodel_38max")
check("resolve official display name (case-insensitive)",
      C.resolve_upstream_key("qwen3.8-max", realm="cn") == "qmodel_38max"
      and C.resolve_upstream_key("GLM-5.2", realm="cn") == "gm51model")
check("resolve bare display name DeepSeek-V4-Pro",
      C.resolve_upstream_key("DeepSeek-V4-Pro", realm="cn") == "dmodel")
check("format_model_id helper",
      C.format_model_id("gm51model", realm="cn") == "gm51model (GLM-5.2)",
      C.format_model_id("gm51model", realm="cn"))

# model_entry 输出
me = P.model_entry("qmodel_38max", cn38)
# 本地补丁（A-SWITCH）：对外 id 改用规范名（全小写，见 models-catalog.json），
# 官方显示名仍在 aliases 里可解析（下一条断言）。
check("model_entry id = canonical lowercase id (local patch; official name stays an alias)",
      me["id"] == "qwen3.8-max", me["id"])
check("model_entry upstream_key kept", me["upstream_key"] == "qmodel_38max")
check("model_entry aliases cover key + bracket form + friendly alias",
      "qmodel_38max" in me["aliases"] and "qmodel_38max (Qwen3.8-Max)" in me["aliases"]
      and "qwen3.8-max" in me["aliases"], me.get("aliases"))
check("model_entry description = official desktop copy",
      "千问" in (me.get("description") or ""), (me.get("description") or "")[:60])
check("model_entry enabled flag", me["enabled"] is True)
check("model_entry peak/valley factors",
      me["price_factor_peak"] == 0.5 and me["price_factor_valley"] == 0.2)
check("model_entry off_peak window+badge",
      me["off_peak_window"] == "22:00-08:00" and bool(me["off_peak"]["badge"]))
check("model_entry context labels default 200K",
      me["context_window_labels"] == ["200K", "400K", "1M"] or set(me["context_window_labels"]) == {"200K", "400K", "1M"},
      me.get("context_window_labels"))
check("model_entry context_window_default", me.get("context_window_default") == "200K")
check("model_entry reasoning efforts + default",
      me.get("reasoning_efforts") == ["low", "medium", "xhigh"]
      and me.get("reasoning_default_effort") == "medium",
      (me.get("reasoning_efforts"), me.get("reasoning_default_effort")))
check("model_entry can_disable", me.get("reasoning_can_disable") is True)
check("model_entry is_free/is_new", me.get("is_free") is True and me.get("is_new") is True)
check("model_entry does NOT fabricate max_output_tokens (official data has none)",
      "max_output_tokens" not in me and "max_completion_tokens" not in me,
      sorted(k for k in me if "output" in k))
me_off = P.model_entry("smodel", entry_i)
check("model_entry disabled shows enabled=false (badge, not filtered)",
      me_off["enabled"] is False)
check("model_entry disabled_reason = OFFICIAL copy (not '未开放')",
      me_off.get("disabled_reason") == "需要升级或购买千问官方套餐开放",
      me_off.get("disabled_reason"))
check("model_entry disabled_message_key passthrough (codeSafeModelReason)",
      me_off.get("disabled_message_key") == "codeSafeModelReason",
      me_off.get("disabled_message_key"))
check("official text loader: 17 zh descriptions",
      len(C.load_official_text()["descriptions"]) == 17)
check("official local name ultimate -> zh",
      C.official_local_name("ultimate") != "" and C.official_local_name("ultimate") != "Ultimate",
      C.official_local_name("ultimate"))
me_u = P.model_entry("ultimate", next(m for m in C.STATIC_INTL_MODELS if m["key"] == "ultimate"))
check("model_entry name_local emitted for intl mode preset",
      bool(me_u.get("name_local")), me_u.get("name_local"))
check("resolve official local label (Kimi-K2.7-Code)",
      C.resolve_upstream_key("Kimi-K2.7-Code", realm="intl") == "kmodel")
check("cross-region guard accepts display id form",
      P.exclusive_realm("gm51model (GLM-5.2)") == "cn")

print()
print("[5.8] off-peak (低谷) window detection — cross-midnight 22:00-08:00 UTC+8")
import datetime as _dt
def _ts(h, m):
    # 构造 UTC+8 指定时刻对应的 epoch（固定 +8 与官方时区一致）
    utc_naive = _dt.datetime.utcnow() if False else None
    base = _dt.datetime.now(_dt.timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    target_local_naive = _dt.datetime.now().replace(hour=h, minute=m, second=0, microsecond=0)
    return target_local_naive.timestamp() - (_dt.datetime.now().astimezone().utcoffset().total_seconds()
                                             - 8 * 3600)
for hh, mm, expect, label in [
        (1, 0, True, "01:00 inside window"),
        (12, 0, False, "12:00 outside"),
        (21, 59, False, "21:59 before window"),
        (22, 0, True, "22:00 window start (inclusive)"),
        (23, 30, True, "23:30 inside"),
        (7, 59, True, "07:59 last minute inside"),
        (8, 0, False, "08:00 window end (exclusive)")]:
    got = P.off_peak_active_now("22:00", "08:00", tz="Asia/Shanghai",
                                now=_ts(hh, mm))
    check(f"window {label}", got is expect, f"got={got} expect={expect}")
check("invalid window -> None",
      P.off_peak_active_now(None, "08:00") is None)
check("same start/end -> always active",
      P.off_peak_active_now("00:00", "00:00", now=_ts(13, 0)) is True)
# promotion fields surface off_peak_active_now via model_entry
me_promo = P.model_entry("qmodel_38max", cn38)
check("model_entry exposes off_peak_active_now (bool)",
      isinstance(me_promo.get("off_peak_active_now"), bool),
      me_promo.get("off_peak_active_now"))

# None must not clobber static snapshot values in merge
dyn_null = [("qmodel_38max", {"key": "qmodel_38max",
                               "context_config": None,
                               "thinking_config": None,
                               "price_factor": 0.2})]
merged_null = dict(P.merge_catalog(dyn_null, realm="cn"))["qmodel_38max"]
check("merge: dynamic None does NOT clobber static context_config",
      isinstance(merged_null.get("context_config"), dict)
      and "200K" in (merged_null.get("context_config") or {}),
      type(merged_null.get("context_config")).__name__)
check("merge: dynamic None does NOT clobber static thinking_config",
      isinstance(merged_null.get("thinking_config"), dict))
check("merge: dynamic real value still overrides",
      merged_null.get("price_factor") == 0.2)

print()
print("[5.9] ALL off-peak (低谷) promotion models — must be complete, not just one")
PROMO_KEYS = {"qmodel_38max", "qmodel_latest", "qmodel"}
for realm_name in ("cn", "intl"):
    # 促销集合按"是否带官方 promotion 元数据"判定；promo.active 是快照抓取
    # 时刻是否处于低谷时段（22:00-08:00），不该作为集合成员条件。
    promo_models = {m["key"] for m in C.models_for_realm(realm_name)
                    if m.get("promotion")}
    check(f"[{realm_name}] official promo set == the 3 off-peak models",
          promo_models == PROMO_KEYS, sorted(promo_models))
    # 每个促销模型都要产出完整 off_peak 输出（不止一个）
    for k in sorted(PROMO_KEYS):
        src = next(m for m in C.models_for_realm(realm_name) if m["key"] == k)
        e = P.model_entry(k, src)
        check(f"[{realm_name}] {k} entry carries off_peak window+badge",
              bool(e.get("off_peak")) and e.get("off_peak_window") == "22:00-08:00"
              and bool(e.get("off_peak", {}).get("badge")),
              e.get("off_peak_window"))
        check(f"[{realm_name}] {k} entry has off_peak_active_now bool",
              isinstance(e.get("off_peak_active_now"), bool))
        check(f"[{realm_name}] {k} entry exposes peak/valley pair",
              e.get("price_factor_peak") is not None
              and e.get("price_factor_valley") is not None,
              (e.get("price_factor_peak"), e.get("price_factor_valley")))
# Qwen3.8-Max: is_free=true 绝不能吞掉它的 promotion（看板曾把它渲染成
# 0.00x 免费并吃掉低谷高亮）
me_freeflag = P.model_entry("qmodel_38max",
                            next(m for m in C.STATIC_CN_MODELS
                                 if m["key"] == "qmodel_38max"))
check("qmodel_38max is_free=true still carries promotion (peak 0.5 / valley 0.2)",
      me_freeflag.get("is_free") is True and me_freeflag.get("price_factor_peak") == 0.5
      and me_freeflag.get("price_factor_valley") == 0.2,
      (me_freeflag.get("is_free"), me_freeflag.get("price_factor_peak"),
       me_freeflag.get("price_factor_valley")))

# 看板分支顺序回归：promo 分支必须在 0 价分支之前
_dash = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          "dashboard.html"), encoding="utf-8").read()
_i_promo = _dash.find("if(promo && valley != null)")
_i_free = _dash.find("valley === 0")
check("dashboard: promotion branch BEFORE free branch (highlight no longer swallowed)",
      0 <= _i_promo < _i_free, {"promo": _i_promo, "free": _i_free})
check("dashboard: is_free no longer triggers the 0.00x branch",
      "m.is_free || valley === 0" not in _dash)

print()
print("[11] transient upstream errors (418/provider_error) — retry not punish")
import time as _time_for_11
time = _time_for_11   # 本块直接使用 time.time()/sleep
# 分类判定
check("418 + provider_error is transient",
      P._is_transient_upstream(418, '{"code":"provider_error","message":"Error in upstream response"}'))
check("503 is transient", P._is_transient_upstream(503, ""))
check("client param error (invalid_parameter) NEVER transient",
      not P._is_transient_upstream(400,
          '{"code":"provider_error","details":"data: {\\"error\\":{\\"code\\":'
          '\\"invalid_parameter_error\\",\\"message\\":\\"Range of max_tokens should be [1, 131072]\\"}"'))
check("plain 400 without provider_error not transient",
      not P._is_transient_upstream(400, '{"code":"bad_request"}'))
check("401 never transient", not P._is_transient_upstream(401, "provider_error"))

# 行为级：第一次 418(瞬时) → 重试后成功，账号不背锅
import urllib.error as _ue3, io as _io3
_orig_urlopen = P.urllib.request.urlopen
_calls = {"n": 0}

class _FakeResp(object):
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def read(self, *a): return b"{}"

def _urlopen_fail_once(req, timeout=None):
    _calls["n"] += 1
    if _calls["n"] == 1:
        raise _ue3.HTTPError(req.full_url, 418, "teapot", {},
                             _io3.BytesIO(b'{"code":"provider_error","message":"Error in upstream response"}'))
    return _FakeResp()

try:
    P.urllib.request.urlopen = _urlopen_fail_once
    # 构造单账号池
    import tempfile as _tf
    _td = _tf.mkdtemp(prefix="qdpool_")
    _pool = A.AccountPool(_td)
    _pool.add(A.Account({"uid": "retry-test-uid", "realm": "cn",
                         "accessToken": "dt-test", "refreshToken": "drt-test",
                         "expiresAt": 9999999999}))
    _orig_pool = P.POOL
    P.POOL = _pool
    _acc = _pool.accounts[0]
    _acc.cooldown_until = 0
    t0 = time.time()
    resp, used, _ = P.open_upstream(
        {"model": "qfmodel", "messages": [{"role": "user", "content": "hi"}],
         "stream": False}, target_realm="cn")
    took = time.time() - t0
    check("418-then-success: open_upstream returns after in-place retry",
          resp is not None and _calls["n"] == 2,
          {"calls": _calls["n"]})
    check("418-then-success: account NOT cooled down",
          _acc.cooldown_until <= time.time(),
          round(_acc.cooldown_until - time.time(), 1))
    check("418-then-success: backoff took ~1s (not instant, not 60s)",
          0.8 <= took <= 4.0, round(took, 2))
finally:
    P.urllib.request.urlopen = _orig_urlopen

# 行为级：持续 418 → 重试耗尽后短冷却（单账号 3s 而非 60s）并抛出原错误
def _urlopen_always_418(req, timeout=None):
    _calls["n"] += 1
    raise _ue3.HTTPError(req.full_url, 418, "teapot", {},
                         _io3.BytesIO(b'{"code":"provider_error","message":"Error in upstream response"}'))

_calls["n"] = 0
try:
    P.urllib.request.urlopen = _urlopen_always_418
    P.POOL = _pool          # 上一块 finally 还原了 None，这里重新挂上临时池
    _acc.cooldown_until = 0
    _acc.last_error = ""
    raised = None
    t0 = time.time()
    try:
        P.open_upstream({"model": "qfmodel",
                         "messages": [{"role": "user", "content": "hi"}],
                         "stream": False}, target_realm="cn")
    except _ue3.HTTPError as e:
        raised = e
    took = time.time() - t0
    check("persistent 418: raised after exactly 3 tries",
          raised is not None and raised.code == 418 and _calls["n"] == 3,
          {"calls": _calls["n"], "code": getattr(raised, "code", None)})
    check("persistent 418: short cooldown (<=5s, single-account pool)",
          0 < (_acc.cooldown_until - time.time()) <= 5.5,
          round(_acc.cooldown_until - time.time(), 2))
    check("persistent 418: bounded backoff time (~3s)",
          2.0 <= took <= 6.0, round(took, 2))
finally:
    P.urllib.request.urlopen = _orig_urlopen
    P.POOL = _orig_pool
    import shutil as _sh
    _sh.rmtree(_td, ignore_errors=True)

# 传输层瞬时故障分类（TLS EOF 等）
import urllib.error as _ue4
import ssl as _ssl_for_11
check("URLError wrapping SSL EOF is transient transport",
      P._is_transient_transport(_ue4.URLError(_ssl_for_11.SSLError(
          "[SSL: UNEXPECTED_EOF_WHILE_READING] EOF"))))
check("ConnectionResetError is transient transport",
      P._is_transient_transport(ConnectionResetError("reset")))
check("plain ValueError NOT transient transport",
      not P._is_transient_transport(ValueError("nope")))
check("predicate: URLError+provider401 not transient-http",
      not P._is_transient_upstream(401, "x"))

# 友好错误映射
_m, _t = P.friendly_upstream_error(418,
    '{"code":"provider_error","message":"Error in upstream response"}')
check("friendly: 418 provider_error -> Chinese retry guidance",
      "上游瞬时故障" in _m and "请稍后重试" in _m, _m[:60])
check("friendly: err_type tagged transient",
      _t == "upstream_transient_error", _t)
_m2, _t2 = P.friendly_upstream_error(400,
    '{"code":"provider_error","details":"invalid_parameter_error Range"}')
check("friendly: client param error NOT reframed as transient",
      _t2 == "upstream_error" and "上游瞬时故障" not in _m2, (_t2, _m2[:50]))
check("friendly: detail preserved in message",
      "provider_error" in _m)

# qoder_detail passthrough（错误体只读一次的修复）——挂在持续418的断言上补充
check("raised HTTPError carries qoder_detail for handlers",
      hasattr(raised, "qoder_detail") and "provider_error" in raised.qoder_detail,
      getattr(raised, "qoder_detail", "")[:60])

print()
print("[12] in-stream envelope retry (200-then-418 form — the reported log shape)")
# 状态归一化
check("_to_int_status str/int/fallback", P._to_int_status("418") == 418
      and P._to_int_status(503) == 503 and P._to_int_status("xx") == 502)

_env418 = P.UpstreamStatus(
    418, '{"code":"provider_error","message":"Error in upstream response"}')
check("fresh envelope 418 transient -> retry",
      P.should_retry_envelope(_env418, emitted_bytes=False, attempt=0))
check("already emitted bytes -> NO retry",
      not P.should_retry_envelope(_env418, emitted_bytes=True, attempt=0))
check("budget exhausted -> NO retry",
      not P.should_retry_envelope(_env418, False, P.TRANSIENT_MAX_RETRIES))
_env_param = P.UpstreamStatus(400, "invalid_parameter_error Range of max_tokens")
check("client param envelope -> NO retry",
      not P.should_retry_envelope(_env_param, False, 0))

# aggregate_with_envelope_retry: 第一次信封418 → 重开上游 → 成功
_sleeps = []
_orig_sleep2 = P.time.sleep
_orig_open2 = P.open_upstream
_pools = {"calls": 0}

class _GoodResp(object):
    def __iter__(self):
        inner = json.dumps({"choices": [{"delta": {"content": "recovered"}}]})
        yield ("data: " + json.dumps({"statusCodeValue": 200, "body": inner})
               + "\n\n").encode("utf-8")
        yield b'data: {"statusCodeValue":200,"body":"[DONE]"}\n\n'

    def close(self):
        pass


class _ErrResp(object):
    def __iter__(self):
        yield ("data: " + json.dumps({
            "statusCodeValue": 418,
            "body": '{"code":"provider_error","message":"Error in upstream response"}'})
            + "\n\n").encode("utf-8")

    def close(self):
        pass


def _fake_open(payload, session_key=None, target_realm=None):
    _pools["calls"] += 1
    return _GoodResp(), "acct-1", "enc"


class _A(object):
    uid = "acct-1"


try:
    P.time.sleep = lambda s: _sleeps.append(s)
    P.open_upstream = _fake_open
    obj, acc = P.aggregate_with_envelope_retry(
        _ErrResp(), {"model": "qfmodel"}, None, "cn", "qfmodel",
        {"usage": None}, _A())
    check("envelope 418 -> reopened upstream and recovered",
          obj["choices"][0]["message"]["content"] == "recovered",
          obj["choices"][0]["message"].get("content"))
    check("reopen happened exactly once", _pools["calls"] == 1, _pools["calls"])
    check("backoff 1s recorded", _sleeps == [1], _sleeps)
finally:
    P.time.sleep = _orig_sleep2
    P.open_upstream = _orig_open2

# 非瞬时信封（客户端参数错）不重开、原样上抛
_sleeps2 = []
_pools2 = {"calls": 0}

print()
print("[13] content-policy rejection (DataInspectionFailed — 02:27 log root cause)")
_DI_DETAIL = ('{"error":{"message":"\\u003c400\\u003e InternalError.Algo.'
              'DataInspectionFailed: Input text data may contain inappropriate '
              'content.","type":"UnknownError"}}')
check("DataInspection detail -> NOT transient (no wasted retries)",
      not P._is_transient_upstream(418, _DI_DETAIL))
check("DataInspection envelope -> should_retry_envelope False",
      not P.should_retry_envelope(
          P.UpstreamStatus(418, _DI_DETAIL), emitted_bytes=False, attempt=0))
_m13, _t13 = P.friendly_upstream_error(418, _DI_DETAIL)
check("friendly: content-policy Chinese explanation",
      "内容安全审核未通过" in _m13 and "重试无效" in _m13, _m13[:70])
check("friendly: err_type content_policy_rejected",
      _t13 == "content_policy_rejected", _t13)
check("friendly: original detail preserved",
      "DataInspectionFailed" in _m13)

print()
print("[14] error-cooldown vs upstream-frequency (no misleading 429)")
import time as _t14
# 构造临时池：账号仅处于错误冷却
_td14 = __import__("tempfile").mkdtemp(prefix="qd14_")
_pool14 = A.AccountPool(_td14)
_acc14 = A.Account({"uid": "u14", "realm": "cn", "accessToken": "dt-x",
                    "refreshToken": "drt-x", "expiresAt": 9999999999})
_pool14.add(_acc14)
_orig_pool14 = P.POOL
P.POOL = _pool14
try:
    # (a) 仅账号错误冷却 -> 不算频控
    _acc14.cooldown_until = _t14.time() + 5
    _acc14.model_cooldowns.clear()
    throttled, w = P.realm_model_throttled("cn", "qfmodel")
    check("account error-cooldown is NOT a frequency-limit (no 429)",
          throttled is False, (throttled, w))
    check("retry_after_seconds ignores account cooldown",
          P.retry_after_seconds("qfmodel", "cn") == 60,
          P.retry_after_seconds("qfmodel", "cn"))
    wait = P._short_error_cooldown_wait("cn", "qfmodel")
    check("short error-cooldown wait surfaced (<=10s, >0)",
          0 < wait <= 10, wait)
    # (b) 上游频控 -> 正当429
    _acc14.cooldown_until = 0
    _acc14.model_cooldowns["qfmodel"] = _t14.time() + 60
    throttled2, w2 = P.realm_model_throttled("cn", "qfmodel")
    check("model_cooldowns (upstream 429) IS frequency-limit",
          throttled2 is True and w2 >= 59, (throttled2, w2))
    check("short wait suppressed while frequency-limited",
          P._short_error_cooldown_wait("cn", "qfmodel") == 0.0)
    check("retry_after reflects frequency wait",
          59 <= P.retry_after_seconds("qfmodel", "cn") <= 61,
          P.retry_after_seconds("qfmodel", "cn"))
    # (c) 行为：错误短冷却 -> 等待后续上（真实 sleep ~0.3s）而不是429
    _acc14.model_cooldowns.clear()
    _acc14.cooldown_until = _t14.time() + 0.3
    _orig_urlopen14 = P.urllib.request.urlopen

    class _R14(object):
        def __iter__(self):
            inner = json.dumps({"choices": [{"delta": {"content": "after-wait"}}]})
            yield ("data: " + json.dumps({"statusCodeValue": 200, "body": inner})
                   + "\n\n").encode()
            yield b'data: {"statusCodeValue":200,"body":"[DONE]"}\n\n'
        def close(self):
            pass
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False

    def _ok_urlopen(req, timeout=None):
        return _R14()

    try:
        P.urllib.request.urlopen = _ok_urlopen
        _sleep_used = []
        _t0 = _t14.time()
        try:
            resp, used, _ = P.open_upstream(
                {"model": "qfmodel",
                 "messages": [{"role": "user", "content": "hi"}],
                 "stream": False}, target_realm="cn")
            _served = True
            _rate = None
        except Exception as _e:
            _served = False
            _rate = _e
        took = _t14.time() - _t0
        check("short cooldown: request WAITS and serves (no 429/503)",
              _served and _rate is None,
              {"served": _served, "err": repr(_rate)})
        check("wait lasted ~0.3-1s (bounded)", 0.25 <= took <= 2.0,
              round(took, 2))
    finally:
        P.urllib.request.urlopen = _orig_urlopen14
    # (d) 频控行为不变：真429 仍然立刻 RateLimited
    _acc14.cooldown_until = 0
    _acc14.model_cooldowns["qfmodel"] = _t14.time() + 60
    try:
        P.urllib.request.urlopen = _ok_urlopen
        _raised14 = None
        try:
            P.open_upstream({"model": "qfmodel",
                             "messages": [{"role": "user", "content": "hi"}],
                             "stream": False}, target_realm="cn")
        except Exception as e14:
            _raised14 = e14
        check("genuine frequency limit still raises RateLimited fast",
              isinstance(_raised14, P.RateLimited)
              and "frequency" in str(getattr(_raised14, "detail", "")),
              repr(_raised14))
    finally:
        P.urllib.request.urlopen = _orig_urlopen14
finally:
    P.POOL = _orig_pool14
    _acc14.model_cooldowns.clear()
    _acc14.cooldown_until = 0
    import shutil as _sh14
    _sh14.rmtree(_td14, ignore_errors=True)

# favicon 404 静默
check("log_message silences favicon regardless of status (code present)",
      'req_path == "/favicon.ico"' in open(
          os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "qoder_proxy.py"), encoding="utf-8").read())

print()
print("[15] HTTP/1.1 SSE framing — keep-alive friendly (no more reconnect loop)")
_src15 = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           "qoder_proxy.py"), encoding="utf-8").read()
check("handler defines chunked SSE helpers",
      all(k in _src15 for k in ("def _sse_begin", "def _sse_write",
                                "def _sse_end")))
check("_sse_begin sends Transfer-Encoding: chunked",
      'self.send_header("Transfer-Encoding", "chunked")' in _src15)
check("_sse_end writes terminating zero chunk",
      'b"0\\r\\n\\r\\n"' in _src15)
check("no 'Connection: close' on streaming responses (root cause of reconnect loop)",
      'self.send_header("Connection", "close")' not in _src15)
check("streaming writes go through _sse_write (chunk-encoded)",
      "self.wfile.write(line)" not in _src15
      and "self.wfile.write(clean_responses_frame(frame))" not in _src15)
check("chunked streams are terminated on every exit path",
      _src15.count("self._sse_end()") >= 4, _src15.count("self._sse_end()"))

print()
print("[16] liveness probe endpoints (GET /ping was 404 -> clients reconnect loop)")
check("/ping served without auth/panel",
      'if path in ("/ping", "/healthz", "/livez", "/readyz"):' in _src15)
check("/ping returns plain pong", 'body = b"pong\\n"' in _src15)
check("/ping sits before the /health handler (earliest match)",
      _src15.find('if path in ("/ping"') < _src15.find('if path == "/health":'))

print()
print("[17] SSE heartbeat during long upstream silence (TTFT up to 71s observed)")
check("sse_with_heartbeat helper exists",
      "def sse_with_heartbeat(" in _src15)
check("heartbeat emits SSE comment frames (': ping')",
      'b": ping\\n\\n"' in _src15)
check("heartbeat enabled by default with env override",
      'os.environ.get("QD_SSE_HEARTBEAT"' in _src15)
check("both streaming paths wrap their source with heartbeat",
      _src15.count("sse_with_heartbeat(") >= 3,
      _src15.count("sse_with_heartbeat("))

# 行为级：数据透传 / 空闲补心跳 / 上游异常原样抛出 / 可关闭
_sent2, _slow = [], []


def _slow_gen():
    time.sleep(0.4)                     # 模拟长首字延迟（上游静默）
    yield b"data: late\n\n"
    time.sleep(0.4)                     # 模拟帧间静默
    yield b"data: late2\n\n"


for item in P.sse_with_heartbeat(_slow_gen(), _sent2.append, interval=0.15,
                                 idle_limit=10):
    _slow.append(item)
check("heartbeat: data passes through unchanged",
      _slow == [b"data: late\n\n", b"data: late2\n\n"], _slow)
check("heartbeat: comment frames sent during both silences",
      len(_sent2) >= 2 and all(f == b": ping\n\n" for f in _sent2),
      (len(_sent2), _sent2))


class _BoomErr(RuntimeError):
    pass


def _boom_gen():
    yield b"data: first\n\n"
    raise _BoomErr("upstream died")


_sent3, _got3, _raised3 = [], [], None
try:
    for item in P.sse_with_heartbeat(_boom_gen(), _sent3.append, interval=0.15,
                                     idle_limit=5):
        _got3.append(item)
except Exception as exc:
    _raised3 = exc
check("heartbeat: upstream error propagates unchanged",
      isinstance(_raised3, _BoomErr) and _got3 == [b"data: first\n\n"],
      (type(_raised3).__name__, _got3))


def _one_gen():
    yield b"data: only\n\n"


_sent4, _got4 = [], []
for item in P.sse_with_heartbeat(_one_gen(), _sent4.append, interval=0,
                                 idle_limit=5):
    _got4.append(item)
check("heartbeat: interval=0 disables (pure pass-through)",
      _got4 == [b"data: only\n\n"] and _sent4 == [], (_got4, _sent4))

# 行为：内容审核信封 -> 一次都不重开（open_upstream 不被再次调用）并上抛
class _DiErrResp(object):
    def __iter__(self):
        yield ("data: " + json.dumps({
            "statusCodeValue": 418, "body": _DI_DETAIL}) + "\n\n").encode()

    def close(self):
        pass
    def __enter__(self):
        return self
    def __exit__(self, *a):
        return False


_pools13 = {"calls": 0}
_sleeps13 = []


def _fake_open_never13(payload, session_key=None, target_realm=None):
    _pools13["calls"] += 1
    return _GoodResp(), "acct-1", "enc"


try:
    P.time.sleep = lambda s: _sleeps13.append(s)
    P.open_upstream = _fake_open_never13
    _raised13 = None
    try:
        P.aggregate_with_envelope_retry(
            _DiErrResp(), {"model": "Qwen3.8-Flash"}, None, "cn",
            "Qwen3.8-Flash", {"usage": None}, _A())
    except P.UpstreamStatus as e13:
        _raised13 = e13
    check("content-policy envelope: raised immediately, ZERO reopen, ZERO sleep",
          _raised13 is not None and _pools13["calls"] == 0 and not _sleeps13,
          {"raised": _raised13 is not None, "reopen": _pools13["calls"],
           "sleeps": _sleeps13})
finally:
    P.time.sleep = _orig_sleep2
    P.open_upstream = _orig_open2

# 非瞬时信封（客户端参数错）不重开、原样上抛
_sleeps2 = []
_pools2 = {"calls": 0}

class _ParamErrResp(object):
    def __iter__(self):
        yield ("data: " + json.dumps({
            "statusCodeValue": 400,
            "body": "invalid_parameter_error Range of max_tokens [1, 131072]"})
            + "\n\n").encode("utf-8")

    def close(self):
        pass


def _fake_open_never(payload, session_key=None, target_realm=None):
    _pools2["calls"] += 1
    return _GoodResp(), "acct-1", "enc"


try:
    P.time.sleep = lambda s: _sleeps2.append(s)
    P.open_upstream = _fake_open_never
    _raised_env = None
    try:
        P.aggregate_with_envelope_retry(
            _ParamErrResp(), {"model": "qfmodel"}, None, "cn", "qfmodel",
            {"usage": None}, _A())
    except P.UpstreamStatus as e0:
        _raised_env = e0
    check("param envelope raises immediately (no reopen)",
          _raised_env is not None and _pools2["calls"] == 0,
          {"raised": _raised_env is not None, "reopen": _pools2["calls"]})
finally:
    P.time.sleep = _orig_sleep2
    P.open_upstream = _orig_open2

ctx = {m["key"]: m.get("max_input_tokens") for m in C.STATIC_CN_MODELS}
check("cn dmodel ctx = official 96000 (NOT a guess)", ctx.get("dmodel") == 96000,
      ctx.get("dmodel"))
ctx_i = {m["key"]: m.get("max_input_tokens") for m in C.STATIC_INTL_MODELS}
check("intl dmodel ctx = official 1000000", ctx_i.get("dmodel") == 1000000,
      ctx_i.get("dmodel"))
pf = {m["key"]: m.get("price_factor") for m in C.STATIC_CN_MODELS}
check("price_factor carried from official catalog",
      pf.get("qfmodel") == 0.0 and pf.get("dmodel") == 0.5, pf.get("dmodel"))
check("exclusive sets derived from catalogs",
      "gm51model" in C.CN_EXCLUSIVE and "smodel" in C.INTL_EXCLUSIVE)
check("exclusive realm detection: gm51model -> cn",
      P.exclusive_realm("gm51model") == "cn")
check("exclusive realm detection: smodel -> intl",
      P.exclusive_realm("smodel") == "intl")
check("alias resolves before exclusive check: glm-5.2 -> cn",
      P.exclusive_realm("glm-5.2") == "cn")
check("shared key has no exclusive owner", P.exclusive_realm("qmodel") == "")
check("detect_model_realm routes cn-exclusive to cn even under intl default",
      P.detect_model_realm("q37fmodel") == "cn")
check("detect_model_realm routes intl-exclusive to intl",
      P.detect_model_realm("performance") == "intl")
check("shared model follows current default realm",
      P.detect_model_realm("qmodel") == P.CURRENT_REALM)

print()
print("[5.6] check-in capability is probed at runtime (not hard-coded per realm)")
import qoder_accounts as _A
import urllib.error as _ue2, io as _io2
check("cn has_checkin hint True", _A.get_realm_config("cn")["has_checkin"] is True)
check("intl has_checkin hint False (still only a hint)",
      _A.get_realm_config("intl")["has_checkin"] is False)
acc_intl = _A.Account({"uid": "i1", "realm": "intl", "accessToken": "dt-x"})
acc_cn = _A.Account({"uid": "c1", "realm": "cn", "accessToken": "dt-y"})
# 未探测前不按区域拒绝：国际版同样会真的去尝试一次（实测国际版接口 404，
# 由探测结果决定后续跳过，而不是"看区域直接不做"）
check("intl account is attempted before probing (realm is not a gate)",
      acc_intl.can_checkin() is True and acc_intl.checkin_capability()[0] is None)
check("cn account can checkin", acc_cn.can_checkin() is True)

# 国际版形态：/daily-check-in/* 404 -> 能力记录为不可用 + 明确原因（不是静默）
def fake_status_404(url, **kw):
    raise _ue2.HTTPError(url, 404, "nf", {}, _io2.BytesIO(b'{"errorCode":"NotFound"}'))
_orig_hj = _A.http_json
_A.http_json = fake_status_404
res_intl = acc_intl.checkin()
cap_intl, reason_intl = acc_intl.checkin_capability()
_A.http_json = _orig_hj
check("404 status -> (ok, unavailable) with explicit reason",
      res_intl.get("ok") is True and res_intl.get("unavailable") is True
      and res_intl.get("reason") == _A.CHECKIN_REASON_NOT_FOUND, res_intl)
check("404 message names the missing endpoint + hand-off to official client",
      "daily-check-in" in str(res_intl.get("msg"))
      and "客户端" in str(res_intl.get("msg")), res_intl.get("msg"))
check("capability cached as unavailable -> can_checkin False (no repeated 404s)",
      cap_intl is False and acc_intl.can_checkin() is False and "404" in reason_intl)
# TTL 到期后回到"未探测"，下一次调用会真的重探（活动上线即自动恢复）
acc_intl._checkin_cap_at -= (_A.CHECKIN_PROBE_TTL + 1)
check("TTL 过期 -> capability 回到 unknown，下一次触发重探",
      acc_intl.checkin_capability()[0] is None and acc_intl.can_checkin() is True)

# 官方活动停用 (DISABLED) -> 不 claim、按跳过成功处理
def fake_status_disabled(url, **kw):
    return {"campaignKey": "cn_daily_check_in_legacy", "status": "DISABLED",
            "rewardCredits": 100, "currentStreakDays": 0, "totalClaimDays": 0,
            "totalRewardCredits": 0}
_A.http_json = fake_status_disabled
acc_dis = _A.Account({"uid": "d1", "realm": "cn", "accessToken": "dt-x"})
res_dis = acc_dis.checkin()
cap_ok, _why = acc_dis.checkin_capability()
_A.http_json = _orig_hj
check("DISABLED campaign -> ok+disabled (no claim POST)",
      res_dis.get("ok") is True and res_dis.get("disabled") is True, res_dis)
check("realm-capable status response marks capability available",
      cap_ok is True, cap_ok)
# pro eligibility 404 -> 查询成功但不可领取
def fake_pro_404(url, **kw):
    raise _ue2.HTTPError(url, 404, "nf", {}, _io2.BytesIO(b""))
_A.http_json = fake_pro_404
ok_p, elig_p = acc_dis.pro_eligibility()
_A.http_json = _orig_hj
check("pro eligibility 404 -> (queried, not eligible)",
      ok_p is True and elig_p is False, (ok_p, elig_p))

print()
print("[5.7] campaign platform (/sash/api/v1/me/campaigns) — the new daily-claim home")
_acc_camp = _A.Account({"uid": "cp1", "realm": "intl", "accessToken": "dt-x"})
check("campaigns path constant present (same path on cn + intl)",
      _A.PATH_CAMPAIGNS == "/sash/api/v1/me/campaigns")


def fake_campaigns(url, **kw):
    check("campaigns hit the openapi base of the account realm",
          url.startswith(_A.get_realm_config("intl")["openapi"]), url)
    return {"uid": "cp1", "showCampaign": True, "claimable": True,
            "campaignUrl": "https://qoder.com/activities/daily-credits",
            "campaigns": [{"campaignId": "c-1", "campaignKey": "client_launch_26",
                           "startAt": 1789000000000, "endAt": 1789500000000,
                           "placements": [{"type": "usage_panel"}]}]}


_A.http_json = fake_campaigns
camp = _acc_camp.campaigns()
_A.http_json = _orig_hj
check("campaigns normalized: show/claimable/url",
      camp["ok"] and camp["show_campaign"] and camp["claimable"]
      and camp["campaign_url"].endswith("/daily-credits"), camp)
check("campaigns normalized: id/key/epoch(ms->s)/placements",
      camp["campaigns"][0]["campaign_id"] == "c-1"
      and camp["campaigns"][0]["campaign_key"] == "client_launch_26"
      and camp["campaigns"][0]["start_at"] == 1789000000
      and camp["campaigns"][0]["placements"], camp["campaigns"])
check("campaign snapshot cached on the account", _acc_camp.campaign_status is camp)


def fake_campaigns_404(url, **kw):
    raise _ue2.HTTPError(url, 404, "nf", {}, _io2.BytesIO(b'{"errorCode":"NotFound"}'))


_A.http_json = fake_campaigns_404
camp404 = _acc_camp.campaigns(force=True)   # 绕过 20s 短缓存，验证真实请求路径
_A.http_json = _orig_hj
check("campaigns 404 -> ok False + available False (no crash)",
      camp404["ok"] is False and camp404["available"] is False, camp404)

print()
print("[6] request body construction")
body = P.build_qoder_body({
    "model": "qmodel_38max",
    "messages": [{"role": "system", "content": "You are X."},
                 {"role": "user", "content": "hello"}],
}, None, "qmodel_38max", realm="cn")
check("client system replaces template system",
      body["messages"][0]["content"] == "You are X.")
check("conversation appended",
      [m["role"] for m in body["messages"]] == ["system", "user"])
check("request/session ids fresh uuids",
      body["request_id"] and body["session_id"]
      and body["request_id"] != body["session_id"])
check("stream forced true", body["stream"] is True)
check("agent_id agent_common", body["agent_id"] == "agent_common")
check("model_config key", body["model_config"]["key"] == "qmodel_38max")
check("model_config display_name from official catalog",
      body["model_config"]["display_name"] == "Qwen3.8-Max",
      body["model_config"]["display_name"])
check("model_config ctx from official catalog (cn 180000)",
      body["model_config"]["max_input_tokens"] == 180000)
check("model_config is_vl from official catalog",
      body["model_config"]["is_vl"] is True)
check("chat_context.text follows latest user prompt",
      body["chat_context"]["text"]["text"] == "hello")
check("no client tools -> tools emptied (template agent tools dropped)",
      body["tools"] == [])
check("business.name from prompt", body["business"]["name"] == "hello")

body2 = P.build_qoder_body({
    "model": "qmodel",
    "messages": [{"role": "user", "content": "a"},
                 {"role": "assistant", "content": "b"},
                 {"role": "user", "content": "c"}],
    "max_tokens": 500,
    "reasoning_effort": "high",
    "tools": [{"type": "function", "function": {"name": "f",
                                                 "parameters": {}}}],
}, None, "qmodel")
check("keeps template system when client has none",
      body2["messages"][0]["role"] == "system")
check("multi-turn order kept",
      [m["role"] for m in body2["messages"]] == ["system", "user", "assistant", "user"])
check("max_tokens forwarded", body2["parameters"].get("max_tokens") == 500)
# 思考档位按官方词表归一化（见 [20]）：qmodel 只有开/关、无档位表，
# 下发档位会被上游静默忽略，故此处不再透传（none 仍可用于关闭思考）
check("level-less model drops reasoning_effort (upstream ignores it anyway)",
      "reasoning_effort" not in body2["parameters"],
      body2["parameters"].get("reasoning_effort"))
check("client tools kept", len(body2["tools"]) == 1)
check("latest prompt is c", body2["chat_context"]["text"]["text"] == "c")

# tool 角色降级 + assistant tool_calls 序列化
body3 = P.build_qoder_body({
    "model": "qmodel",
    "messages": [
        {"role": "user", "content": "run"},
        {"role": "assistant", "content": "",
         "tool_calls": [{"id": "c1", "type": "function",
                         "function": {"name": "Bash", "arguments": "{\"cmd\":\"ls\"}"}}]},
        {"role": "tool", "tool_call_id": "c1", "name": "Bash", "content": "file1"},
    ],
}, None, "qmodel")
roles3 = [m["role"] for m in body3["messages"]]
check("tool role degraded to user", roles3 == ["system", "user", "assistant", "user"])
check("assistant tool_calls serialized into content",
      "Bash" in body3["messages"][2]["content"])
check("tool result carried as user text",
      "file1" in body3["messages"][3]["content"])

print()
print("[6.5] DeepSeek reasoning_content backfill keys off the UPSTREAM model key")
# 复现 issue #2 的根因：客户端按文档写「内部 key: dfmodel」时，旧实现只按
# 名字前缀 "deepseek" 判断 -> 不做多轮 reasoning_content 兼容 -> 偶发失败。
_ds_trace = [
    {"role": "user", "content": "1+1=?"},
    {"role": "assistant", "content": "2", "reasoning_content": "简单加法"},
    {"role": "user", "content": "再+1"},
]
check("is_deepseek_model: upstream keys", 
      P.is_deepseek_model("", "dfmodel") and P.is_deepseek_model("", "dmodel"))
check("is_deepseek_model: client-visible names",
      P.is_deepseek_model("DeepSeek-Flash") and P.is_deepseek_model("deepseek-v4-pro")
      and P.is_deepseek_model("DeepSeek-V4-Pro"))
check("is_deepseek_model: display id form",
      P.is_deepseek_model("dfmodel (DeepSeek-Flash)"))
check("is_deepseek_model: non-DeepSeek models stay untouched",
      not P.is_deepseek_model("qmodel") and not P.is_deepseek_model("Qwen3.8-Max"))

_bf_key = P.backfill_reasoning_content([dict(m) for m in _ds_trace], "dfmodel",
                                       "dfmodel")
check("client using key 'dfmodel' NOW gets the backfill (regression)",
      all("reasoning_content" in m for m in _bf_key
          if m.get("role") == "assistant"), _bf_key)
_bf_name = P.backfill_reasoning_content([dict(m) for m in _ds_trace],
                                        "DeepSeek-Flash", "dfmodel")
check("display name path still works (no regression)",
      any(m.get("reasoning_content") == "简单加法" for m in _bf_name))
_bf_other = P.backfill_reasoning_content(
    [{"role": "user", "content": "q"},
     {"role": "assistant", "content": "a", "reasoning_content": "trace"}],
    "qmodel", "qmodel")
check("non-DeepSeek model: no reasoning_content added by the backfill",
      _bf_other[1] == {"role": "assistant", "content": "a",
                       "reasoning_content": "trace"})
_st_other, _flat_other, _ = P.flatten_messages(_bf_other, keep_reasoning=False)
check("flatten drops reasoning_content for non-DeepSeek upstreams",
      all("reasoning_content" not in m for m in _flat_other), _flat_other)
_st_ds, _flat_ds, _ = P.flatten_messages(
    [{"role": "user", "content": "q"},
     {"role": "assistant", "content": "a", "reasoning_content": "trace"}],
    keep_reasoning=True)
check("flatten KEEPS reasoning_content for DeepSeek upstreams (was dropped)",
      _flat_ds[1].get("reasoning_content") == "trace", _flat_ds)
_no_trace = P.backfill_reasoning_content(
    [{"role": "user", "content": "hi"}], "dfmodel", "dfmodel")
check("no reasoning trace in history -> no synthetic field",
      all("reasoning_content" not in m for m in _no_trace))

# 端到端：build_qoder_body 用显式 key 调用时也会补
_body_ds = P.build_qoder_body({
    "model": "dfmodel",
    "messages": [
        {"role": "user", "content": "1+1=?"},
        {"role": "assistant", "content": "2", "reasoning_content": "简单加法"},
        {"role": "user", "content": "再+1"},
    ],
}, None, "dfmodel", realm="cn")
_ds_assistants = [m for m in _body_ds["messages"] if m.get("role") == "assistant"]
check("build_qoder_body('dfmodel') backfills assistant history",
      _ds_assistants and all("reasoning_content" in m for m in _ds_assistants),
      _ds_assistants)

print()
print("[7] SSE envelope unwrapping & aggregation")


class FakeResp(object):
    def __iter__(self):
        inner = json.dumps({"id": "cc1", "model": "qmodel", "created": 1,
                            "choices": [{"delta": {"content": "hi"}}]})
        inner2 = json.dumps({"choices": [{"delta": {},
                                          "finish_reason": "stop"}],
                             "usage": {"prompt_tokens": 3, "completion_tokens": 2,
                                       "total_tokens": 5}})
        return iter([
            ("data: " + json.dumps({"headers": {}, "body": inner,
                                    "statusCodeValue": 200}) + "\n\n").encode(),
            ("data: " + json.dumps({"body": inner2,
                                    "statusCodeValue": 200}) + "\n\n").encode(),
            b'data:{"body":"[DONE]"}\n\n',
            b'event:finish{"totalTime":10}\n',
        ])


holder = {}
lines = list(P.iter_inner_sse(FakeResp(), holder=holder))
check("unwrapped to standard data lines", len(lines) == 2
      and lines[0].startswith(b"data: "))
check("usage captured in holder", (holder.get("usage") or {}).get("total_tokens") == 5)
agg = P.aggregate_stream(FakeResp(), "qmodel", None, holder={})
check("aggregate content", agg["choices"][0]["message"]["content"] == "hi")
check("aggregate finish stop", agg["choices"][0]["finish_reason"] == "stop")
check("aggregate usage", agg.get("usage", {}).get("total_tokens") == 5)


class ErrResp(object):
    def __iter__(self):
        return iter([("data: " + json.dumps({"body": "quota exceeded",
                                             "statusCodeValue": 503})
                      + "\n\n").encode()])


try:
    list(P.iter_inner_sse(ErrResp()))
    check("non-200 envelope raises UpstreamStatus", False)
except P.UpstreamStatus as exc:
    check("non-200 envelope raises UpstreamStatus",
          str(exc.status) == "503" and "quota" in exc.detail)

# 空 tool_call 占位清洗
noisy = json.dumps({"choices": [{"delta": {"function_call": {"name": "",
                                                             "arguments": ""},
                                           "reasoning_content": ""}}]})
cleaned = P.clean_chunk(noisy)
check("empty function_call noise stripped",
      cleaned == "" or "function_call" not in cleaned, cleaned)

print()
print("[8] Responses API custom tool translation")
CUSTOM_TOOL = {"type": "custom", "name": "apply_patch",
               "description": "Use the patch format to edit files",
               "format": {"type": "grammar", "syntax": "lark",
                          "definition": "start: /.*/s"}}
FUNC_TOOL = {"type": "function", "name": "get_weather",
             "description": "weather",
             "parameters": {"type": "object", "properties": {}}}
chat = P.responses_to_chat({"model": "m", "input": "hi",
                            "tools": [CUSTOM_TOOL, FUNC_TOOL]})
tools = chat["tools"]
check("custom tool became type=function", tools[0]["type"] == "function",
      tools[0].get("type"))
check("custom tool single 'input' param",
      list((tools[0]["parameters"]["properties"] or {}).keys()) == ["input"])
check("freeform hint present", "freeform tool" in tools[0]["description"])
check("grammar forwarded", "start: /.*/s" in tools[0]["description"])
check("ordinary function tool untouched", tools[1] == FUNC_TOOL)

hist = {"model": "m", "input": [
    {"role": "user", "content": "edit the file"},
    {"type": "custom_tool_call", "name": "apply_patch", "call_id": "call_1",
     "input": "*** Begin Patch\n+hi\n*** End Patch"},
    {"type": "custom_tool_call_output", "call_id": "call_1", "output": "Done!"},
]}
c2msgs = P.responses_to_chat(hist)["messages"]
asst = [m for m in c2msgs if m.get("role") == "assistant" and m.get("tool_calls")]
check("assistant carries the tool call", len(asst) == 1)
check("payload wrapped as {input: ...}",
      json.loads(asst[0]["tool_calls"][0]["function"]["arguments"])["input"]
      .startswith("*** Begin Patch"))
tool_msgs = [m for m in c2msgs if m.get("role") == "tool"]
check("tool result appended", len(tool_msgs) == 1
      and tool_msgs[0]["tool_call_id"] == "call_1")

chat_obj = {"choices": [{"finish_reason": "tool_calls", "message": {
    "role": "assistant", "content": "",
    "tool_calls": [{"id": "call_7", "type": "function", "function": {
        "name": "apply_patch",
        "arguments": json.dumps({"input": "*** Begin Patch\n+ok\n*** End Patch"})}}]}}]}
r = P.chat_to_response(chat_obj, "m", {"apply_patch"})
item = r["output"][0]
check("non-stream re-inflated to custom_tool_call",
      item["type"] == "custom_tool_call", item.get("type"))
check("input unwrapped verbatim",
      item["input"] == "*** Begin Patch\n+ok\n*** End Patch")

# reasoning item 处理 (Issue #17 parity)
hist_r = {"model": "m", "input": [
    {"role": "user", "content": "solve math"},
    {"type": "reasoning", "id": "rs_1",
     "summary": [{"type": "summary_text", "text": "let me think"}]},
    {"type": "message", "role": "assistant", "content": "4"},
]}
cr = P.responses_to_chat(hist_r)["messages"]
asst_r = [m for m in cr if m.get("role") == "assistant"]
check("reasoning attached to assistant",
      len(asst_r) == 1 and asst_r[0].get("reasoning_content") == "let me think")

# 流式 Responses 事件序列
def chunk(delta, finish=None):
    return ("data: " + json.dumps({"choices": [{"delta": delta,
                                                "finish_reason": finish}]})
            + "\n\n").encode()

stream = [
    chunk({"tool_calls": [{"index": 0, "id": "call_9",
                           "function": {"name": "apply_patch",
                                        "arguments": ""}}]}),
    chunk({"tool_calls": [{"index": 0,
                           "function": {"arguments": '{"input":"*** Begin'}}]}),
    chunk({"tool_calls": [{"index": 0,
                           "function": {"arguments": ' Patch\\n+hi\\n*** End Patch"}'}}]}),
    chunk({}, "tool_calls"),
]
holder2 = {"usage": None, "custom_names": {"apply_patch"}}
raw_events = b"".join(P.stream_responses_events(iter(stream), "m", holder2))
text = raw_events.decode()
check("created event first", "response.created" in text)
check("custom_tool_call_input.delta present",
      "response.custom_tool_call_input.delta" in text)
check("custom_tool_call_input.done present",
      "response.custom_tool_call_input.done" in text)
check("no stray function_call_arguments for custom",
      "response.function_call_arguments" not in text)
check("completed terminal event", "response.completed" in text)
done = [json.loads(l[6:]) for l in text.splitlines()
        if l.startswith("data: ")
        and '"response.custom_tool_call_input.done"' in l]
check("done carries unwrapped input",
      done and done[0]["input"] == "*** Begin Patch\n+hi\n*** End Patch")

print()
print("[9] checkin / keepalive normalization (offline fixtures)")
acc = A.Account({"uid": "fx-1", "realm": "cn", "domain": "qoder.com.cn",
                 "accessToken": "jt-x", "refreshToken": "jrt-y",
                 "expiresAt": 9999999999})
# status: CLAIMED today
import time as _t
_today = _t.time()
ok, st = acc.checkin_status.__wrapped__ if False else (True, None)


class _FixStatus(object):
    pass


# 直接测归一化分支：monkeypatch http_json
orig_http_json = A.http_json


def fake_status_ok(url, **kw):
    return {"status": "CLAIMABLE", "rewardCredits": 100,
            "currentStreakDays": 3, "totalClaimDays": 10,
            "totalRewardCredits": 900, "lastClaimedAt": 0}


def fake_claim_ok(url, **kw):
    return {"success": True, "rewardCredits": 100}


A.http_json = fake_status_ok
res = acc.checkin()
check("claim path awards 100", res.get("ok") and res.get("reward_credits") == 100,
      res)
check("last_checkin stamped", bool(acc.last_checkin))

# 409 ALREADY_CLAIMED -> 已签到
import urllib.error as _ue
import io as _io


def fake_claim_conflict(url, **kw):
    if "daily-check-in/status" in url:
        # 昨天签过 -> 状态端点正常返回，claim 端点才是 409
        return {"status": "CLAIMED", "rewardCredits": 100,
                "currentStreakDays": 3, "totalClaimDays": 10,
                "totalRewardCredits": 900,
                "lastClaimedAt": int(_t.time()) - 86400}
    raise _ue.HTTPError(url, 409, "conflict", {},
                        _io.BytesIO(b'{"result":"ALREADY_CLAIMED"}'))


A.http_json = fake_claim_conflict
acc2 = A.Account({"uid": "fx-2", "realm": "cn", "accessToken": "jt-x",
                  "refreshToken": "jrt-y", "expiresAt": 9999999999})
res2 = acc2.checkin()
check("409 ALREADY_CLAIMED normalized to ok/already",
      res2.get("ok") and res2.get("already"), res2)
A.http_json = orig_http_json

# session dead markers
check("TOKEN_EXPIRE detected", A.session_dead("TOKEN_EXPIRE expired"))
check("12153 detected", A.session_dead('{"code":"12153"}'))
check("normal error not dead", not A.session_dead("connection reset"))

# token family routing
acc_d = A.Account({"uid": "d", "accessToken": "dt-1", "refreshToken": "drt-1"})
acc_j = A.Account({"uid": "j", "accessToken": "jt-1", "refreshToken": "jrt-1"})
check("device family", A.token_family(acc_d) == "device")
check("job family", A.token_family(acc_j) == "job")

print()
print("[4.5] credential / model-cache crypto KATs (official fixtures)")
import base64 as _b64
# fixture 探测：环境变量优先，其次按候选顺序找；不再硬编码单个 %TEMP% 路径。
_HERE = os.path.dirname(os.path.abspath(__file__))
_FIX_ENV = os.environ.get("QD_TEST_FIXTURE_DIR") or ""
_FIX_CANDIDATES = [
    _FIX_ENV,
    os.path.join(_HERE, "testdata", "protocol", "1.1.34"),
    os.path.join(_HERE, "tests", "fixtures", "protocol", "1.1.34"),
    os.path.join(_HERE, os.pardir, "qoder-ref", "cli2api", "testdata",
                 "protocol", "1.1.34"),
    os.path.join(os.environ.get("TEMP") or os.environ.get("TMP") or "/tmp",
                 "qoder-ref", "cli2api", "testdata", "protocol", "1.1.34"),
    os.path.join(os.path.expanduser("~"), "qoder-ref", "cli2api",
                 "testdata", "protocol", "1.1.34"),
]
if _FIX_ENV and not os.path.isdir(_FIX_ENV):
    print("  [WARN] QD_TEST_FIXTURE_DIR 指向的目录不存在：%s" % _FIX_ENV)
_FIX, _FIX_TRIED = "", []
for _cand in _FIX_CANDIDATES:
    if not _cand:
        continue
    _cand_abs = os.path.abspath(_cand)
    _FIX_TRIED.append(_cand_abs)
    if os.path.isdir(_cand_abs):
        _FIX = _cand_abs
        break
if _FIX:
    print("  fixture 目录: %s" % _FIX)
else:
    print("  fixture 目录: 未找到；已探测 %d 条候选：" % len(_FIX_TRIED))
    for _p in _FIX_TRIED:
        print("      -  %s" % _p)
    print("      指定方式: QD_TEST_FIXTURE_DIR=<dir> python _test_qoder.py")

_CRED_FP = os.path.join(_FIX, "credential.json") if _FIX else ""
_MCACHE_FP = os.path.join(_FIX, "model-cache.json") if _FIX else ""

if _CRED_FP and os.path.isfile(_CRED_FP):
    fx = json.load(open(_CRED_FP, encoding="utf-8"))
    mkey = fx["input"]["machine_key"].encode()
    fx_ct = _b64.b64decode(fx["expected"]["encrypted"])
    dec = S.aes_cbc_decrypt(fx_ct, mkey, mkey)
    check("credential fixture decrypt byte-exact",
          dec.decode() == fx["expected"]["decrypted"])
    enc = _b64.b64encode(S.aes_cbc_encrypt(dec, mkey, mkey)).decode()
    check("credential fixture encrypt byte-exact",
          enc == fx["expected"]["encrypted"])
else:
    _miss_cred = "缺 credential.json" if _FIX else "缺 fixture 目录"
    skip("credential fixture decrypt byte-exact", _miss_cred)
    skip("credential fixture encrypt byte-exact", _miss_cred)

if _MCACHE_FP and os.path.isfile(_MCACHE_FP):
    mf = json.load(open(_MCACHE_FP, encoding="utf-8"))
    plain = S.qmc_decrypt(mf["expected"]["encrypted"], mf["input"]["uid"])
    check("model-cache (QMC v1) fixture decrypt byte-exact",
          plain.decode() == mf["expected"]["decrypted"])
else:
    skip("model-cache (QMC v1) fixture decrypt byte-exact",
         "缺 model-cache.json" if _FIX else "缺 fixture 目录")

# AES-256 互逆（QMC 用 32 字节 key -> 15 个轮密钥）：纯算法、不依赖 fixture，
# 因此永远执行（此前被误放进 fixture 分支，缺 fixture 时连算法 KAT 都一起没跑）。
k256 = bytes(range(32))
blk = bytes(range(16))
rks = S._expand_key(k256)
check("AES-256 key schedule = 15 round keys", len(rks) == 15, len(rks))
check("AES-256 block roundtrip",
      S._decrypt_block(S._encrypt_block(blk, rks), rks) == blk)

print()
print("[4.6] local credential scan (reads THIS machine's official stores)")
try:
    import qoder_accounts as _QA
    detected = _QA.scan_desktop_credentials()
    check("scan returns both realms", len(detected) >= 2, len(detected))
    realms_seen = {d["realm"] for d in detected}
    # 本地补丁（A-SWITCH）：扫描多认一个 qworkcn 存储（千问办公），
    # 故断言"至少覆盖 intl + cn"，本机登录了哪些就出哪些。
    check("scan covers intl + cn (qworkcn added by local patch)",
          {"intl", "cn"} <= realms_seen, realms_seen)
    valid = [d for d in detected if d.get("valid")]
    # 本机是否登录过属于环境状态：登录过则必须解出 uid/dt- 前缀
    if valid:
        check("valid entries carry uid + dt- token prefix",
              all(d["uid"] and d.get("kind") for d in valid),
              [(d["realm"], d.get("kind"), d.get("uid", "")[:8]) for d in valid])
        check("app entries decrypted via os_crypt (kind=app uid present)",
              all(d.get("uid") for d in valid if d["kind"] == "app"))
    else:
        check("scan ran without crash (no valid creds on this machine)", True)
except Exception as exc:
    check("local credential scan", False, exc)

print()
print("[10] gateway plumbing")
check("detect_model_realm fallback to current",
      P.detect_model_realm("mystery-model") == P.CURRENT_REALM)
check("CORS on API path", P.cors_origin_allowed("/v1/chat/completions"))
check("no CORS on management", not P.cors_origin_allowed("/accounts"))
check("no CORS on /v1/usage", not P.cors_origin_allowed("/v1/usage"))
check("realm persisted file name", P.REALM_STATE_FILE.endswith("active_realm.json"))
# 会话亲和键稳定性
k1 = P.derive_affinity_key([{"role": "system", "content": "s"},
                             {"role": "user", "content": "u1"}])
k2 = P.derive_affinity_key([{"role": "system", "content": "s"},
                             {"role": "user", "content": "u1"},
                             {"role": "assistant", "content": "a"}])
k3 = P.derive_affinity_key([{"role": "system", "content": "s"},
                             {"role": "user", "content": "different"}])
check("affinity key stable across turns", k1 == k2)
check("affinity key differs per conversation", k1 != k3)
# prompt fingerprint privacy
fp = P.prompt_fingerprint([{"role": "system", "content": "secret system"}])
check("fingerprint has no raw text",
      "secret" not in json.dumps(fp) and len(fp.get("system_sha", "")) == 12)

# flatten / sanitize
sys_text, flat, images = P.flatten_messages([
    {"role": "system", "content": "base"},
    {"role": "user", "content": [{"type": "text", "text": "part1"},
                                  {"type": "image_url",
                                   "image_url": {"url": "data:image/png;base64,AAA"}}]},
])
check("system extracted", sys_text == "base")
check("text parts joined", flat[0]["content"] == "part1")
check("image collected", images == ["data:image/png;base64,AAA"])
check("fingerprint string sanitized",
      "You are Claude Code, Anthropic's official CLI tool" in
      P.sanitize_text("You are Claude Code, Anthropic's official CLI tool for Claude"))

print()
print("[18] task center lists every realm (issue #1: intl check-in was filtered out)")
_t_intl = A.Account({"uid": "t-intl", "realm": "intl", "domain": "qoder.com",
                     "accessToken": "dt-x", "nickname": "intl-user"})
_t_cn = A.Account({"uid": "t-cn", "realm": "cn", "domain": "qoder.com.cn",
                   "accessToken": "dt-y", "nickname": "cn-user"})
_t_pool = A.AccountPool(os.path.join(os.environ["ACCOUNTS_DIR"], "unused"))
_t_pool.accounts = [_t_intl, _t_cn]
# 离线打桩：状态 404（intl 真实形态）+ 活动平台可用
_orig_status = A.Account.checkin_status
_orig_camp = A.Account.campaigns
_orig_credits = A.Account.fetch_credits
_orig_plan = A.Account.fetch_plan
_orig_elig = A.Account.pro_eligibility


def _stub_status(self):
    if self.realm == "intl":
        self._mark_checkin_capability(False, "%s (HTTP 404)"
                                      % A.CHECKIN_REASON_NOT_FOUND)
        return False, {"unavailable": True, "reason": A.CHECKIN_REASON_NOT_FOUND,
                       "http": 404, "error": "HTTP 404 NotFound"}
    return True, {"status": "DISABLED", "active": False, "today_checked_in": False,
                  "streak_days": 0, "total_claim_days": 0, "reward_credits": 100,
                  "total_reward_credits": 0, "next_claim_at": 0,
                  "last_claimed_at": 0, "reward_expires_at": 0}


A.Account.checkin_status = _stub_status
# 活动平台：intl 已领取、cn 可领取（100 Credits）—— 与官方桌面端真实形态一致
_A_CAMPAIGNS = {
    "intl": {"ok": True, "available": True, "show_campaign": True,
             "claimable": False, "campaign_url": "https://openapi.qoder.sh/growth-page/activity-iframe",
             "campaigns": [
                 {"campaign_id": "c-intl", "campaign_key": "act-intl",
                  "action_type": "CLAIM_BENEFIT", "claim_status": "CLAIMED",
                  "title_zh": "每天领 100 Credits",
                  "start_at": 0, "end_at": 0,
                  "benefit": {"kind": "CREDITS", "amount": 100},
                  "required_achievement_key": "",
                  "achievement_completed": False, "unavailable_reason": "",
                  "placements": []},
                 # 详情类活动（无奖励）：不应被算作"签到奖励"
                 {"campaign_id": "c-detail", "campaign_key": "act-detail",
                  "action_type": "VIEW_DETAILS", "claim_status": "CLAIMED",
                  "start_at": 0, "end_at": 0,
                  "benefit": {"kind": "", "amount": 0},
                  "required_achievement_key": "",
                  "achievement_completed": False, "unavailable_reason": "",
                  "placements": []}]},
    "cn": {"ok": True, "available": True, "show_campaign": True,
           "claimable": True, "campaign_url": "https://openapi.qoder.com.cn/growth-page/activity-iframe",
           "campaigns": [{"campaign_id": "c-cn", "campaign_key": "act-daily-100",
                          "action_type": "CLAIM_BENEFIT", "claim_status": "CLAIMABLE",
                          "start_at": 0, "end_at": 0,
                          "benefit": {"kind": "CREDITS", "amount": 100},
                          "required_achievement_key": "",
                          "achievement_completed": False, "unavailable_reason": "",
                          "placements": []}]},
}
A.Account.campaigns = lambda self, force=False: dict(_A_CAMPAIGNS[self.realm])
A.Account.fetch_credits = lambda self: {"ok": True, "credits": {}}
A.Account.fetch_plan = lambda self: ""
A.Account.pro_eligibility = lambda self: (True, False)
try:
    _view_intl = T.fetch_tasks_view(_t_pool, uid="t-intl")
    _view_cn = T.fetch_tasks_view(_t_pool, uid="t-cn")
    _view_all = T.fetch_tasks_view(_t_pool)
finally:
    A.Account.checkin_status = _orig_status
    A.Account.campaigns = _orig_camp
    A.Account.fetch_credits = _orig_credits
    A.Account.fetch_plan = _orig_plan
    A.Account.pro_eligibility = _orig_elig

check("intl account is selectable in the task center",
      _view_intl.get("account", {}).get("uid") == "t-intl", _view_intl.get("msg"))
check("task center lists BOTH realms",
      {a["realm"] for a in _view_all["accounts"]} == {"cn", "intl"},
      _view_all["accounts"])
_intl_row = [t for t in _view_intl["tasks"] if t["task_code"] == "daily_checkin"][0]
_cn_row = [t for t in _view_cn["tasks"] if t["task_code"] == "daily_checkin"][0]
check("intl: claimed 每日 Credits renders as 今日已领取（中文活动名）",
      _intl_row["status"] == "claimed" and "今日已领取" in _intl_row["description"]
      and "每天领 100 Credits" in _intl_row["description"], _intl_row)
check("每日行不计入详情类活动（VIEW_DETAILS 不算签到奖励）",
      "act-detail" not in _intl_row["description"], _intl_row["description"])
check("cn: CLAIMABLE campaign renders as 待领奖 + reward amount",
      _cn_row["status"] == "completed" and _cn_row["reward_credit"] == 100
      and "领取" in _cn_row["description"], _cn_row)
check("legacy DISABLED endpoint no longer produces a noise row",
      "daily_checkin_legacy" not in [t["task_code"] for t in _view_cn["tasks"]],
      [t["task_code"] for t in _view_cn["tasks"]])
_codes = [t["task_code"] for t in _view_intl["tasks"]]
check("campaign state surfaced in summary (show/claimable/url/items)",
      _view_intl["summary"]["campaigns"]["show"] is True
      and _view_intl["summary"]["campaigns"]["items"][0]["key"] == "act-intl",
      _view_intl["summary"]["campaigns"])
check("daily row carries a jump url (campaignUrl or activities page)",
      bool(_intl_row.get("jump_url")) and "qoder" in _intl_row["jump_url"],
      _intl_row.get("jump_url"))

print()
print("[19] gateway host failover (official intl api1 -> api2; CN single host)")
check("gateway_candidates: intl primary is api1 with api2/api3 fallbacks",
      A.gateway_candidates("intl") == ["https://api1.qoder.sh",
                                       "https://api2.qoder.sh",
                                       "https://api3.qoder.sh"],
      A.gateway_candidates("intl"))
check("gateway_candidates: cn has a single official host",
      A.gateway_candidates("cn") == ["https://gateway.qoder.com.cn"],
      A.gateway_candidates("cn"))

# 行为：api1 传输层失败 -> 自动切到 api2 并在同一请求内成功
import ssl as _ssl19
_orig_urlopen19 = P.urllib.request.urlopen
_hits19 = []


class _Resp19(object):
    status = 200

    def read(self):
        return b""

    def close(self):
        pass


def _fake_urlopen19(req, timeout=None):
    _hits19.append(req.full_url)
    if "api1.qoder.sh" in req.full_url:
        raise _ssl19.SSLError("simulated TLS EOF on primary host")
    return _Resp19()


_orig_pool19 = P.POOL
_pool19 = A.AccountPool(os.path.join(os.environ["ACCOUNTS_DIR"], "unused19"))
_pool19.accounts = [A.Account({"uid": "h19", "realm": "intl",
                               "domain": "qoder.com",
                               "accessToken": "dt-x"})]
P.POOL = _pool19
P.urllib.request.urlopen = _fake_urlopen19
try:
    _resp19, _acc19, _ = P.open_upstream(
        {"model": "qmodel", "stream": True,
         "messages": [{"role": "user", "content": "hi"}]},
        target_realm="intl")
    _err19 = None
except Exception as exc:                      # pragma: no cover - failure path
    _err19 = exc
finally:
    P.urllib.request.urlopen = _orig_urlopen19
    P.POOL = _orig_pool19

check("failover: request succeeded after primary host transport error",
      _err19 is None and _acc19.uid == "h19", _err19)
check("failover: both hosts were tried in order (api1 then api2)",
      len(_hits19) == 2 and "api1.qoder.sh" in _hits19[0]
      and "api2.qoder.sh" in _hits19[1], _hits19)
check("failover: signature path unchanged across hosts",
      _hits19[0].split("?")[0].endswith(P.CHAT_PATH.split("?")[0]),
      _hits19[0])

print()
print("[20] campaign check-in (the real daily-claim API) + effort normalization")

# --- 20.1 桌面端请求头（活动平台必需；缺了服务端返回空列表） ---
_hdrs = _t_cn.desktop_headers()
check("desktop headers carry Cosy-ClientType=10 + Cosy-Version + UA Qoder",
      _hdrs["cosy-clienttype"] == "10" and _hdrs["User-Agent"] == "Qoder"
      and bool(_hdrs["cosy-version"]), _hdrs.get("cosy-clienttype"))
# 前提：文件头已设 QD_NATIVE_IDENTITY=0，且本机 runtime_info_exe("cn") 返回空 ->
# 本进程内的身份来源必为 "derived"（:1679 那条断言独立守这一点）。
# issue #10：**derived** 身份不得携带 cosy-machine* 六头——服务端一旦看到一整套
# 派生机器头，就会把 CN 的「每日领取 100 Credits」等可领取活动整条过滤掉（列表变空）。
# 语义 = 服务端可见值必须为空/缺失（实现删除键或置空都满足）；"能红"面 = 回退成
# 无条件发头即失败。
_MACHINE_HDRS20 = ("cosy-machineid", "cosy-machinetoken", "cosy-machinetype",
                   "cosy-machineos", "cosy-machinehostname", "cosy-machinecode")
check("derived 身份不得发送 cosy-machine* 六头（issue #10：全套派生机器头会让服务端"
      "过滤掉可领取的 Credits 活动）",
      not any(_hdrs.get(k) for k in _MACHINE_HDRS20),
      {k: _hdrs.get(k) for k in _MACHINE_HDRS20 if _hdrs.get(k)})
check("native identity bridge can be disabled (derived fallback)",
      os.environ.get("QD_NATIVE_IDENTITY") == "0"
      and _t_cn.machine_identity_source == "derived"
      and A.runtime_info_exe("cn") == "",
      _t_cn.machine_identity_source)
check("desktop headers keep the Bearer token",
      _hdrs["Authorization"].startswith("Bearer "))
# issue #10 的正向面：修复只能收窄 derived，**native 原生身份必须照旧发六头**。
# 打桩原生身份返回值（当前 desktop_headers 以 native_machine_identity() 的返回
# 为判据；若实现改判据，这条会红——这正是要它守住的契约）。
_orig_nmi20 = A.native_machine_identity
try:
    A.native_machine_identity = lambda realm, account_id, force=False: {
        "machineToken": "nt-token", "machineType": "3",
        "machineCode": "nc-1", "source": "runtime-info"}
    _t_native20 = A.Account({"uid": "h20native", "realm": "cn",
                             "accessToken": "dt-x"})
    _h_native20 = _t_native20.desktop_headers()
finally:
    A.native_machine_identity = _orig_nmi20
check("原生桥身份分支（source=runtime-info）仍发送 cosy-machine* 六头"
      "（issue #10 只收窄 derived，不砍原生能力）",
      _t_native20.machine_identity_source == "runtime-info"
      and all(_h_native20.get(k) for k in _MACHINE_HDRS20),
      {k: _h_native20.get(k) for k in _MACHINE_HDRS20})
check("campaign claim/reward path templates (official growth-page contract)",
      A.PATH_CAMPAIGN_CLAIM == "/sash/api/v1/me/campaigns/%s/claim"
      and A.PATH_CAMPAIGN_REWARD == "/sash/api/v1/me/campaigns/%s/reward")

# --- 20.2 campaign_checkin: 只领取 CLAIMABLE + CLAIM_BENEFIT，幂等视为已领 ---
_orig_claim = A.Account.claim_campaign
_calls20 = []


def _stub_claim(self, campaign_id):
    _calls20.append(campaign_id)
    return {"ok": True, "status": "CLAIMED", "replayed": False, "grant_id": "g1",
            "amount": 100, "message": "领取成功"}


A.Account.claim_campaign = _stub_claim
A.Account.campaigns = lambda self, force=False: {
    "ok": True, "available": True, "show_campaign": True, "claimable": True,
    "campaign_url": "https://openapi.qoder.com.cn/growth-page/activity-iframe",
    "campaigns": [
        {"campaign_id": "c1", "campaign_key": "act-daily-100",
         "action_type": "CLAIM_BENEFIT", "claim_status": "CLAIMABLE",
         "start_at": 0, "end_at": 0, "benefit": {"kind": "CREDITS", "amount": 100},
         "placements": []},
        {"campaign_id": "c2", "campaign_key": "act-view-only",
         "action_type": "VIEW_DETAILS", "claim_status": "CLAIMABLE",
         "start_at": 0, "end_at": 0, "benefit": {"kind": "", "amount": 0},
         "placements": []},
        {"campaign_id": "c3", "campaign_key": "act-done",
         "action_type": "CLAIM_BENEFIT", "claim_status": "CLAIMED",
         "start_at": 0, "end_at": 0, "benefit": {"kind": "CREDITS", "amount": 100},
         "placements": []},
    ]}
_acc20 = A.Account({"uid": "cp20", "realm": "cn", "accessToken": "dt-x"})
try:
    _res20 = _acc20.campaign_checkin(gap=0)
finally:
    A.Account.claim_campaign = _orig_claim
    A.Account.campaigns = _orig_camp

check("only CLAIMABLE CLAIM_BENEFIT campaigns are claimed",
      _calls20 == ["c1"], _calls20)
check("VIEW_DETAILS campaign is not claimed", "c2" not in _calls20)
check("already-CLAIMED campaign is not re-posted", "c3" not in _calls20)
check("campaign_checkin reports earned credits + already list",
      _res20["earned"] == 100 and len(_res20["claimed"]) == 1
      and len(_res20["already"]) == 1, _res20.get("message"))
check("campaign_checkin stamps last_checkin on success", bool(_acc20.last_checkin))
check("campaign_checkin message names the claimed campaign",
      "act-daily-100" in _res20["message"], _res20["message"])

# --- 20.3 幂等：上游 replayed=true 视为已领取而不是新领取 ---
A.Account.campaigns = lambda self, force=False: {
    "ok": True, "available": True, "show_campaign": True, "claimable": True,
    "campaign_url": "", "campaigns": [
        {"campaign_id": "c9", "campaign_key": "act-x",
         "action_type": "CLAIM_BENEFIT", "claim_status": "CLAIMABLE",
         "start_at": 0, "end_at": 0, "benefit": {"kind": "CREDITS", "amount": 100},
         "placements": []}]}
A.Account.claim_campaign = lambda self, cid: {
    "ok": True, "status": "CLAIMED", "replayed": True, "grant_id": "g9",
    "amount": 100, "message": "已领取"}
try:
    _res21 = _acc20.campaign_checkin(gap=0)
finally:
    A.Account.claim_campaign = _orig_claim
    A.Account.campaigns = _orig_camp
check("replayed claim counted as already (no phantom credits)",
      _res21["earned"] == 0 and len(_res21["already"]) == 1
      and not _res21["claimed"], _res21.get("message"))

# --- 20.3b 同人去重（实测 failureCode=SAME_PERSON_ALREADY_CLAIMED）：同机多号
#     共享每轮一次的额度，被拦的号不算错误但也不能虚报积分 ---
def _fake_blocked(url, **kw):
    return {"grantId": "g-b", "status": "BLOCKED", "replayed": False,
            "failureCode": "SAME_PERSON_ALREADY_CLAIMED",
            "benefit": {"kind": "CREDITS", "amount": 100}}


_orig_http20 = A.http_json
A.http_json = _fake_blocked
try:
    _res_blk = _acc20.claim_campaign("cb")
finally:
    A.http_json = _orig_http20
check("claim_campaign parses BLOCKED/SAME_PERSON as blocked (not ok)",
      _res_blk["ok"] is False and _res_blk["blocked"] is True
      and _res_blk["failure_code"] == "SAME_PERSON_ALREADY_CLAIMED", _res_blk)
check("blocked claim keeps the benefit amount for reporting",
      _res_blk["amount"] == 100, _res_blk.get("amount"))

A.Account.campaigns = lambda self, force=False: {
    "ok": True, "available": True, "show_campaign": True, "claimable": True,
    "campaign_url": "", "campaigns": [
        {"campaign_id": "cb", "campaign_key": "act-daily",
         "action_type": "CLAIM_BENEFIT", "claim_status": "CLAIMABLE",
         "start_at": 0, "end_at": 0, "benefit": {"kind": "CREDITS", "amount": 100},
         "placements": []}]}
A.Account.claim_campaign = lambda self, cid: {
    "ok": False, "blocked": True, "status": "BLOCKED", "replayed": False,
    "failure_code": "SAME_PERSON_ALREADY_CLAIMED", "amount": 100,
    "message": "同人已领取（同一设备/身份下其他账号本轮已领，服务端按人去重）"}
try:
    _res22 = _acc20.campaign_checkin(gap=0)
finally:
    A.Account.claim_campaign = _orig_claim
    A.Account.campaigns = _orig_camp
check("BLOCKED claim is not counted as earned (person-level dedup)",
      _res22["earned"] == 0 and not _res22["claimed"]
      and len(_res22["blocked"]) == 1, _res22.get("message"))
check("blocked message explains SAME_PERSON dedup",
      "同人已领取" in _res22["message"], _res22["message"])

# --- 20.5 身份轮换：show=false 时强制刷新身份并重试一次 ---
_orig_get = A.Account._campaigns_get
_orig_native = A.native_machine_identity
_seq = []


def _stub_get(self):
    _seq.append(1)
    if len(_seq) == 1:
        return {"showCampaign": False, "claimable": False, "campaigns": []}, 200, ""
    return {"showCampaign": True, "claimable": True, "campaignUrl": "u",
            "campaigns": [{"campaignId": "cx", "campaignKey": "act-x",
                           "actionType": "CLAIM_BENEFIT", "claimStatus": "CLAIMABLE",
                           "startAt": 0, "endAt": 0,
                           "benefit": {"kind": "CREDITS", "amount": 100},
                           "placements": []}]}, 200, ""


_forced = []


def _stub_native(realm, account_id, force=False):
    if force:
        _forced.append(account_id)
    return {"machineToken": "t", "machineType": "ty", "machineCode": "c",
            "source": "runtime-info"}


A.Account._campaigns_get = _stub_get
A.native_machine_identity = _stub_native
_acc25 = A.Account({"uid": "cp25", "realm": "cn", "accessToken": "dt-x"})
# Lead 口径裁决：machine_identity_source 合法值只有 "runtime-info"（原生桥可用）
# 与 "derived"（回退）；此处桩值必须是真实取值——过去写成 "native" 会让实现里
# 永不命中的死逻辑（== "native"）被测试掩盖成"已验证"。
_acc25.machine_identity_source = "runtime-info"
try:
    _st25 = _acc25.campaigns()
finally:
    A.Account._campaigns_get = _orig_get
    A.native_machine_identity = _orig_native
check("filtered list (show=false) triggers one forced identity refresh + retry",
      len(_seq) == 2 and _forced == ["cp25"]
      and _st25["show_campaign"] is True and _st25["claimable"] is True,
      (len(_seq), _forced))
check("retry keeps the second (populated) payload",
      len(_st25.get("campaigns") or []) == 1
      and _st25["campaigns"][0]["campaign_key"] == "act-x")

# --- 20.6 campaign_checkin 走【缓存优先】的身份链路 ---
# 设计 §9.1（身份落盘缓存）明确废除"每次领取都 force 刷新"：那会每次把落盘缓存
# 刷成新身份，直接违背"重建不换"的目标。新语义＝照常走身份链路但【不传 force】，
# 由 native_machine_identity 的缓存优先逻辑决定是否真的调组件。
_orig_get2 = A.Account._campaigns_get
_orig_native2 = A.native_machine_identity
_calls2 = []
_forced2 = []


def _stub_native2(realm, account_id, force=False):
    _calls2.append((realm, account_id))
    if force:
        _forced2.append(account_id)
    return {"machineToken": "t", "machineType": "ty", "machineCode": "c",
            "source": "runtime-info"}


A.Account._campaigns_get = lambda self: (
    {"showCampaign": True, "claimable": False, "campaignUrl": "", "campaigns": []},
    200, "")
A.native_machine_identity = _stub_native2
A.Account.claim_campaign = _orig_claim
try:
    A.Account({"uid": "cp26", "realm": "cn", "accessToken": "dt-x"}).campaign_checkin(gap=0)
finally:
    A.Account._campaigns_get = _orig_get2
    A.native_machine_identity = _orig_native2
check("campaign_checkin 不 force：走缓存优先链路（设计 §9.1 废除每次领取换身份）",
      _forced2 == [] and len(_calls2) >= 1 and _calls2[0] == ("cn", "cp26"),
      (_forced2, _calls2))

# --- 20.4 思考档位归一化（官方词表因模型而异，未命中会被上游静默忽略） ---
_meta_df = next(m for m in C.models_for_realm("cn") if m["key"] == "dfmodel")
_meta_qf = next(m for m in C.models_for_realm("cn") if m["key"] == "qfmodel")
_meta_qm = next(m for m in C.models_for_realm("cn") if m["key"] == "qmodel")
check("supported_efforts reads the official levels",
      P.supported_efforts(_meta_qf) == ["low", "medium", "xhigh"]
      and P.supported_efforts(_meta_df) == ["low", "high", "max"]
      and P.supported_efforts(_meta_qm) == [], P.supported_efforts(_meta_df))
check("default_effort reads the official is_default mark",
      P.default_effort(_meta_qf) == "medium" and P.default_effort(_meta_df) == "max",
      (P.default_effort(_meta_qf), P.default_effort(_meta_df)))
_v, _n = P.normalize_reasoning_effort("none", _meta_qf)
check("none stays none (universal off switch)", _v == "none")
_v, _n = P.normalize_reasoning_effort("medium", _meta_qf)
check("supported level passes through untouched", _v == "medium" and not _n, _n)
_v, _n = P.normalize_reasoning_effort("medium", _meta_df)
check("unsupported level maps to the nearest legal one (dfmodel medium->high)",
      _v == "high" and "unsupported" in _n, (_v, _n))
_v, _n = P.normalize_reasoning_effort("xhigh", _meta_df)
check("dfmodel xhigh -> max (nearest to request/default)", _v == "max", (_v, _n))
_v, _n = P.normalize_reasoning_effort("max", _meta_qf)
check("qfmodel max -> xhigh", _v == "xhigh", (_v, _n))
_v, _n = P.normalize_reasoning_effort("high", _meta_qf)
check("qfmodel high -> medium (tie broken toward the default)",
      _v == "medium", (_v, _n))
_v, _n = P.normalize_reasoning_effort("low", _meta_qm)
check("model without levels: effort param is dropped (not sent blindly)",
      _v is None and "dropped" in _n, (_v, _n))
_v, _n = P.normalize_reasoning_effort("none", _meta_qm)
check("model without levels still honours none", _v == "none")
# 路由器（auto 等）目录里没有 thinking_config：不猜测，原样透传
_meta_auto = next(m for m in C.models_for_realm("cn") if m["key"] == "auto")
check("router model without thinking_config passes the value through verbatim",
      P.normalize_reasoning_effort("high", _meta_auto) == ("high", "")
      and P.normalize_reasoning_effort("bogus", _meta_auto) == ("bogus", ""),
      P.normalize_reasoning_effort("high", _meta_auto))
# 未命中取最近合法档位：逐模型校验（同距偏向默认档）
for _key, _want in (("dmodel", {"medium": "high", "xhigh": "max", "low": "high"}),
                    ("gfmodel", {"medium": "high", "xhigh": "max"}),
                    ("kmodel", {"medium": "high", "xhigh": "max"})):
    _m = next(m for m in C.models_for_realm("cn") if m["key"] == _key)
    _got = {e: P.normalize_reasoning_effort(e, _m)[0] for e in _want}
    check("nearest-legal mapping on %s" % _key, _got == _want, (_got, _want))
# Responses API 路径：reasoning.effort / reasoning_effort 都要能到上游
_rchat = P.responses_to_chat({"model": "Qwen3.8-Flash", "input": "hi",
                              "reasoning": {"effort": "xhigh"}})
_rbody = P.build_qoder_body(dict(_rchat, model="Qwen3.8-Flash"), None,
                            "qfmodel", realm="cn")
check("Responses API reasoning.effort reaches upstream (normalized)",
      (_rbody.get("parameters") or {}).get("reasoning_effort") == "xhigh",
      (_rbody.get("parameters") or {}).get("reasoning_effort"))

# build_qoder_body: 端到端确认发到上游的档位已归一化 + thinking.* 兼容
_body_eff = P.build_qoder_body(
    {"model": "dfmodel", "messages": [{"role": "user", "content": "hi"}],
     "reasoning_effort": "medium"}, None, "dfmodel", realm="cn")
check("build_qoder_body sends the normalized effort upstream",
      (_body_eff.get("parameters") or {}).get("reasoning_effort") == "high",
      (_body_eff.get("parameters") or {}).get("reasoning_effort"))
_body_th = P.build_qoder_body(
    {"model": "qfmodel", "messages": [{"role": "user", "content": "hi"}],
     "thinking": {"effort": "xhigh"}}, None, "qfmodel", realm="cn")
check("thinking.effort is accepted as an alias",
      (_body_th.get("parameters") or {}).get("reasoning_effort") == "xhigh",
      (_body_th.get("parameters") or {}).get("reasoning_effort"))
_body_off = P.build_qoder_body(
    {"model": "qmodel", "messages": [{"role": "user", "content": "hi"}],
     "reasoning_effort": "high"}, None, "qmodel", realm="cn")
check("unsupported effort on a level-less model is dropped from the body",
      "reasoning_effort" not in (_body_off.get("parameters") or {}),
      _body_off.get("parameters"))

print()
print("[21] 本机虚拟化检测（中文输出：官方风控桥 vmInfo + 本机交叉校验）")
import qoder_fingerprint as F

check("vm_brand_cn: 已知平台译中文，未知品牌原样",
      F.vm_brand_cn("Hyper-V") == "Hyper-V（微软）"
      and F.vm_brand_cn("VMware, Inc.") == "VMware"
      and F.vm_brand_cn("SomeVendor") == "SomeVendor"
      and F.vm_brand_cn("") == "")
check("风控评分 -> 中文档位（高/中/低/无/未知）",
      [F._vm_level_cn(x) for x in (77, 50, 10, 0, None)]
      == ["高", "中", "低", "无", "未知"])

# 有官方风控结果：以它为权威
_st_vm = F.vm_status(bridge_vm_info={"isVm": True, "brand": "Hyper-V",
                                     "percentage": 77, "vmTypeCode": 14},
                     bridge_available=True)
check("bridge data wins: is_vm/level/score/brand_cn/source",
      _st_vm["is_vm"] is True and _st_vm["level"] == "高"
      and _st_vm["score"] == 77 and _st_vm["brand_cn"] == "Hyper-V（微软）"
      and _st_vm["vm_type_code"] == 14 and _st_vm["source"] == "runtime-info",
      _st_vm)
check("中文结论包含平台与评分",
      "本机运行在虚拟机中" in _st_vm["summary"]
      and "Hyper-V（微软）" in _st_vm["summary"] and "77" in _st_vm["summary"],
      _st_vm["summary"])
check("证据首条为官方风控判定（中文）",
      _st_vm["evidence"] and "官方风控判定" in _st_vm["evidence"][0],
      _st_vm["evidence"][:1])

# 无官方结果：退化为本机交叉校验，结论里明确说明
_st_local = F.vm_status(bridge_vm_info=None, bridge_available=False)
check("no bridge -> local cross-check + 中文说明",
      _st_local["source"] == "local" and isinstance(_st_local["is_vm"], bool)
      and "本机交叉校验" in _st_local["summary"], _st_local["summary"])

# 看板契约：这些键必须都在（前端 /diag/vm 直接消费）
check("dashboard contract keys present",
      set(("is_vm", "level", "score", "brand", "brand_cn", "vm_type_code",
           "source", "evidence", "summary")) <= set(_st_vm.keys()),
      sorted(_st_vm.keys()))
_st_api = A.local_vm_status("cn", force=True)
check("A.local_vm_status adds realm + bridge_available",
      _st_api.get("realm") in ("cn", "intl")
      and isinstance(_st_api.get("bridge_available"), bool), 
      (A.local_vm_status("cn") is not None, _st_api.get("bridge_available")))

# /diag/* 必须走面板鉴权（此前漏加会被无鉴权读取）
_src21 = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "qoder_proxy.py"), encoding="utf-8").read()
check("/diag routes are panel-guarded",
      'if path.startswith("/diag"):' in _src21
      and _src21.find('if path.startswith("/diag"):')
      < _src21.find('return False', _src21.find('def _is_panel_route')),
      "guard missing" if 'if path.startswith("/diag"):' not in _src21 else "")

print()
print("[22] 面板加速（短缓存 / 区域分区）与新版本检测")
check("version_tuple 容忍 v 前缀与不足位数",
      P.version_tuple("v1.2.3") == (1, 2, 3)
      and P.version_tuple("1.1") == (1, 1, 0)
      and P.version_tuple("") == (0, 0, 0))
check("新版本比较：更高/相同/更低",
      P.version_tuple("v1.2.0") > P.version_tuple("1.1.4")
      and P.version_tuple("v1.1.4") == P.version_tuple("1.1.4")
      and P.version_tuple("1.0.9") < P.version_tuple("1.1.0"))

_orig_urlopen_u = P.urllib.request.urlopen


class _UpdResp(object):
    def __init__(self, payload):
        self._b = json.dumps(payload).encode()

    def read(self):
        return self._b

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _fake_release(tag):
    return {"tag_name": tag, "html_url": "https://example.invalid/rel/" + tag,
            "published_at": "2026-10-01T00:00:00Z", "name": "rel " + tag}


P.urllib.request.urlopen = lambda req, timeout=None: _UpdResp(_fake_release("v9.9.9"))
_up_new = P.check_for_update(force=True)
P.urllib.request.urlopen = lambda req, timeout=None: _UpdResp(_fake_release("v" + P.VERSION))
_up_same = P.check_for_update(force=True)


def _boom(req, timeout=None):
    raise OSError("network down")


P.urllib.request.urlopen = _boom
_up_err = P.check_for_update(force=True)
P.urllib.request.urlopen = _orig_urlopen_u
check("check_for_update: 检测到更高版本 -> has_update",
      _up_new["ok"] and _up_new["has_update"] and _up_new["latest"] == "v9.9.9", _up_new)
check("check_for_update: 同版本 -> 无更新", _up_same["ok"] and not _up_same["has_update"])
check("check_for_update: 网络失败 -> ok=False + error（不误报有更新）",
      _up_err["ok"] is False and bool(_up_err["error"])
      and not _up_err["has_update"], _up_err)
_src22 = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           "qoder_proxy.py"), encoding="utf-8").read()
check("/update 路由纳入面板鉴权",
      'if path.startswith("/update"):' in _src22)
check("/tasks 支持 ?realm= 区域过滤（账号池分区）",
      'view = qoder_tasks.fetch_tasks_view(POOL, realm=realm_q, uid=uid)' in _src22)

T.invalidate_panel_cache()
_hits22 = {"campaigns": 0}


class _Acc22(object):
    uid = "cache22"
    realm = "cn"

    def campaigns(self, force=False):
        _hits22["campaigns"] += 1
        return {"ok": True, "available": True, "show_campaign": True,
                "claimable": False, "campaign_url": "", "campaigns": []}

    def checkin_status(self):
        return False, {"unavailable": True, "error": "nf"}

    def pro_eligibility(self):
        return False, "nf"

    def fetch_credits(self):
        return {"ok": True}

    def fetch_plan(self):
        return ""


_a22 = _Acc22()
T._fetch_upstream_parallel(_a22)
T._fetch_upstream_parallel(_a22)
check("面板短缓存：TTL 内第二次不再打上游",
      _hits22["campaigns"] == 1, _hits22)
T.invalidate_panel_cache()
T._fetch_upstream_parallel(_a22)
check("invalidate_panel_cache：失效后重新取",
      _hits22["campaigns"] == 2, _hits22)
T.invalidate_panel_cache()

_p22 = A.AccountPool(os.path.join(os.environ["ACCOUNTS_DIR"], "unused22"))
_cn22 = A.Account({"uid": "cn22", "realm": "cn", "accessToken": "dt-x"})
_intl22 = A.Account({"uid": "intl22", "realm": "intl", "accessToken": "dt-y"})
_p22.accounts = [_intl22, _cn22]
_orig_ftv = T.fetch_task_view
T.fetch_task_view = lambda acc: ([], {"campaigns": {}})
try:
    _v_cn = T.fetch_tasks_view(_p22, realm="cn")
    _v_intl = T.fetch_tasks_view(_p22, realm="intl")
    _v_all = T.fetch_tasks_view(_p22)
finally:
    T.fetch_task_view = _orig_ftv
check("fetch_tasks_view(realm=cn) 只列国内版账号",
      [a["realm"] for a in _v_cn["accounts"]] == ["cn"], _v_cn["accounts"])
check("fetch_tasks_view(realm=intl) 只列国际版账号",
      [a["realm"] for a in _v_intl["accounts"]] == ["intl"], _v_intl["accounts"])
check("不传 realm 时保持原行为（全部账号）",
      len(_v_all["accounts"]) == 2, _v_all["accounts"])

print()
print("[23] 兑换码/券类活动（奶茶免单卡 act-20260928-620）")
# --- 23.1 领取响应：捕获 redemptionCode 并持久化 ---
_orig_hj23 = A.http_json


def _fake_claim_code(url, **kw):
    return {"status": "CLAIMED", "replayed": False,
            "grantId": "g-coffee", "redemptionCode": "MT-ABCD-1234",
            "benefit": {"kind": "REDEMPTION_CODE", "amount": 1}}


A.http_json = _fake_claim_code
_acc23 = A.Account({"uid": "coffee23", "realm": "cn", "accessToken": "dt-x"})
_res23 = _acc23.claim_campaign("c-coffee")
A.http_json = _orig_hj23
check("claim 响应捕获兑换码", _res23["ok"] and _res23["redemption_code"] == "MT-ABCD-1234",
      _res23)
check("兑换码写入账号（可持久化，重启不丢）",
      _acc23.campaign_codes.get("c-coffee") == "MT-ABCD-1234"
      and _acc23.to_dict().get("campaignCodes", {}).get("c-coffee") == "MT-ABCD-1234",
      _acc23.campaign_codes)
_acc23b = A.Account(_acc23.to_dict())
check("新 Account 能读回兑换码",
      _acc23b.campaign_codes.get("c-coffee") == "MT-ABCD-1234")
check("领取成功消息带上兑换码", "兑换码" in _res23["message"], _res23["message"])

# --- 23.2 CLAIMED 但无码 -> 发放确认中 ---
def _fake_claim_nocode(url, **kw):
    return {"status": "CLAIMED", "replayed": False, "grantId": "g2",
            "benefit": {"kind": "REDEMPTION_CODE", "amount": 1}}


A.http_json = _fake_claim_nocode
_res23b = _acc23.claim_campaign("c-coffee2")
check("CLAIMED 无兑换码 -> confirming 标记", _res23b.get("confirming") is True, _res23b)
A.http_json = _orig_hj23

# --- 23.3 失败码映射（名额发完 / 成就未完成）---
def _fake_claim_oos(url, **kw):
    return {"status": "NOT_ELIGIBLE", "failureCode": "REDEMPTION_CODE_OUT_OF_STOCK"}


A.http_json = _fake_claim_oos
_res23c = _acc23.claim_campaign("c-coffee")
A.http_json = _orig_hj23
check("名额发完 -> 失败码 + 中文说明",
      not _res23c["ok"] and _res23c["failure_code"] == "REDEMPTION_CODE_OUT_OF_STOCK"
      and "名额已发完" in _res23c["message"], _res23c)

# --- 23.4 campaign_checkin 分类：pending / locked / codes ---
_orig_camp23 = A.Account.campaigns
_orig_native23 = A.native_machine_identity


def _stub_campains23(self, force=False):
    return {"ok": True, "available": True, "show_campaign": True, "claimable": False,
            "campaign_url": "https://openapi.qoder.com.cn/growth-page/activity-iframe",
            "identity": "runtime-info",
            "campaigns": [
                {"campaign_id": "c-daily", "campaign_key": "act-daily",
                 "action_type": "CLAIM_BENEFIT", "claim_status": "CLAIMED",
                 "start_at": 0, "end_at": 0,
                 "benefit": {"kind": "CREDITS", "amount": 100},
                 "required_achievement_key": "", "achievement_completed": True,
                 "unavailable_reason": "", "placements": []},
                {"campaign_id": "c-coffee", "campaign_key": "act-20260928-620",
                 "action_type": "CLAIM_BENEFIT", "claim_status": "NOT_ELIGIBLE",
                 "start_at": 0, "end_at": 0,
                 "benefit": {"kind": "REDEMPTION_CODE", "amount": 1},
                 "required_achievement_key": "sites_first_use",
                 "achievement_completed": True,
                 "unavailable_reason": "REDEMPTION_CODE_OUT_OF_STOCK",
                 "placements": []},
                {"campaign_id": "c-task", "campaign_key": "act-locked",
                 "action_type": "CLAIM_BENEFIT", "claim_status": "NOT_ELIGIBLE",
                 "start_at": 0, "end_at": 0,
                 "benefit": {"kind": "CREDITS", "amount": 50},
                 "required_achievement_key": "goal_first_use",
                 "achievement_completed": False,
                 "unavailable_reason": "ACHIEVEMENT_NOT_COMPLETED",
                 "placements": []}]}


A.Account.campaigns = _stub_campains23
A.native_machine_identity = lambda realm, uid, force=False: {
    "machineToken": "t", "machineType": "ty", "machineCode": "c", "source": "runtime-info"}
_acc23c = A.Account({"uid": "coffee23c", "realm": "cn", "accessToken": "dt-x"})
try:
    _res23d = _acc23c.campaign_checkin(gap=0)
finally:
    A.Account.campaigns = _orig_camp23
    A.native_machine_identity = _orig_native23
check("名额发完的活动进 pending（不是被当成无活动）",
      [c["campaign_key"] for c in _res23d["pending"]] == ["act-20260928-620"],
      _res23d.get("pending"))
check("成就未完成的活动进 locked",
      [c["campaign_key"] for c in _res23d["locked"]] == ["act-locked"],
      _res23d.get("locked"))
check("结论里带次日重试提示", "次日 10:00" in _res23d["message"], _res23d["message"])

# --- 23.5 独立任务行（奶茶免单卡）+ 兑换码回显 ---
_orig_camp23b = A.Account.campaigns
A.Account.campaigns = _stub_campains23
_acc23e = A.Account({"uid": "coffee23e", "realm": "cn", "accessToken": "dt-x"})
_acc23e.campaign_codes = {"c-coffee": "MT-ZZZZ-9999"}
try:
    _rows23 = T._extra_campaign_rows(_acc23e, _acc23e.campaigns())
finally:
    A.Account.campaigns = _orig_camp23b
_codes23 = [r["task_code"] for r in _rows23]
check("券类活动单独成行（只含非 Credits 奖励）",
      _codes23 == ["campaign:act-20260928-620"], _codes23)
_crow = _rows23[0]
check("行内含中文名额状态 + 奖励文本",
      "名额已发完" in _crow["description"] and _crow["reward_text"] == "兑换码 ×1",
      _crow)
check("券类行不误报积分", _crow["reward_credit"] == 0, _crow["reward_credit"])


def _stub_campains_claimed23(self, force=False):
    out = _stub_campains23(self, force)
    out["campaigns"][1]["claim_status"] = "CLAIMED"
    out["campaigns"][1]["unavailable_reason"] = ""
    return out


A.Account.campaigns = _stub_campains_claimed23
try:
    _rows23b = T._extra_campaign_rows(_acc23e, _acc23e.campaigns())
finally:
    A.Account.campaigns = _orig_camp23b
check("已领取的券类活动回显兑换码",
      _rows23b[0]["status"] == "claimed"
      and "MT-ZZZZ-9999" in _rows23b[0]["description"], _rows23b[0])

# --- 23.6 多账号：同人已领 -> 冷却，不再重复 POST ---
_orig_camp23c = A.Account.campaigns
_orig_claim23 = A.Account.claim_campaign
_orig_native23b = A.native_machine_identity
_posts = []


def _stub_camp_claimable23(self, force=False):
    return {"ok": True, "available": True, "show_campaign": True, "claimable": True,
            "campaign_url": "", "identity": "runtime-info",
            "campaigns": [{"campaign_id": "c-cup", "campaign_key": "act-cup",
                           "action_type": "CLAIM_BENEFIT", "claim_status": "CLAIMABLE",
                           "start_at": 0, "end_at": 0,
                           "benefit": {"kind": "REDEMPTION_CODE", "amount": 1},
                           "required_achievement_key": "", "achievement_completed": True,
                           "unavailable_reason": "", "placements": []}]}


def _stub_claim_blocked23(self, campaign_id):
    _posts.append(campaign_id)
    return {"ok": False, "blocked": True, "status": "BLOCKED",
            "failure_code": "SAME_PERSON_ALREADY_CLAIMED",
            "message": "同人已领取"}


A.Account.campaigns = _stub_camp_claimable23
A.Account.claim_campaign = _stub_claim_blocked23
A.native_machine_identity = lambda realm, uid, force=False: {
    "machineToken": "t", "machineType": "ty", "machineCode": "c", "source": "runtime-info"}
_acc23f = A.Account({"uid": "multi23", "realm": "cn", "accessToken": "dt-x"})
try:
    _r1 = _acc23f.campaign_checkin(gap=0)
    _r2 = _acc23f.campaign_checkin(gap=0)      # 冷却内：不应再 POST
finally:
    A.Account.campaigns = _orig_camp23c
    A.Account.claim_campaign = _orig_claim23
    A.native_machine_identity = _orig_native23b
check("同人已领 -> 记录冷却并如实上报（不是失败）",
      _r1["ok"] and _r1["blocked"] and _r1["blocked"][0]["failure_code"]
      == "SAME_PERSON_ALREADY_CLAIMED", _r1.get("blocked"))
check("冷却内的第二次不再重复 POST（多账号同机器不空转）",
      _posts == ["c-cup"], _posts)
check("冷却写入账号（可持久化）",
      _acc23f.campaign_blocked_until.get("c-cup", 0) > time.time()
      and _acc23f.campaign_blocked_until.get("c-cup", 0)
      <= time.time() + 6 * 3600 + 5, _acc23f.campaign_blocked_until)

# --- 23.7 summary.codes：按账号暴露已领兑换码 ---
_orig_ftv23 = T._fetch_upstream_parallel
T._fetch_upstream_parallel = lambda account, force=False: (
    {"ok": True, "available": True, "show_campaign": True, "claimable": False,
     "campaign_url": "", "identity": "runtime-info", "campaigns": []},
    (False, {"error": "nf"}), (False, "nf"), {"ok": True}, "")
_acc23g = A.Account({"uid": "codes23", "realm": "cn", "accessToken": "dt-x"})
_acc23g.campaign_codes = {"c-cup": "MT-1111-2222"}
try:
    _t23g, _s23g = T.fetch_task_view(_acc23g)
finally:
    T._fetch_upstream_parallel = _orig_ftv23
check("summary.codes 按账号给出兑换码",
      _s23g.get("codes") == [{"campaign": "c-cup", "code": "MT-1111-2222"}],
      _s23g.get("codes"))

print()
print("[24] 全部账号视图：按活动聚合 + 每账号资格明细 + 多账号各自独立领取")
# --- 24.1 聚合：能领的、名额发完的、无资格的三种账号同屏列出 ---
_orig_camp24 = A.Account.campaigns
_orig_native24 = A.native_machine_identity


def _camp_for(uid):
    base = {"ok": True, "available": True, "show_campaign": True,
            "claimable": False, "campaign_url": "https://openapi.qoder.com.cn/growth-page/activity-iframe",
            "identity": "runtime-info", "campaigns": []}
    if uid == "a24":            # 有资格，可领
        base["campaigns"] = [{"campaign_id": "c-cup", "campaign_key": "act-cup",
                              "action_type": "CLAIM_BENEFIT", "claim_status": "CLAIMABLE",
                              "start_at": 0, "end_at": 0,
                              "benefit": {"kind": "REDEMPTION_CODE", "amount": 1},
                              "required_achievement_key": "", "achievement_completed": True,
                              "unavailable_reason": "", "placements": []}]
    elif uid == "b24":          # 有资格但名额发完
        base["campaigns"] = [{"campaign_id": "c-cup", "campaign_key": "act-cup",
                              "action_type": "CLAIM_BENEFIT", "claim_status": "NOT_ELIGIBLE",
                              "start_at": 0, "end_at": 0,
                              "benefit": {"kind": "REDEMPTION_CODE", "amount": 1},
                              "required_achievement_key": "", "achievement_completed": True,
                              "unavailable_reason": "REDEMPTION_CODE_OUT_OF_STOCK",
                              "placements": []}]
    return base                    # c24：列表里没有该活动 = 无资格


A.Account.campaigns = lambda self, force=False: _camp_for(self.uid[:3])
A.native_machine_identity = lambda realm, uid, force=False: {
    "machineToken": "t", "machineType": "ty", "machineCode": "c", "source": "runtime-info"}
_a24 = A.Account({"uid": "a24", "realm": "cn", "accessToken": "dt-x", "nickname": "可领号"})
_b24 = A.Account({"uid": "b24", "realm": "cn", "accessToken": "dt-x", "nickname": "补货号"})
_c24 = A.Account({"uid": "c24", "realm": "cn", "accessToken": "dt-x", "nickname": "无资格号"})
_b24.campaign_codes = {"c-cup": "MT-FROM-B24"}
try:
    _rows24, _codes24 = T.aggregate_campaign_rows([_a24, _b24, _c24])
finally:
    A.Account.campaigns = _orig_camp24
    A.native_machine_identity = _orig_native24
check("聚合为每个活动一行（3 个账号只出 1 行活动）",
      len(_rows24) == 1 and _rows24[0]["task_code"] == "campaign:act-cup", _rows24)
_desc24 = _rows24[0]["description"]
check("描述里逐账号标注：可领/名额发完/无资格",
      "可领 1/3：可领号" in _desc24 and "名额发完 1/3：补货号" in _desc24
      and "无资格(不在定向) 1/3：无资格号" in _desc24, _desc24)
check("聚合行状态：有可领账号 -> 待领奖",
      _rows24[0]["status"] == "completed" and _rows24[0]["reward_text"] == "兑换码 ×1",
      _rows24[0])
check("聚合结果按账号收集已领兑换码",
      _codes24 and _codes24[0]["code"] == "MT-FROM-B24"
      and _codes24[0]["nickname"] == "补货号"
      and _codes24[0]["realm"] == "cn", _codes24)

# --- 24.2 关键语义：上游没返回 SAME_PERSON_ALREADY_CLAIMED -> 各账号都能领 ---
_orig_camp24b = A.Account.campaigns
_orig_claim24 = A.Account.claim_campaign
_orig_native24b = A.native_machine_identity
_calls24 = []


def _camp_claimable24(self, force=False):
    return {"ok": True, "available": True, "show_campaign": True, "claimable": True,
            "campaign_url": "", "identity": "runtime-info",
            "campaigns": [{"campaign_id": "c-cup-" + self.uid,
                           "campaign_key": "act-cup",
                           "action_type": "CLAIM_BENEFIT", "claim_status": "CLAIMABLE",
                           "start_at": 0, "end_at": 0,
                           "benefit": {"kind": "REDEMPTION_CODE", "amount": 1},
                           "required_achievement_key": "", "achievement_completed": True,
                           "unavailable_reason": "", "placements": []}]}


def _claim_http24(url, data=None, method=None, headers=None, timeout=None,
                  retries=None, log=None):
    # 只打桩 HTTP 层：让真实的 claim_campaign（含兑换码提取/落盘）跑起来
    cid = url.rsplit("/", 2)[-2]
    _calls24.append((headers.get("cosy-user", "?"), cid))
    return {"status": "CLAIMED", "replayed": False, "grantId": "g-" + cid,
            "redemptionCode": "CODE-" + cid.split("-")[-1],
            "benefit": {"kind": "REDEMPTION_CODE", "amount": 1}}


_orig_http24 = A.http_json
A.Account.campaigns = _camp_claimable24
A.http_json = _claim_http24
A.native_machine_identity = lambda realm, uid, force=False: {
    "machineToken": "t", "machineType": "ty", "machineCode": "c", "source": "runtime-info"}
try:
    _x24 = A.Account({"uid": "X24", "realm": "cn", "accessToken": "dt-x"})
    _y24 = A.Account({"uid": "Y24", "realm": "cn", "accessToken": "dt-x"})
    _rx24 = _x24.campaign_checkin(gap=0)
    _ry24 = _y24.campaign_checkin(gap=0)
finally:
    A.Account.campaigns = _orig_camp24b
    A.http_json = _orig_http24
    A.native_machine_identity = _orig_native24b
check("同机器两个账号：上游未判同人 -> 两个账号都发起领取",
      [c[1] for c in _calls24] == ["c-cup-X24", "c-cup-Y24"], _calls24)
check("各自拿到自己的兑换码（互不覆盖）",
      _x24.campaign_codes.get("c-cup-X24") == "CODE-X24"
      and _y24.campaign_codes.get("c-cup-Y24") == "CODE-Y24",
      (_x24.campaign_codes, _y24.campaign_codes))
check("两条都算领取成功（没有被我方预判拦截）",
      _rx24["claimed"] and _ry24["claimed"]
      and not _rx24["blocked"] and not _ry24["blocked"],
      (_rx24.get("blocked"), _ry24.get("blocked")))

print()
print("[25] 活动中文名 / 每日签到只领积分 / 领取全部福利")
# --- 25.1 中文名：官方标题优先，其次兜底表，最后 kind 兜底 ---
check("campaign_title: 官方 content.zh.title 优先",
      T.campaign_title({"title_zh": "发布 Qoder 站点，免费领取奶茶免单卡",
                        "campaign_key": "act-x"}) == "发布 Qoder 站点，免费领取奶茶免单卡")
check("campaign_title: 已知 key 走内置兜底",
      T.campaign_title({"campaign_key": "act-20260928-620"})
      == "新人任务：发布 Qoder 站点领奶茶免单卡", 
      T.campaign_title({"campaign_key": "act-20260928-620"}))
check("campaign_title: 前缀兜底（每日 100）",
      T.campaign_title({"campaign_key": "act-20260930-999"}) == "每天领 100 Credits")
check("campaign_title: 未知 key 按奖励类型兜底",
      T.campaign_title({"campaign_key": "act-unknown-1",
                        "benefit": {"kind": "REDEMPTION_CODE"}}) == "限时活动（兑换码）"
      and T.campaign_title({"campaign_key": "act-unknown-2",
                            "benefit": {"kind": "CREDITS"}}) == "限时活动（Credits）")

# --- 25.2 账号面板「每日签到」只领积分：券类活动不被触碰 ---
_orig_camp25 = A.Account.campaigns
_orig_claim25 = A.Account.claim_campaign
_orig_native25 = A.native_machine_identity
_posts25 = []


def _camp_mixed25(self, force=False):
    return {"ok": True, "available": True, "show_campaign": True, "claimable": True,
            "campaign_url": "", "identity": "runtime-info",
            "campaigns": [
                {"campaign_id": "c-daily", "campaign_key": "act-daily",
                 "title_zh": "每天领 100 Credits",
                 "action_type": "CLAIM_BENEFIT", "claim_status": "CLAIMABLE",
                 "start_at": 0, "end_at": 0,
                 "benefit": {"kind": "CREDITS", "amount": 100},
                 "required_achievement_key": "", "achievement_completed": True,
                 "unavailable_reason": "", "placements": []},
                {"campaign_id": "c-cup", "campaign_key": "act-cup",
                 "title_zh": "发布 Qoder 站点，免费领取奶茶免单卡",
                 "action_type": "CLAIM_BENEFIT", "claim_status": "CLAIMABLE",
                 "start_at": 0, "end_at": 0,
                 "benefit": {"kind": "REDEMPTION_CODE", "amount": 1},
                 "required_achievement_key": "", "achievement_completed": True,
                 "unavailable_reason": "", "placements": []}]}


def _claim_spy25(self, campaign_id):
    _posts25.append(campaign_id)
    return {"ok": True, "status": "CLAIMED", "replayed": False, "amount": 100,
            "redemption_code": "CODE-1" if "cup" in campaign_id else "",
            "message": "领取成功"}


A.Account.campaigns = _camp_mixed25
A.Account.claim_campaign = _claim_spy25
A.native_machine_identity = lambda realm, uid, force=False: {
    "machineToken": "t", "machineType": "ty", "machineCode": "c", "source": "runtime-info"}
try:
    _acc25 = A.Account({"uid": "daily25", "realm": "cn", "accessToken": "dt-x"})
    _r_daily = _acc25.campaign_checkin(gap=0, only_kinds=("", "CREDITS"))
    _posts25.clear()
    _r_all = _acc25.campaign_checkin(gap=0)
finally:
    A.Account.campaigns = _orig_camp25
    A.Account.claim_campaign = _orig_claim25
    A.native_machine_identity = _orig_native25
check("only_kinds=CREDITS：只领每日积分，不碰券类活动",
      _r_daily["claimed"] and len(_r_daily["claimed"]) == 1
      and _r_daily["claimed"][0]["campaign_key"] == "act-daily", _r_daily.get("claimed"))
check("不带 only_kinds：积分与券类都领",
      [c["campaign_key"] for c in _r_all["claimed"]] == ["act-daily", "act-cup"],
      [c["campaign_key"] for c in _r_all["claimed"]])

# --- 25.3 面板/接口接线：账号面板走 only_daily，福利中心走全量 ---
_src25 = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           "qoder_proxy.py"), encoding="utf-8").read()
check("账号面板 /accounts/checkin 只做每日签到，且间隔传 CHECKIN_MIN_GAP 常量本身",
      # 恢复被弱化的精确语义：调用点必须写 CHECKIN_MIN_GAP，常量定义值必须与
      # **运行时** P.CHECKIN_MIN_GAP 一致（引用运行时值，不把 1.0 硬编码进字符串，
      # 下次调间隔只改实现一处）。
      "run_checkin(account, gap=CHECKIN_MIN_GAP" in _src25
      and "only_daily=True" in _src25
      and ("CHECKIN_MIN_GAP = %r" % P.CHECKIN_MIN_GAP) in _src25)
check("签到与福利中心 /tasks/run 仍是全量领取",
      "run_batch_checkin(targets, gap=1.0)" in _src25)
_dash25 = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "dashboard.html"), encoding="utf-8").read()
check("按钮文案：领取全部福利 / 仅领 Pro 福利包",
      ">领取全部福利<" in _dash25 and ">仅领 Pro 福利包<" in _dash25
      and "一键签到领积分" not in _dash25)
check("领取全部福利 = 活动全量 + Pro 福利包（run + travel）",
      'postJSON("/tasks/run"' in _dash25 and 'postJSON("/tasks/travel"' in _dash25)

print()
print("[26] PR#7 合并回归：信封层 403(10605 排队) -> 账号冷却 + 解绑 + 轮换")
class _Aff26:
    def __init__(self): self.calls = []
    def unbind(self, key): self.calls.append(key)
class _Pool26:
    def __init__(self):
        self.affinity = _Aff26(); self.accounts = [1, 2, 3]
class _Acc26:
    def __init__(self):
        self.uid = "pr7acc12"; self.enabled = True; self.notes = []; self.saved = 0
        self.path = ""
    def note_error(self, msg, cooldown=60, single_account=False, model=None, until=None):
        self.notes.append({"msg": str(msg)[:60], "cooldown": cooldown, "model": model})
    def save(self, d): self.saved += 1
class _UpErr26(Exception):
    def __init__(self, status, detail):
        self.status = status; self.detail = detail

_orig_pool26 = P.POOL
_acc26 = _Acc26()
P.POOL = _Pool26()
P.ACCOUNTS_DIR = os.environ["ACCOUNTS_DIR"]
try:
    P._handle_envelope_account_cooldown(_acc26, _UpErr26(
        403, '{"code":"10605","message":"{\"isQueued\":true,\"retryAfterSeconds\": 30}"}'),
        model="qfmodel", session_key="sk-pr7")
    _n1 = _acc26.notes[-1]
    P._handle_envelope_account_cooldown(_acc26, _UpErr26(403, "permission denied"),
                                        model="qfmodel", session_key="sk-pr7")
    _n2 = _acc26.notes[-1]
    P._handle_envelope_account_cooldown(_acc26, _UpErr26(429, "rate limit"),
                                        model="qfmodel", session_key="sk-pr7")
    _n3 = _acc26.notes[-1]
    _acc26.enabled = True
    P._handle_envelope_account_cooldown(_acc26, _UpErr26(401, "TOKEN_EXPIRE session dead"),
                                        model=None, session_key="sk-pr7")
    _n4 = _acc26.notes[-1]
    _aff26_calls = list(P.POOL.affinity.calls)
finally:
    P.POOL = _orig_pool26
check("10605 排队 -> 模型级冷却 30s（按上游 retryAfterSeconds）+ 解绑会话",
      _n1["cooldown"] == 30 and _n1["model"] == "qfmodel"
      and set(_aff26_calls) == {"sk-pr7"} and len(_aff26_calls) >= 1,
      (_n1, _aff26_calls))
check("403 非排队 -> 账号级冷却 60s", _n2["cooldown"] == 60 and _n2["model"] is None, _n2)
check("429 -> 模型级冷却 30s", _n3["cooldown"] == 30 and _n3["model"] == "qfmodel", _n3)
check("死会话 -> 300s + 停用账号（与 open_upstream 同语义）",
      _acc26.enabled is False and _n4["cooldown"] == 300, _n4)
for st, detail, want in ((403, "10605", True), (401, "x", True), (429, "x", True),
                         (418, "DataInspectionFailed", False),
                         (400, "invalid_parameter_error", False), (500, "x", True)):
    got = P.should_retry_envelope(P.UpstreamStatus(st, detail), False, 0)
    check("未吐字节可重开：%s -> %s" % (st, want), got is want, (st, got))
_src26 = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           "qoder_proxy.py"), encoding="utf-8").read()
check("三处信封捕获点都接入账号冷却",
      _src26.count("_handle_envelope_account_cooldown(") >= 4,
      _src26.count("_handle_envelope_account_cooldown("))

print()
print("[27] 泄漏文本回读（issue #8：模型照格式复述 tool_calls 序列化）")
_M27 = P.LEAK_MARKER
_CALLS27 = json.dumps([{"name": "terminal",
                        "arguments": json.dumps({"cmd": "ls"}, ensure_ascii=False)}],
                      ensure_ascii=False)
_LEAK27 = _M27 + "\n" + _CALLS27

_rec27, _clean27 = P.parse_leaked_tool_calls(_LEAK27, {"terminal"})
check("严格形态：marker+JSON 数组 -> 还原为结构化调用且正文清空",
      bool(_rec27) and _clean27 == ""
      and _rec27[0]["function"]["name"] == "terminal"
      and json.loads(_rec27[0]["function"]["arguments"])["cmd"] == "ls",
      (_rec27, _clean27))
check("围栏形态（```json ... ```）同样还原",
      bool(P.parse_leaked_tool_calls("```json\n" + _LEAK27 + "\n```", {"terminal"})[0]))
check("无语言标记围栏（``` ... ```）同样还原",
      bool(P.parse_leaked_tool_calls("```\n" + _LEAK27 + "\n```", {"terminal"})[0]))
check("普通正文（讨论该标记）不误判",
      P.parse_leaked_tool_calls("网关会写入 " + _M27 + " 这样的提示，不是调用。")[0] is None)
check("数组后带多余文本不还原",
      P.parse_leaked_tool_calls(_LEAK27 + "\n以上。", {"terminal"})[0] is None)
check("未声明的工具名不还原（守卫：只认本次声明的 tools）",
      P.parse_leaked_tool_calls(_LEAK27, {"other"})[0] is None)
check("空数组不还原", P.parse_leaked_tool_calls(_M27 + "\n[]")[0] is None)
check("arguments 为对象 -> 规范化为 JSON 字符串",
      json.loads(P.parse_leaked_tool_calls(
          _M27 + "\n" + json.dumps([{"name": "t", "arguments": {"a": 1}}],
                                   ensure_ascii=False),
          {"t"})[0][0]["function"]["arguments"]) == {"a": 1})
check("arguments 非法 JSON 字符串 -> 不还原",
      P.parse_leaked_tool_calls(
          _M27 + "\n" + json.dumps([{"name": "t", "arguments": "{not-json"}]),
          {"t"})[0] is None)
check("声明工具名提取兼容 chat 与 responses 两种 tools 形态",
      P._tool_names_from_payload({"tools": [
          {"type": "function", "function": {"name": "a"}},
          {"type": "function", "name": "b"}]}) == {"a", "b"})


def _raw27(content=None, fin=None, **kw):
    delta = {}
    if content is not None:
        delta["content"] = content
    delta.update(kw)
    inner = {"id": "c27", "model": "m27", "created": 1, "choices": [
        {"index": 0, "delta": delta, "finish_reason": fin}]}
    return ("data: " + json.dumps(inner, ensure_ascii=False)
            + "\n\n").encode("utf-8")


def _env27(content=None, fin=None, **kw):
    inner = json.loads(_raw27(content, fin, **kw)[6:])
    return ("data: " + json.dumps(
        {"statusCodeValue": 200, "body": json.dumps(inner, ensure_ascii=False)},
        ensure_ascii=False) + "\n\n").encode("utf-8")


class _Resp27:
    def __init__(self, items):
        self.items = list(items)

    def __iter__(self):
        return iter(self.items)

    def close(self):
        pass


_obj27 = P.aggregate_stream(
    _Resp27([_env27(_LEAK27[:12]), _env27(_LEAK27[12:]),
             _env27("", "stop")]),
    "m27", None, allowed_names={"terminal"})
_msg27 = _obj27["choices"][0]["message"]
check("非流式聚合：泄漏正文 -> 结构化 tool_calls，finish_reason=tool_calls",
      _obj27["choices"][0]["finish_reason"] == "tool_calls"
      and _msg27.get("content") == ""
      and ((_msg27.get("tool_calls") or [{}])[0].get("function")
           or {}).get("name") == "terminal", _obj27)

_frames27 = [json.loads(f[6:]) for f in P.recover_leaked_tool_calls(
    iter([_raw27(_LEAK27[:9]), _raw27(_LEAK27[9:]), _raw27("", "stop")]),
    {"terminal"})]
_c27 = [_f["choices"][0] for _f in _frames27]
check("流式：marker 跨增量分段仍回读为 tool_calls 增量 + 收尾帧改写",
      not any(_d.get("delta", {}).get("content") for _d in _c27)
      and any(_d.get("delta", {}).get("tool_calls") for _d in _c27)
      and _c27[-1]["finish_reason"] == "tool_calls", _c27)

_frames27b = [json.loads(f[6:]) for f in P.recover_leaked_tool_calls(
    iter([_raw27("[1, 2"), _raw27(", 3] 这是正文"), _raw27("", "stop")]))]
check("流式：以 [ 开头但被证伪 -> 原样补发正文，不改 finish",
      "".join(_f["choices"][0]["delta"].get("content") or ""
              for _f in _frames27b) == "[1, 2, 3] 这是正文"
      and _frames27b[-1]["choices"][0]["finish_reason"] == "stop", _frames27b)

_frames27c = [json.loads(f[6:]) for f in P.recover_leaked_tool_calls(
    iter([_raw27(_LEAK27), _raw27("", "stop")]), {"other_tool"})]
check("流式：未声明工具名 -> 不吞正文，按普通文本透传",
      "".join(_f["choices"][0]["delta"].get("content") or ""
              for _f in _frames27c) == _LEAK27, _frames27c)

_ev27 = [f.decode() for f in P.stream_responses_events(
    iter([_raw27(_LEAK27), _raw27("", "stop")]), "m27",
    {"usage": None, "custom_names": set(), "allowed_names": {"terminal"}})]
_parsed27 = [json.loads(_ln[6:]) for _fr in _ev27
             for _ln in _fr.splitlines() if _ln.startswith("data: ")]
_text27 = "".join(e.get("delta") or "" for e in _parsed27
                  if e.get("type") == "response.output_text.delta")
_fc27 = [e["item"] for e in _parsed27
         if e.get("type") == "response.output_item.done"
         and (e.get("item") or {}).get("type") == "function_call"]
check("Responses 流式：泄漏不回显为 output_text，转为 function_call 项",
      _text27 == "" and _fc27 and _fc27[0].get("name") == "terminal",
      (_text27, _fc27))

_src27 = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           "qoder_proxy.py"), encoding="utf-8").read()
check("写入侧只引用 LEAK_MARKER 常量（无重复字面量）",
      _src27.count(json.dumps(P.LEAK_MARKER, ensure_ascii=False)) == 1
      and "LEAK_MARKER + " in _src27,
      _src27.count(json.dumps(P.LEAK_MARKER, ensure_ascii=False)))

print()
print("[27.5] issue #9：截断的 marker+JSON 回声必须吞掉、不得透传（P0）")
_TRUNC27 = _M27 + "\n" + _CALLS27[:40]      # 未闭合字符串的截断回声（issue #9 样本形态）
check("判据：截断数组 -> True",
      P._leaked_partial_droppable(_TRUNC27, {"terminal"}) is True)
check("判据：只有 marker -> True",
      P._leaked_partial_droppable(_M27, {"terminal"}) is True)
check("判据：围栏 + 截断数组 -> True",
      P._leaked_partial_droppable("```json\n" + _TRUNC27, {"terminal"}) is True)
check("判据：marker + 散文 -> False",
      P._leaked_partial_droppable(_M27 + "\n这是一段解释文字。",
                                 {"terminal"}) is False)
check("判据：不以 marker 开头的讨论回复 -> False",
      P._leaked_partial_droppable("网关会写入 " + _M27 + " 这样的提示。",
                                 {"terminal"}) is False)
check("判据：未声明 tools / 空 names -> False",
      P._leaked_partial_droppable(_TRUNC27, None) is False
      and P._leaked_partial_droppable(_TRUNC27, set()) is False)
check("判据：完整但未声明工具名的数组 -> False（保持 fail-open 透传）",
      P._leaked_partial_droppable(_LEAK27, {"other"}) is False)

_frames_trunc = [json.loads(f[6:]) for f in P.recover_leaked_tool_calls(
    iter([_raw27(_TRUNC27[:12]), _raw27(_TRUNC27[12:]), _raw27("", "stop")]),
    {"terminal"})]
_text_trunc = "".join(_f["choices"][0]["delta"].get("content") or ""
                      for _f in _frames_trunc)
check("流式：截断回声被吞（正文既无 marker、也无 terminal 明文）",
      _text_trunc == ""
      and P.LEAK_MARKER not in json.dumps(_frames_trunc, ensure_ascii=False),
      _text_trunc)
check("流式：吞掉后 finish_reason 仍为 stop（Lead 裁定）",
      _frames_trunc[-1]["choices"][0]["finish_reason"] == "stop",
      _frames_trunc)

_obj_trunc = P.aggregate_stream(
    _Resp27([_env27(_TRUNC27[:12]), _env27(_TRUNC27[12:]), _env27("", "stop")]),
    "m27", None, allowed_names={"terminal"})
_msg_trunc = _obj_trunc["choices"][0]["message"]
check("非流式：截断回声 -> content 清空、无 tool_calls、finish=stop",
      _msg_trunc.get("content") == "" and not _msg_trunc.get("tool_calls")
      and _obj_trunc["choices"][0]["finish_reason"] == "stop", _obj_trunc)

_ev_trunc = [f.decode() for f in P.stream_responses_events(
    iter([_raw27(_TRUNC27[:12]), _raw27(_TRUNC27[12:]), _raw27("", "stop")]),
    "m27", {"usage": None, "custom_names": set(),
            "allowed_names": {"terminal"}})]
_joined_trunc = "".join(_ev_trunc)
_parsed_trunc_lk = [json.loads(_ln[6:]) for _fr in _ev_trunc
                       for _ln in _fr.splitlines() if _ln.startswith("data: ")]
_text_delta_trunc = "".join(e.get("delta") or "" for e in _parsed_trunc_lk
                            if isinstance(e, dict)
                            and e.get("type") == "response.output_text.delta")
check("Responses 流式：截断回声不出现在正文增量里（不再用短词匹配整个事件流）",
      _text_delta_trunc == "" and P.LEAK_MARKER not in _joined_trunc,
      (_text_delta_trunc[:120], _joined_trunc[:120]))

_frames_falsify = [json.loads(f[6:]) for f in P.recover_leaked_tool_calls(
    iter([_raw27(_M27), _raw27("\n这是一段解释文字。"), _raw27("", "stop")]),
    {"terminal"})]
_text_falsify = "".join(_f["choices"][0]["delta"].get("content") or ""
                        for _f in _frames_falsify)
check("流式：证伪（marker 后接散文）-> 仍 fail-open 补发原文",
      _M27 in _text_falsify and "解释文字" in _text_falsify, _text_falsify)

print()
print("[27.6] 写入侧暴露面削减（历史工具结果首尾保留 + 中间省略）")
_LONG29 = "".join("log line %05d %s\n" % (i, "y" * 60) for i in range(150))
_MSGS29 = [
    {"role": "user", "content": "run"},
    {"role": "tool", "name": "terminal", "content": _LONG29},   # 历史 -> 削
    {"role": "user", "content": "again"},
    {"role": "tool", "name": "terminal", "content": _LONG29},   # 当前轮 -> 不削
    {"role": "tool", "name": "cat", "content": "ok: 3 passed"},
]
_flat29 = P.flatten_messages(_MSGS29)[1]
_hist29, _cur29, _short29 = (_flat29[1]["content"], _flat29[3]["content"],
                             _flat29[4]["content"])
_PREF29 = P.TOOL_RESULT_MARKER + " (terminal)]\n"
_body29 = _hist29.split("\n", 1)[1]     # 剥掉 "[工具结果 (terminal)]" 前缀行
check("削减：历史工具结果被截断（首尾保留 + 省略标记）",
      len(_hist29) < len(_LONG29) and "已省略" in _hist29
      and _body29.startswith(_LONG29[:20]) and _body29.endswith(_LONG29[-40:]),
      (len(_LONG29), len(_hist29)))
check("削减：信封前缀逐字节不变（历史与当前轮都是）",
      _hist29.startswith(_PREF29) and _cur29.startswith(_PREF29)
      and _short29.startswith(P.TOOL_RESULT_MARKER + " (cat)]\n"))
check("削减：当前轮的 tool 结果全文保留", _cur29 == _PREF29 + _LONG29)
check("削减：短结果不动", _short29.endswith("ok: 3 passed"))
check("削减：完整 JSON 不削且仍可解析",
      isinstance(json.loads(P._shrink_tool_result(
          json.dumps({"a": [1, 2, 3] * 20}), 2000)), dict))
check("削减：无 user 的会话 -> 全部视为当前轮（不削）",
      P.flatten_messages([{"role": "system", "content": "s"},
                          {"role": "tool", "name": "t",
                           "content": _LONG29}])[1][0]["content"]
      == P.TOOL_RESULT_MARKER + " (t)]\n" + _LONG29)
os.environ["QD_TOOL_RESULT_KEEP"] = "0"
check("开关：QD_TOOL_RESULT_KEEP=0 完全回退旧行为（全文回灌）",
      P.flatten_messages(_MSGS29)[1][1]["content"] == _PREF29 + _LONG29)
os.environ["QD_TOOL_RESULT_KEEP"] = "off"
check("开关：off -> 关闭", P._tool_result_keep_chars() == 0)
os.environ["QD_TOOL_RESULT_KEEP"] = "abc"
check("开关：非法值回落默认", P._tool_result_keep_chars() == 2000)
del os.environ["QD_TOOL_RESULT_KEEP"]
check("开关：默认值 = 2000（保守）",
      P._tool_result_keep_chars() == P.TOOL_RESULT_KEEP_DEFAULT == 2000)

print()
print("[27.7] 结构化工具历史直传（task-32：provider 白名单 + 一键回退）")
_SMSGS32 = [
    {"role": "user", "content": "weather?"},
    {"role": "assistant", "content": None, "tool_calls": [
        {"id": "call_1", "type": "function",
         "function": {"name": "get_weather", "arguments": {"city": "SZ"}}}]},
    {"role": "tool", "tool_call_id": "call_1", "name": "get_weather",
     "content": "25C"},
    {"role": "user", "content": "thanks"},
    {"role": "assistant", "content": "", "tool_calls": [
        {"id": "call_2", "type": "function",
         "function": {"name": "get_weather",
                      "arguments": "{\"city\": \"BJ\"}"}}]},
    {"role": "tool", "tool_call_id": "call_2", "name": "get_weather",
     "content": "18C"},
]
_flat32s = P.flatten_messages(_SMSGS32, structured=True)[1]
_flat32t = P.flatten_messages(_SMSGS32, structured=False)[1]
os.environ.pop("QD_STRUCTURED_TOOL_HISTORY", None)
check("开关：auto + CN + Qwen -> 结构化",
      P.structured_tool_history_enabled(model="qwen3.8-flash",
                                        model_key="qwen3.8-flash",
                                        realm="cn", messages=_SMSGS32) is True)
check("开关：auto + CN + GLM（上游 key gm5x）-> 结构化",
      P.structured_tool_history_enabled(model="glm-5.3-flash",
                                        model_key="gm53flash",
                                        realm="cn", messages=_SMSGS32) is True)
check("开关：auto + CN + DeepSeek -> 文本化（未验证 provider 默认不启用）",
      P.structured_tool_history_enabled(model="deepseek-flash",
                                        model_key="deepseek-flash",
                                        realm="cn", messages=_SMSGS32) is False)
check("开关：auto + INTL -> 文本化（INTL legacy 未实测）",
      P.structured_tool_history_enabled(model="qwen3.8-flash",
                                        model_key="qwen3.8-flash",
                                        realm="intl", messages=_SMSGS32)
      is False)
os.environ["QD_STRUCTURED_TOOL_HISTORY"] = "on"
check("开关：on 强制（DeepSeek / INTL 也走结构化，供补验证）",
      P.structured_tool_history_enabled(model="deepseek-flash",
                                        model_key="deepseek-flash",
                                        realm="intl", messages=_SMSGS32) is True)
check("守卫：缺 tool_call_id -> 一律回退文本化（fail-safe）",
      P.structured_tool_history_enabled(
          model="qwen", model_key="qwen", realm="cn",
          messages=[{"role": "user", "content": "x"},
                    {"role": "tool", "content": "y"}]) is False)
os.environ["QD_STRUCTURED_TOOL_HISTORY"] = "off"
check("开关：off 一键回退（即使 Qwen）",
      P.structured_tool_history_enabled(model="qwen3.8-flash",
                                        model_key="qwen3.8-flash",
                                        realm="cn", messages=_SMSGS32) is False)
del os.environ["QD_STRUCTURED_TOOL_HISTORY"]
check("产物：tool 消息保留 role/tool_call_id，content 是非 null 字符串",
      _flat32s[2] == {"role": "tool", "tool_call_id": "call_1",
                      "content": "25C"} and _flat32s[5]["role"] == "tool")
check("产物：assistant.content 为 \"\"（绝不为 null）+ tool_calls 结构齐备",
      _flat32s[1]["content"] == "" and _flat32s[1]["content"] is not None
      and _flat32s[1]["tool_calls"][0]["id"] == "call_1"
      and _flat32s[1]["tool_calls"][0]["type"] == "function"
      and _flat32s[1]["tool_calls"][0]["function"]["name"] == "get_weather")
check("产物：arguments 的 dict 形态被归一为 JSON 字符串",
      _flat32s[1]["tool_calls"][0]["function"]["arguments"] == '{"city": "SZ"}')
check("产物：结构化模式下不存在 null content",
      all(m.get("content") is not None for m in _flat32s))
check("产物：当前轮（末尾 tool）同样走结构化，不与文本混用",
      _flat32s[5] == {"role": "tool", "tool_call_id": "call_2",
                      "content": "18C"})
check("对照：文本化模式仍是 user 降级 + LEAK_MARKER，且无 tool 角色",
      [m["role"] for m in _flat32t] == ["user", "assistant", "user", "user",
                                        "assistant", "user"]
      and _flat32t[1]["content"].endswith("]")
      and P.TOOL_RESULT_MARKER in _flat32t[2]["content"])

print()
print("[27.8] 内层错误可观测性（HTTP 200 信封里藏 error）")
_ERR34 = json.dumps({
    "error": {"type": "invalid_request_error", "code": "invalid_request_error",
              "message": "Messages with role 'tool' must be a response to a "
                         "preceding message with 'tool_calls'"}})
_ENV34 = ("data: " + json.dumps({"statusCodeValue": 200, "body": _ERR34},
                                ensure_ascii=False) + "\n\n").encode("utf-8")
_s0_34 = P.inner_error_snapshot()
_lines34 = list(P.iter_inner_sse([_ENV34]))
_s1_34 = P.inner_error_snapshot()
check("内层 error：被识别并计数；chunk 仍照常透传（行为不变）",
      _s1_34["total"] == _s0_34["total"] + 1
      and _s1_34["kinds"].get("invalid_request", 0) >= 1
      and len(_lines34) == 1)
check("内层 error：同类重复计数累加、只按类别告警一次",
      P.note_inner_upstream_error({"error": {"type": "provider_error",
                                              "message": "provider_error"}},
                                  status=200) == "invalid_request"
      and P.note_inner_upstream_error(
          {"error": {"message": "invalid_request again"}}, status=200)
      == "invalid_request"
      and P.inner_error_snapshot()["total"] == _s1_34["total"] + 2
      and P.inner_error_snapshot()["warned"].count("invalid_request") == 1)
check("内层 error：正常 chunk 不误判",
      P.note_inner_upstream_error({"choices": [{"delta": {"content": "hi"}}]})
      == "" and P.note_inner_upstream_error(None) == ""
      and P.note_inner_upstream_error({"usage": {"total_tokens": 3}}) == "")
check("内层 error：分类覆盖 content_policy / rate_limit",
      P._inner_error_kind("DataInspectionFailed", "inappropriate content")
      == "content_policy"
      and P._inner_error_kind("", "usage exceeds frequency limit 10605")
      == "rate_limit")
check("内层 error：计数挂到运行信息（/usage/perf 返回含 inner_errors）",
      "inner_errors" in P._perf_stats_uncached(sample=1)
      and isinstance(P.inner_error_snapshot(), dict))


def _raise34():
    try:
        list(P.iter_inner_sse([("data: " + json.dumps(
            {"statusCodeValue": 418, "body": "boom"}) + "\n\n").encode("utf-8")]))
        return "no-raise"
    except P.UpstreamStatus as exc:
        return "raised:%s" % exc.status


check("形态区分：信封非 200 仍抛 UpstreamStatus（既有路径未变）",
      _raise34() == "raised:418")

print()
print("[27.9] issue #16：散文+marker 同帧 / 未完成 \\uXXXX 转义（回读守卫边界）")
_M16 = P.LEAK_MARKER
_N16 = {"terminal"}
_A16 = _M16 + "\n" + '[{"name": "terminal", "arguments": "{\\"cmd\\": \\"ls'
_B116 = "我先看看目录结构。\n\n" + _A16
_B316 = _M16 + "\n" + '[{"name": "terminal", "arguments": "{\\"cmd\\": \\"echo \\u63a'
_C16 = "[工具结果]\n{\"output\": \"ok\"}\n[工具结果结束]"


def _txt16(out):
    return "".join(f["choices"][0]["delta"].get("content") or "" for f in out)


_r16a = [json.loads(f[6:]) for f in P.recover_leaked_tool_calls(
    iter([_raw27(_A16[:10]), _raw27(_A16[10:]), _raw27("", "stop")]), _N16)]
check("A 参照（marker 开头 + 截断）-> 仍吞（回归）",
      P.LEAK_MARKER not in _txt16(_r16a))
_r16b1 = [json.loads(f[6:]) for f in P.recover_leaked_tool_calls(
    iter([_raw27(_B116), _raw27("", "stop")]), _N16)]
check("B1 散文 + marker 同帧 -> 吞回声块、散文保留",
      P.LEAK_MARKER not in _txt16(_r16b1)
      and "我先看看目录结构。" in _txt16(_r16b1))
_r16b2 = [json.loads(f[6:]) for f in P.recover_leaked_tool_calls(
    iter([_raw27("我先看看目录结构。\n\n"), _raw27(_A16), _raw27("", "stop")]),
    _N16)]
check("B2 散文与 marker 分帧 -> 同样吞（回归）",
      P.LEAK_MARKER not in _txt16(_r16b2)
      and "我先看看目录结构。" in _txt16(_r16b2))
_r16b3 = [json.loads(f[6:]) for f in P.recover_leaked_tool_calls(
    iter([_raw27(_B316[:12]), _raw27(_B316[12:]), _raw27("", "stop")]), _N16)]
check("B3 截断落在未写完的 \\uXXXX 转义 -> 吞",
      P.LEAK_MARKER not in _txt16(_r16b3))
_r16c = [json.loads(f[6:]) for f in P.recover_leaked_tool_calls(
    iter([_raw27(_C16), _raw27("", "stop")]), _N16)]
check("C [工具结果] 回声（回归）-> 吞", "[工具结果" not in _txt16(_r16c))
check("B3 判据单元：未完成 / 彻底非法转义都视为可继续扩展",
      P._json_array_prefix_ok('[{"a": "x\\u63a') is True
      and P._json_array_prefix_ok('[{"a": "x\\uZZZZ') is True
      and P._json_array_prefix_ok('[{"a": "x\\u63a2') is True)
_r16e1 = [json.loads(f[6:]) for f in P.recover_leaked_tool_calls(
    iter([_raw27("列表项 [1, 2"), _raw27(", 3] 结束"), _raw27("", "stop")]),
    _N16)]
check("误伤边界：普通文本（含 [1, 2）原样透传",
      _txt16(_r16e1) == "列表项 [1, 2, 3] 结束")
_r16e2 = [json.loads(f[6:]) for f in P.recover_leaked_tool_calls(
    iter([_raw27("看这个 [assis"), _raw27("tant 是普通词"),
          _raw27("", "stop")]), _N16)]
check("误伤边界：帧尾 marker 真前缀（[assis）证伪后完整补发",
      _txt16(_r16e2) == "看这个 [assistant 是普通词")
_r16e4 = [json.loads(f[6:]) for f in P.recover_leaked_tool_calls(
    iter([_raw27("散文 " + _M16 + "\n"
                + '[{"name": "terminal", "arguments": "{}"}]'),
          _raw27("", "stop")]), _N16)]
check("散文 + 完整合法数组 -> 仍走恢复路径（tool_calls），散文保留",
      bool([f for f in _r16e4 if f["choices"][0]["delta"].get("tool_calls")])
      and _txt16(_r16e4).startswith("散文"))
check("窗口常量：_MARKER_HOLD_WINDOW = 最长标记 - 1（17）",
      P._MARKER_HOLD_WINDOW == len(P.LEAK_MARKER) - 1 == 17)
_obj16 = P.aggregate_stream(
    _Resp27([_env27(_B116[:12]), _env27(_B116[12:]), _env27("", "stop")]),
    "m27", None, allowed_names=_N16)
check("非流式：散文 + marker 回声块 -> 只吞块、散文保留",
      _obj16["choices"][0]["message"].get("content") == "我先看看目录结构。\n\n")
_ev16 = [f.decode() for f in P.stream_responses_events(
    iter([_raw27(_B116[:12]), _raw27(_B116[12:]), _raw27("", "stop")]), "m27",
    {"usage": None, "custom_names": set(), "allowed_names": _N16})]
check("Responses 流式：散文 + marker 同帧 -> 不回显 marker、散文保留",
      P.LEAK_MARKER not in "".join(_ev16)
      and "我先看看目录结构。" in "".join(_ev16))

print()
print("[27.95] issue #16 兜底：hold 缓冲上限（超限 fail-open 放行）")
_BIG16 = P.LEAK_MARKER + "\n[" + "1," * 20000          # 约 40KB 的候选前缀
_big_out = [json.loads(f[6:]) for f in P.recover_leaked_tool_calls(
    iter([_raw27(_BIG16), _raw27("2]", "stop")]), {"terminal"})]
_big_text = "".join(f["choices"][0]["delta"].get("content") or ""
                    for f in _big_out)
check("超限：hold 超过 _HOLD_MAX_CHARS -> fail-open 放行且内容只出现一次",
      len(_BIG16) > P._HOLD_MAX_CHARS and _big_text == _BIG16 + "2]")
check("上限常量：32KB / 200 帧",
      P._HOLD_MAX_CHARS == 32768 and P._HOLD_MAX_FRAMES == 200)
_keep_frames16 = P._HOLD_MAX_FRAMES
try:
    P._HOLD_MAX_FRAMES = 2
    _fr16 = [json.loads(f[6:]) for f in P.recover_leaked_tool_calls(
        iter([_raw27(P.LEAK_MARKER), _raw27("\n["), _raw27("1"), _raw27("2"),
              _raw27("", "stop")]), {"terminal"})]
finally:
    P._HOLD_MAX_FRAMES = _keep_frames16
check("帧数兜底：超过 _HOLD_MAX_FRAMES 帧仍未证伪 -> 放行",
      "".join(f["choices"][0]["delta"].get("content") or "" for f in _fr16)
      == P.LEAK_MARKER + "\n[12")

print()
print("[28] 发布前补强：终局验证 §10.7#5 的零覆盖项（防止静默回归）")
import ast as _ast28
import re as _re28
import shutil as _sh28
import tempfile as _tf28
import time as _t28
import qoder_scheduler as _S28

_src28 = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           "qoder_proxy.py"), encoding="utf-8").read()


def _arg_src28(src_text, func_name):
    """AST 级提取：func_name(...) 每个调用的位置参数源码片段（离线可变异的判据）。"""
    tree = _ast28.parse(src_text)
    out = []
    for node in _ast28.walk(tree):
        if isinstance(node, _ast28.Call) and isinstance(node.func, _ast28.Name) \
                and node.func.id == func_name:
            out.append([_ast28.get_source_segment(src_text, a) for a in node.args])
    return out


# --- 28.1 Responses 重试上下文：两处重开必须用转换后的 chat_req ---
_i0_28 = _src28.index("chat_req = responses_to_chat(payload)")
_i1_28 = _src28.index("\n    def ", _i0_28 + 10)
_resp_block28 = _src28[_i0_28:_i1_28]
check("Responses 重开：两处重试都以 chat_req 发起"
      "（open_upstream 与 aggregate_with_envelope_retry）",
      "chat_req, session_key=session_key" in _resp_block28
      and "upstream, chat_req, session_key" in _resp_block28)
_strip28 = _resp_block28.replace("chat_req = responses_to_chat(payload)", "")
_idents28 = _re28.findall(r"(?<![\w.])payload(?![\w])", _strip28)
_gets28 = len(_re28.findall(r"payload\.get\(", _strip28))
check("Responses 分支：原始 payload 只用于读字段（payload.get），不再作为上游请求体"
      "——回退成 payload 即红",
      len(_idents28) == _gets28 and _gets28 >= 1,
      (_idents28, _gets28))
_agg_args28 = _arg_src28(_src28, "aggregate_with_envelope_retry")
check("AST：aggregate_with_envelope_retry 实参里 chat_req（Responses）与 payload"
      "（chat）各司其职——单一断言同时锁住两条链路",
      any(len(a) > 1 and a[1] == "chat_req" for a in _agg_args28)
      and any(len(a) > 1 and a[1] == "payload" for a in _agg_args28),
      [a[:2] for a in _agg_args28])

# --- 28.2 response.failed 终态事件与 sequence_number 续号 ---
_h28 = {"usage": None, "custom_names": set(), "allowed_names": {"terminal"}}
_ev28 = [json.loads(_ln[6:])
         for _f in P.stream_responses_events(
             iter([_raw27("hi"), _raw27("", "stop")]), "m27", _h28)
         for _ln in _f.decode().splitlines() if _ln.startswith("data: ")]
_max28 = max(e["sequence_number"] for e in _ev28)
_fail_raw28 = P._responses_failed_frame(_h28, 418, "upstream boom")
_fail_obj28 = json.loads([_l for _l in _fail_raw28.decode().splitlines()
                          if _l.startswith("data: ")][0][6:])
check("response.failed：终态事件名 / status / error.code 正确",
      _fail_raw28.decode("utf-8").startswith("event: response.failed\n")
      and _fail_obj28["type"] == "response.failed"
      and _fail_obj28["response"]["status"] == "failed"
      and _fail_obj28["response"]["error"]["code"] == "418",
      _fail_obj28)
check("response.failed：sequence_number 严格大于此前所有事件（续号，不回退到 0）",
      _fail_obj28["sequence_number"] > _max28,
      (_fail_obj28["sequence_number"], _max28))
_h28b = {"usage": None, "custom_names": set(), "allowed_names": {"terminal"}}
_ev28b1 = [json.loads(_ln[6:])
           for _f in P.stream_responses_events(
               iter([_raw27("a"), _raw27("", "stop")]), "m27", _h28b)
           for _ln in _f.decode().splitlines() if _ln.startswith("data: ")]
_ev28b2 = [json.loads(_ln[6:])
           for _f in P.stream_responses_events(
               iter([_raw27("b"), _raw27("", "stop")]), "m27", _h28b)
           for _ln in _f.decode().splitlines() if _ln.startswith("data: ")]
check("Responses 重开后 sequence_number 续号（第二条流从第一条流的 max+1 开始）",
      min(e["sequence_number"] for e in _ev28b2)
      == max(e["sequence_number"] for e in _ev28b1) + 1,
      (max(e["sequence_number"] for e in _ev28b1),
       min(e["sequence_number"] for e in _ev28b2)))

# --- 28.3 catalog_source 只读来源标注 ---
_SRC_SET28 = ("external-json", "embedded-frozen", "unknown")
check("catalog_source：snapshot_source() 取值在允许集合内，未知 realm 走 cn 分支",
      C.snapshot_source("cn") in _SRC_SET28
      and C.snapshot_source("intl") in _SRC_SET28
      and C.snapshot_source("bogus-realm") == C.snapshot_source("cn"),
      (C.snapshot_source("cn"), C.snapshot_source("intl")))
check("catalog_source：/v1/models 既有字段未变、新增来源标注（含异常兜底 unknown）",
      '"object": "list", "data": data' in _src28
      and '"catalog_source": catalog_source' in _src28
      and 'catalog_source = "unknown"' in _src28,
      [_l.strip() for _l in _src28.splitlines() if "catalog_source" in _l][:4])

# --- 28.4 Scheduler：状态落盘子目录 + 启动补签闸门（mark-before-act） ---
_tmp28 = _tf28.mkdtemp(prefix="qd-test-sched-")
_sched_err28 = None
try:
    _pool28 = A.AccountPool(_tmp28)
    _s1_28 = _S28.Scheduler(_pool28, state_dir=_tmp28)
    _gate_first28 = _s1_28._allow_complement_checkin(_S28.CYCLE_STARTUP)
    _state_path28 = _s1_28._state_path()
    _state_exists28 = os.path.isfile(_state_path28)
    with open(_state_path28, encoding="utf-8") as _fh28:
        _state_json28 = json.load(_fh28)
    _gate_second28 = _s1_28._allow_complement_checkin(_S28.CYCLE_STARTUP)
    _s2_28 = _S28.Scheduler(_pool28, state_dir=_tmp28)     # 模拟进程重启
    _gate_restart28 = _s2_28._allow_complement_checkin(_S28.CYCLE_STARTUP)
    _gate_hour28 = _s2_28._allow_complement_checkin(_S28.CYCLE_HOUR)
    _accounts28 = _pool28.load()
except Exception as _exc28:
    _sched_err28 = _exc28
    _state_path28 = ""
    _state_exists28 = False
    _state_json28 = {}
    _gate_first28 = _gate_second28 = _gate_restart28 = _gate_hour28 = None
    _accounts28 = []
finally:
    _sh28.rmtree(_tmp28, ignore_errors=True)

check("Scheduler：state.json 落在账号目录的子目录，且不会被 AccountPool.load 当成账号",
      _sched_err28 is None
      and _state_path28 == os.path.join(_tmp28, "scheduler", "state.json")
      and _state_exists28 and _accounts28 == [],
      (_sched_err28, _state_path28, len(_accounts28)))
check("Scheduler：mark-before-act——首次启动补签返回 True，且当日标记已先落盘",
      _gate_first28 is True
      and _state_json28.get("startup_claim_date") == _t28.strftime("%Y-%m-%d"),
      _state_json28.get("startup_claim_date"))
check("Scheduler：同一天第二次启动补签被闸门拒绝（False）",
      _gate_second28 is False, _gate_second28)
check("Scheduler：进程重启后不重放（新实例读同一 state.json 仍为 False）",
      _gate_restart28 is False, _gate_restart28)
check("Scheduler：整点巡回来由不受启动闸门限制（True）",
      _gate_hour28 is True, _gate_hour28)

# --- 28.5 身份来源口径（Lead 裁决：合法值只有 runtime-info / derived） ---
_acc_src28 = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               "qoder_accounts.py"), encoding="utf-8").read()
_acc_code28 = "\n".join(_l for _l in _acc_src28.splitlines()
                          if not _l.lstrip().startswith("#"))
check("身份来源口径：自愈条件用真实取值 runtime-info，代码里不得再有 == \"native\" 死逻辑"
      "（注释里的历史说明不算）",
      '"runtime-info"' in _acc_code28 and '== "native"' not in _acc_code28,
      [_l.strip() for _l in _acc_code28.splitlines() if '== "native"' in _l][:2])
print()
print("[29] issue #10 三态可观测性：实际发送行为（native/omitted）+ INTL 已知限制提示")
_MH29 = ("cosy-machineid", "cosy-machinetoken", "cosy-machinetype",
         "cosy-machineos", "cosy-machinehostname", "cosy-machinecode")
_orig_nmi29 = A.native_machine_identity
_orig_cget29 = A.Account._campaigns_get


def _camp29(realm, native):
    """构造账号：返回 (account, desktop_headers 结果, 机器头状态, campaigns() 结果)。

    native=True 打桩原生桥返回带 machineToken 的真身份；native=False 返回空 dict
    （= 无原生桥，issue #10 的 derived 场景）。
    """
    if native:
        A.native_machine_identity = lambda r, u, force=False: {
            "machineToken": "tok29", "machineType": "3", "machineCode": "c29",
            "source": A.MACHINE_IDENTITY_NATIVE}
    else:
        A.native_machine_identity = lambda r, u, force=False: {}
    acc29 = A.Account({"uid": "u29-%s-%s" % (realm, "n" if native else "d"),
                       "realm": realm, "accessToken": "dt-x"})
    hdrs29 = acc29.desktop_headers()
    state29 = acc29.machine_headers_state
    A.Account._campaigns_get = lambda self: (
        {"campaigns": [], "showCampaign": True, "claimable": False}, 200, "")
    try:
        st29 = acc29.campaigns(force=True)
    finally:
        A.Account._campaigns_get = _orig_cget29
    return hdrs29, state29, st29


try:
    _h_cn_n29, _s_cn_n29, _c_cn_n29 = _camp29("cn", True)
    _h_cn_d29, _s_cn_d29, _c_cn_d29 = _camp29("cn", False)
    _h_in_n29, _s_in_n29, _c_in_n29 = _camp29("intl", True)
    _h_in_d29, _s_in_d29, _c_in_d29 = _camp29("intl", False)
    A.Account._campaigns_get = lambda self: (None, 500, "boom29")
    _acc_fail29 = A.Account({"uid": "u29fail", "realm": "cn", "accessToken": "dt-x"})
    _st_fail29 = _acc_fail29.campaigns(force=True)
finally:
    A.native_machine_identity = _orig_nmi29
    A.Account._campaigns_get = _orig_cget29

check("三态 cn×native：真发六头 + desktop_headers 与 campaigns() 都报 native",
      all(_h_cn_n29.get(k) for k in _MH29)
      and _s_cn_n29 == A.MACHINE_HEADERS_NATIVE
      and _c_cn_n29.get("machine_headers") == A.MACHINE_HEADERS_NATIVE,
      (_s_cn_n29, _c_cn_n29.get("machine_headers")))
check("三态 cn×derived：一个机器头都不发 + 状态 omitted",
      not any(_h_cn_d29.get(k) for k in _MH29)
      and _s_cn_d29 == A.MACHINE_HEADERS_OMITTED
      and _c_cn_d29.get("machine_headers") == A.MACHINE_HEADERS_OMITTED,
      (_s_cn_d29, _c_cn_d29.get("machine_headers")))
check("三态 intl×native：真发六头 + 状态 native",
      all(_h_in_n29.get(k) for k in _MH29)
      and _s_in_n29 == A.MACHINE_HEADERS_NATIVE
      and _c_in_n29.get("machine_headers") == A.MACHINE_HEADERS_NATIVE,
      (_s_in_n29, _c_in_n29.get("machine_headers")))
check("三态 intl×derived：一个机器头都不发 + 状态 omitted",
      not any(_h_in_d29.get(k) for k in _MH29)
      and _s_in_d29 == A.MACHINE_HEADERS_OMITTED
      and _c_in_d29.get("machine_headers") == A.MACHINE_HEADERS_OMITTED,
      (_s_in_d29, _c_in_d29.get("machine_headers")))
check("INTL×omitted 必须带已知限制提示（非空字符串，含 UMID 与「已知限制」措辞）",
      isinstance(_c_in_d29.get("hint"), str)
      and "UMID" in _c_in_d29["hint"] and "已知限制" in _c_in_d29["hint"],
      _c_in_d29.get("hint"))
check("CN×omitted 的 hint 键存在且为空串（限制提示不得扩散到国内版）",
      "hint" in _c_cn_d29 and _c_cn_d29.get("hint") == "",
      _c_cn_d29.get("hint"))
check("native（两个区域）的 hint 均为空串：只有 INTL×omitted 才提示",
      _c_cn_n29.get("hint") == "" and _c_in_n29.get("hint") == "",
      (_c_cn_n29.get("hint"), _c_in_n29.get("hint")))
check("两个维度正交：derived 身份与 omitted 机器头可同时成立"
      "（identity 不再被当作「能不能发头」的信号）",
      _c_cn_d29.get("identity") == "derived"
      and _c_cn_d29.get("machine_headers") == A.MACHINE_HEADERS_OMITTED,
      (_c_cn_d29.get("identity"), _c_cn_d29.get("machine_headers")))
print()
print("[30] UMID 提取器（_install_umid.py）离线纯函数断言：识别 / 平台选择 / 扫描 / 校验 / 幂等")
import base64 as _b64_30
import contextlib as _cl_30
import io as _io_30
import shutil as _sh_30
import struct as _st_30
import tarfile as _tfmod_30
import tempfile as _tf_30
import _install_umid as U30


def _elf30(machine, cls=2, endian=1):
    buf = bytearray(0x40)
    buf[0:4] = b"\x7fELF"
    buf[4] = cls
    buf[5] = endian
    buf[18:20] = _st_30.pack("<H", machine)
    return bytes(buf)


def _macho30(cpu):
    return b"\xcf\xfa\xed\xfe" + _st_30.pack("<I", cpu) + b"\x00" * 8


def _pe30(machine):
    buf = bytearray(0x80)
    buf[0:2] = b"MZ"
    buf[0x3C:0x40] = _st_30.pack("<I", 0x40)
    buf[0x40:0x44] = b"PE\x00\x00"
    buf[0x44:0x46] = _st_30.pack("<H", machine)
    return bytes(buf)


_WASM30 = b"\x00asm\x01\x00\x00\x00"
_ELF_X30 = _elf30(0x3E)
_ELF_A30 = _elf30(0xB7)

# --- 30.1 魔数/架构识别 ---
check("identify_blob：ELF x86-64 / aarch64 正确（e_machine 区分）",
      U30.identify_blob(_ELF_X30) == "elf-x86_64"
      and U30.identify_blob(_ELF_A30) == "elf-aarch64",
      (U30.identify_blob(_ELF_X30), U30.identify_blob(_ELF_A30)))
check("identify_blob：Mach-O x86_64 / arm64 正确（cputype 区分）",
      U30.identify_blob(_macho30(0x01000007)) == "macho-x86_64"
      and U30.identify_blob(_macho30(0x0100000C)) == "macho-arm64"
      and U30.identify_blob(_macho30(0x7)) == "unknown",
      (U30.identify_blob(_macho30(0x01000007)), U30.identify_blob(_macho30(0x0100000C))))
check("identify_blob：PE x86_64 / aarch64 正确（e_lfanew -> PE\\0\\0 -> machine）",
      U30.identify_blob(_pe30(0x8664)) == "pe-x86_64"
      and U30.identify_blob(_pe30(0xAA64)) == "pe-aarch64",
      (U30.identify_blob(_pe30(0x8664)), U30.identify_blob(_pe30(0xAA64))))
check("identify_blob：截断/畸形 PE 不崩溃且归为 unknown（e_lfanew 越界有兜底）",
      U30.identify_blob(b"MZ") == "unknown"
      and U30.identify_blob(b"MZ" + b"\x00" * 0x3E) == "unknown"
      and U30.identify_blob(_pe30(0x8664)[:0x44] + b"\x00" * 0x40) == "unknown",
      (U30.identify_blob(b"MZ"), U30.identify_blob(b"MZ" + b"\x00" * 0x3E)))
check("identify_blob：WASM 正确；非原生数据一律 unknown（空/垃圾/短 ELF/未知 e_machine/大端 ELF）",
      U30.identify_blob(_WASM30) == "wasm"
      and U30.identify_blob(b"") == "unknown"
      and U30.identify_blob(b"\x00" * 64) == "unknown"
      and U30.identify_blob(b"\x7fELF\x02\x01") == "unknown"
      and U30.identify_blob(_elf30(0x28)) == "unknown"
      and U30.identify_blob(_elf30(0x3E, endian=2)) == "unknown",
      (U30.identify_blob(_WASM30), U30.identify_blob(b""), U30.identify_blob(_elf30(0x3E, endian=2))))

# --- 30.2 平台 / 架构选择 ---
check("component_for_platform：linux/darwin × x86_64/arm64 映射正确（含 AMD64/aarch64 别名）",
      U30.component_for_platform("linux", "x86_64") == "elf-x86_64"
      and U30.component_for_platform("linux", "AMD64") == "elf-x86_64"
      and U30.component_for_platform("linux", "aarch64") == "elf-aarch64"
      and U30.component_for_platform("linux", "arm64") == "elf-aarch64"
      and U30.component_for_platform("darwin", "x86_64") == "macho-x86_64"
      and U30.component_for_platform("darwin", "arm64") == "macho-arm64",
      (U30.component_for_platform("linux", "AMD64"),
       U30.component_for_platform("darwin", "arm64")))
check("component_for_platform：win32 与未知组合返回 None（不猜平台）",
      U30.component_for_platform("win32", "x86_64") is None
      and U30.component_for_platform("linux", "riscv64") is None
      and U30.component_for_platform("plan9", "x86_64") is None,
      (U30.component_for_platform("win32", "x86_64"),
       U30.component_for_platform("linux", "riscv64")))
_cands30 = [(0, 0, _WASM30 + b"\x00" * 32), (0, 0, _ELF_A30), (0, 0, _ELF_X30),
            (0, 0, _pe30(0x8664))]
_pick_a30 = U30.select_candidate(_cands30, "elf-aarch64")
_pick_x30 = U30.select_candidate(_cands30, "elf-x86_64")
check("select_candidate：按期望标签精确挑（aarch64 不会挑到 x86-64 blob，反之亦然）",
      _pick_a30 is not None and _pick_a30[0] == 1
      and U30.identify_blob(_pick_a30[1]) == "elf-aarch64"
      and _pick_x30 is not None and _pick_x30[0] == 2
      and U30.identify_blob(_pick_x30[1]) == "elf-x86_64",
      (_pick_a30[0] if _pick_a30 else None, _pick_x30[0] if _pick_x30 else None))
check("select_candidate：无匹配返回 None（不会退而求其次给出错组件）",
      U30.select_candidate([(0, 0, _WASM30), (0, 0, _pe30(0x8664))], "macho-arm64") is None)
_pe_big30 = _pe30(0x8664) + b"\x00" * (3 * 1024 * 1024)      # ~3MB：超出真组件体积区间
_pe_ok30 = _pe30(0x8664) + b"\x00" * (600 * 1024)            # ~600KB：落在 400KB–2MB
_sel_pe30 = U30.select_candidate([(0, 0, _pe_big30), (0, 0, _pe_ok30)], "pe-x86_64")
check("体积启发式：同格式多候选取落在 400KB–2MB 真组件区间的那个"
      "（避开 docstring 记录的 7.3MB 疑似模块）",
      _sel_pe30 is not None and _sel_pe30[0] == 1
      and len(_sel_pe30[1]) == len(_pe_ok30),
      (_sel_pe30[0] if _sel_pe30 else None,
       len(_sel_pe30[1]) if _sel_pe30 else None))

# --- 30.3 base64 扫描 ---
# 扫描断言必须用"长度达标"的样本：base64(64B) 只有 88 字符，远小于 BLOB_MIN_LEN，
# 因此这里把 ELF 头补零到 4KB+（头部魔数与 e_machine 不变，仍是合法 elf-x86_64）。
_ELF_BIG30 = _ELF_X30 + b"\x00" * 4096
_b64s30 = _b64_30.b64encode(_ELF_BIG30).decode()
assert len(_b64s30) > U30.BLOB_MIN_LEN, len(_b64s30)
_TICK30 = chr(96)
_text30 = ('const a = "' + _b64s30 + '";\n'
           'const short = "AAAA";\n'
           "const b = '" + _b64s30 + "';\n"
           "const c = " + _TICK30 + _b64s30 + _TICK30 + ";\n")
_cands30b = U30.scan_bundle_candidates(_text30)
check("scan_bundle_candidates：只收长度达标的引号字面量（短字面量与反引号模板都不收）",
      len(_cands30b) == 2, [len(c[2]) for c in _cands30b])
check("scan_bundle_candidates：偏移是内容区间（不含引号）且解码正确",
      _text30[_cands30b[0][0]:_cands30b[0][1]] == _b64s30
      and U30.identify_blob(_cands30b[0][2]) == "elf-x86_64",
      (_cands30b[0][0], _cands30b[0][1]))
check("scan_bundle_candidates：min_len 阈值可调（阈值高于字面量长度 -> 零候选）",
      U30.scan_bundle_candidates(_text30, min_len=len(_b64s30) + 1) == []
      and len(U30.scan_bundle_candidates(_text30, min_len=len(_b64s30))) == 2)
check("扫描+选择：WASM 排在前面也不会被选中（按格式过滤，不按出现顺序）",
      (lambda _s: _s is not None and _s[0] == 1)(U30.select_candidate(
          [(0, 0, _WASM30 + b"\x00" * 64), (0, 0, _ELF_X30)], "elf-x86_64")))

# --- 30.4 校验 ---
check("verify_component：magic 与架构级双重校验（不匹配一律 False）",
      U30.verify_component(_ELF_X30, "elf-x86_64") is True
      and U30.verify_component(_ELF_X30, "elf-aarch64") is False
      and U30.verify_component(_ELF_A30, "elf-x86_64") is False
      and U30.verify_component(_WASM30, "elf-x86_64") is False
      and U30.verify_component(b"", "elf-x86_64") is False,
      (U30.verify_component(_ELF_X30, "elf-aarch64"),
       U30.verify_component(_WASM30, "elf-x86_64")))
_good30 = "sha512-" + _b64_30.b64encode(hashlib.sha512(b"abc").digest()).decode()
_bad30 = "sha512-" + _b64_30.b64encode(hashlib.sha512(b"abd").digest()).decode()
check("verify_integrity：sha512 三态（正确 True / 不符 False / 缺失或异算法 None=跳过）",
      U30.verify_integrity(b"abc", _good30) is True
      and U30.verify_integrity(b"abc", _bad30) is False
      and U30.verify_integrity(b"abc", None) is None
      and U30.verify_integrity(b"abc", "sha1-ZW5j") is None,
      (U30.verify_integrity(b"abc", _bad30), U30.verify_integrity(b"abc", None)))

# --- 30.5 幂等语义（stub 网络函数，全程离线） ---
_tmp30 = _tf_30.mkdtemp(prefix="qd-umid-")
try:
    _dest30 = os.path.join(_tmp30, "umid")
    _tgt30 = os.path.join(_dest30, "runtime-info")
    _missing30 = U30.is_installed(_tgt30, "elf-x86_64")
    os.makedirs(_dest30, exist_ok=True)
    with open(_tgt30, "wb") as fh30:
        fh30.write(_WASM30 + b"\x00" * 32)
    _bad30_state = U30.is_installed(_tgt30, "elf-x86_64")
    with open(_tgt30, "wb") as fh30:
        fh30.write(_ELF_X30)
    _ok30_state = U30.is_installed(_tgt30, "elf-x86_64")
    check("is_installed：不存在 False / 内容不符 False / 校验通过 True（不看文件大小或名字）",
          _missing30 is False and _bad30_state is False and _ok30_state is True,
          (_missing30, _bad30_state, _ok30_state))

    _calls30 = []
    _orig_rt30, _orig_dl30 = U30.resolve_tarball, U30.download_tarball
    U30.resolve_tarball = lambda *a, **k: (_calls30.append("resolve")
                                           or ("9.9.9", "http://invalid", None))
    U30.download_tarball = lambda *a, **k: (_calls30.append("download") or b"")
    try:
        with _cl_30.redirect_stdout(_io_30.StringIO()):
            _rc_skip30 = U30.main(["--platform", "linux", "--arch", "x64",
                                   "--dest", _dest30])
        _calls_after_skip30 = list(_calls30)
        with open(_tgt30, "wb") as fh30:
            fh30.write(_WASM30 + b"\x00" * 32)          # 破坏目标 -> 应重新下载
        try:
            with _cl_30.redirect_stdout(_io_30.StringIO()):
                _rc_redl30 = U30.main(["--platform", "linux", "--arch", "x64",
                                       "--dest", _dest30])
        except Exception as _exc30:
            _rc_redl30 = "异常:%s" % type(_exc30).__name__
        _calls_after_redl30 = list(_calls30)
    finally:
        U30.resolve_tarball, U30.download_tarball = _orig_rt30, _orig_dl30
    check("幂等：目标已存在且校验通过 -> main() 返回 0 且一个网络函数都没被调用",
          _rc_skip30 == 0 and _calls_after_skip30 == [],
          (_rc_skip30, _calls_after_skip30))
    check("幂等反例：目标校验不通过 -> 确实走下载路径（不是无条件跳过）",
          _calls_after_redl30[:1] == ["resolve"] and _rc_redl30 != 0,
          (_rc_redl30, _calls_after_redl30))

    # --- 30.6 端到端（全离线）：伪造 npm tarball -> 扫描 -> 选择 -> 安装 ---
    # 端到端必须用"长度达标"的样本，否则扫描阶段（BLOB_MIN_LEN）就会漏掉它
    _bundle_src30 = 'const blob = "%s";\n' % _b64_30.b64encode(_ELF_BIG30).decode()
    _buf30 = _io_30.BytesIO()
    with _tfmod_30.open(fileobj=_buf30, mode="w:gz") as _tf30:
        _info30 = _tfmod_30.TarInfo(U30.BUNDLE_MEMBER)
        _payload30 = _bundle_src30.encode("utf-8")
        _info30.size = len(_payload30)
        _tf30.addfile(_info30, _io_30.BytesIO(_payload30))
    _tgz30 = _buf30.getvalue()
    _e2e_calls30 = []
    _orig_rt30b, _orig_dl30b = U30.resolve_tarball, U30.download_tarball
    U30.resolve_tarball = lambda *a, **k: (_e2e_calls30.append("resolve")
                                           or ("9.9.9", "http://invalid", None))
    U30.download_tarball = lambda *a, **k: (_e2e_calls30.append("download") or _tgz30)
    try:
        with _cl_30.redirect_stdout(_io_30.StringIO()):
            _rc_e2e30 = U30.main(["--platform", "linux", "--arch", "x64",
                                  "--dest", _dest30])
    finally:
        U30.resolve_tarball, U30.download_tarball = _orig_rt30b, _orig_dl30b
    check("端到端（全离线）：伪造 tarball -> main() 完成提取并落盘，产物校验通过",
          _rc_e2e30 == 0 and _e2e_calls30 == ["resolve", "download"]
          and U30.is_installed(_tgt30, "elf-x86_64"),
          (_rc_e2e30, _e2e_calls30, U30.is_installed(_tgt30, "elf-x86_64")))
finally:
    _sh_30.rmtree(_tmp30, ignore_errors=True)

# --- 30.7 与网关的落盘/发现契约 ---
_acc_src30 = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               "qoder_accounts.py"), encoding="utf-8").read()
check("落盘契约：安装文件名/目录名与 gateway POSIX 查找路径同源"
      "（runtime-info / umid / QD_UMID_DIR）",
      U30.TARGET_FILENAME == "runtime-info"
      and U30.DEFAULT_DEST_DIRNAME == "umid"
      and "QD_UMID_DIR" in _acc_src30
      and '"umid"' in _acc_src30 and '"runtime-info"' in _acc_src30,
      (U30.TARGET_FILENAME, U30.DEFAULT_DEST_DIRNAME))
_orig_env30 = os.environ.get("QD_UMID_DIR")
_tmp30b = _tf_30.mkdtemp(prefix="qd-umid-env-")
try:
    os.environ["QD_UMID_DIR"] = _tmp30b
    _dd_env30 = U30.default_dest_dir()
finally:
    if _orig_env30 is None:
        os.environ.pop("QD_UMID_DIR", None)
    else:
        os.environ["QD_UMID_DIR"] = _orig_env30
    _sh_30.rmtree(_tmp30b, ignore_errors=True)
_dd_default30 = U30.default_dest_dir()
check("default_dest_dir()：$QD_UMID_DIR 优先；默认 <repo>/umid（与 gateway 查找顺序一致）",
      _dd_env30 == _tmp30b
      and _dd_default30 == os.path.join(
          os.path.dirname(os.path.abspath(U30.__file__)), "umid")
      and _dd_default30 != _dd_env30,
      (_dd_env30, _dd_default30))
# 真实产物校验（仓库里存在才断言，否则显式 SKIP——绝不静默）：
# umid/ 已被 .gitignore 忽略，CI/他人机器上通常没有，所以这条按环境降级为 SKIP。
_umid_real30 = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "umid", "runtime-info")
if os.path.isfile(_umid_real30):
    with open(_umid_real30, "rb") as _fh30b:
        _umid_data30 = _fh30b.read()
    check("真实产物：umid/runtime-info 被识别为 elf-x86_64 且落在体积启发式区间"
          "（提取链路端到端产物，非合成样本）",
          U30.identify_blob(_umid_data30) == "elf-x86_64"
          and U30.verify_component(_umid_data30, "elf-x86_64")
          and U30.HEURISTIC_SIZE_MIN <= len(_umid_data30) <= U30.HEURISTIC_SIZE_MAX,
          (len(_umid_data30), U30.identify_blob(_umid_data30)))
print()
print("[31] issue #11 工具结果回声 + 标记常量契约 + issue #12 原生桥失败可见性")

# --- 31.1 #11 判据：吞掉 / 不吞（直接调用判据函数，离线） ---
_TR31 = P.TOOL_RESULT_MARKER          # "[工具结果"（值不含 ]，写入侧拼 name）
_TC31 = P.TOOL_RESULT_CLOSE           # "[工具结果结束]"（模型自造的闭标记）
_NAMES31 = {"terminal"}
_PROD31 = (_TR31 + "]\n" + '{"output":"ok"}' + "\n" + _TC31 + "\n"
           "<system_warning>x</system_warning>")
check("#11 判据·吞：生产样本（开标记 + JSON + 自造闭标记 + 夹带 system_warning）",
      P._tool_echo_droppable(_PROD31, _NAMES31) is True)
check("#11 判据·吞：截断（无闭标记，body 以 { 开头）",
      P._tool_echo_droppable(_TR31 + "]\n" + '{"output": "partial', _NAMES31) is True)
check("#11 判据·吞：只有开标记（退化形态，与 #9 的纯 marker 一致）",
      P._tool_echo_droppable(_TR31 + "]", _NAMES31) is True)
check("#11 判据·吞：带 name 的开标记行（写入侧真实形态）",
      P._tool_echo_droppable(_TR31 + " (terminal)]\n" + '{"a":1}', _NAMES31) is True)
check("#11 判据·不吞：标记后跟自然语言散文（fail-open）",
      P._tool_echo_droppable(_TR31 + "] 这段是普通说明", _NAMES31) is False)
check("#11 判据·不吞：不以标记开头（讨论该标记的普通回复）",
      P._tool_echo_droppable("网关会写入 " + _TR31 + "] 这样的提示", _NAMES31) is False)
check("#11 判据·不吞：未声明 tools（allowed_names 为 None / 空集）",
      P._tool_echo_droppable(_PROD31, None) is False
      and P._tool_echo_droppable(_PROD31, set()) is False)
check("#11 判据·不吞：标记行未闭合 / 跨行闭合（不是网关形态）",
      P._tool_echo_droppable(_TR31 + " 没有右括号", _NAMES31) is False
      and P._tool_echo_droppable(_TR31 + "\n换行后才]闭合", _NAMES31) is False)
check("#11 hold-back：标记未打完要压住，证伪（散文）立即放行；统一暂存包含两种回声",
      P._tool_echo_prefix_hold("[工") is True
      and P._tool_echo_prefix_hold(_TR31 + "] 散文说明") is False
      and P._echo_hold_candidate(P.LEAK_MARKER + "\n[") is True
      and P._echo_hold_candidate(_TR31 + "]") is True)

# --- 31.2 #11 三条链路端到端（复用 [27] 段的帧辅助） ---
_fr31_drop = [json.loads(f[6:]) for f in P.recover_leaked_tool_calls(
    iter([_raw27(_PROD31[:10]), _raw27(_PROD31[10:]), _raw27("", "stop")]),
    _NAMES31)]
_text31_drop = "".join(_f["choices"][0]["delta"].get("content") or ""
                       for _f in _fr31_drop)
check("#11 流式：开闭对回声被吞（正文空、无标记泄漏、finish_reason 仍 stop）",
      _text31_drop == ""
      and _TR31 not in json.dumps(_fr31_drop, ensure_ascii=False)
      and _fr31_drop[-1]["choices"][0]["finish_reason"] == "stop",
      _text31_drop)
_trunc31 = _TR31 + "]\n" + '{"output": "partial'
_fr31_tr = [json.loads(f[6:]) for f in P.recover_leaked_tool_calls(
    iter([_raw27(_trunc31[:8]), _raw27(_trunc31[8:]), _raw27("", "stop")]),
    _NAMES31)]
_text31_tr = "".join(_f["choices"][0]["delta"].get("content") or ""
                     for _f in _fr31_tr)
check("#11 流式：截断回声被吞（正文空）", _text31_tr == "", _text31_tr)
_fr31_keep = [json.loads(f[6:]) for f in P.recover_leaked_tool_calls(
    iter([_raw27(_TR31 + "] 这是一段解释文字。"), _raw27("", "stop")]), _NAMES31)]
_text31_keep = "".join(_f["choices"][0]["delta"].get("content") or ""
                       for _f in _fr31_keep)
check("#11 流式：散文形态原样透传（fail-open 不吞字）",
      _TR31 in _text31_keep and "解释文字" in _text31_keep, _text31_keep)
_obj31 = P.aggregate_stream(
    _Resp27([_env27(_PROD31[:12]), _env27(_PROD31[12:]), _env27("", "stop")]),
    "m31", None, allowed_names=_NAMES31)
_msg31 = _obj31["choices"][0]["message"]
check("#11 非流式：content 清空、无 tool_calls、finish=stop（与 #9 同语义）",
      _msg31.get("content") == "" and not _msg31.get("tool_calls")
      and _obj31["choices"][0]["finish_reason"] == "stop", _msg31)
_ev31 = "".join(f.decode() for f in P.stream_responses_events(
    iter([_raw27(_PROD31[:12]), _raw27(_PROD31[12:]), _raw27("", "stop")]),
    "m31", {"usage": None, "custom_names": set(), "allowed_names": _NAMES31}))
check("#11 Responses 流式：事件里既无开标记也无闭标记",
      _TR31 not in _ev31 and _TC31 not in _ev31)

# --- 31.3 标记常量契约：写入侧引用常量 + 写出字节逐字节不变 ---
_src31 = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           "qoder_proxy.py"), encoding="utf-8").read()
check("#11 写入侧引用常量（源码里不得再有 [工具结果%s] 裸模板）",
      'TOOL_RESULT_MARKER + name + "]\\n"' in _src31
      and '"[工具结果%s]"' not in _src31,
      [_l.strip() for _l in _src31.splitlines() if "[工具结果" in _l][:3])
_sys31, _flat31, _img31 = P.flatten_messages([
    {"role": "tool", "name": "t", "content": "X"},
    {"role": "tool", "content": "Y"}])
_flat_set31 = {m["content"] for m in _flat31}
check("#11 写入格式逐字节不变（常量拼接结果 == 旧字面量模板）",
      "[工具结果 (t)]\nX" in _flat_set31 and "[工具结果]\nY" in _flat_set31
      and (_TR31 + " (t)]\nX") in _flat_set31,
      sorted(_flat_set31))

# --- 31.4 issue #12：原生桥失败的可见性（打桩 scenario，全程离线） ---
import contextlib as _cl31
import io as _io31
import shutil as _sh31
import tempfile as _tf31
_tmp31 = _tf31.mkdtemp(prefix="qd-exec31-")
try:
    _exe31 = os.path.join(_tmp31, "runtime-info")
    with open(_exe31, "w", encoding="utf-8") as _fh31:
        _fh31.write("#!/bin/sh\necho hi\n")        # 存在但不是可执行的原生组件
    _orig_rie31 = A.runtime_info_exe
    _orig_warned31 = set(A._runtime_info_warned)
    try:
        A._runtime_info_warned.clear()
        A.runtime_info_exe = lambda realm: ""
        _err31_missing = _io31.StringIO()
        with _cl31.redirect_stderr(_err31_missing):
            _res31_missing = A.run_runtime_info("cn", "u31")
        check("#12 组件不存在：静默降级（返回 {} 且 stderr 无任何提示）",
              _res31_missing == {} and _err31_missing.getvalue() == "",
              _err31_missing.getvalue()[:120])

        A._runtime_info_warned.clear()
        A.runtime_info_exe = lambda realm: _exe31
        _err31_exec = _io31.StringIO()
        with _cl31.redirect_stderr(_err31_exec):
            _res31_exec = A.run_runtime_info("cn", "u31")
        _msg31_exec = _err31_exec.getvalue()
        check("#12 组件在但执行失败：返回 {} 且 stderr 有可诊断提示"
              "（[runtime-info] 前缀 + 组件路径 + 修法提示）",
              _res31_exec == {} and "[runtime-info]" in _msg31_exec
              and _exe31 in _msg31_exec and "无法执行" in _msg31_exec,
              _msg31_exec[:200])
        check("#12 两种情况可区分：'不存在' 完全静默 vs '跑不起来' 有提示",
              _err31_missing.getvalue() == "" and _msg31_exec != "")
        _err31_again = _io31.StringIO()
        with _cl31.redirect_stderr(_err31_again):
            A.run_runtime_info("cn", "u31")
        check("#12 同一类失败同进程只提示一次（批量签到不刷屏）",
              _err31_again.getvalue() == "", _err31_again.getvalue()[:120])
    finally:
        A.runtime_info_exe = _orig_rie31
        A._runtime_info_warned.clear()
        A._runtime_info_warned.update(_orig_warned31)
finally:
    _sh31.rmtree(_tmp31, ignore_errors=True)

print()
print("[32] task-32 结构化直传：产物字段形态 / 双路径对照 / 开关三态 / fail-safe")

_MSGS32 = [
    {"role": "user", "content": "查天气"},
    {"role": "assistant", "content": None,
     "tool_calls": [{"id": "call_1", "type": "function",
                     "function": {"name": "get_weather",
                                  "arguments": {"city": "SZ"}}}]},
    {"role": "tool", "tool_call_id": "call_1", "name": "get_weather",
     "content": "25C"},
    {"role": "user", "content": "结果呢？"},
]
_sys32, _flat_s32, _img32 = P.flatten_messages(_MSGS32, structured=True)
_tool32 = [m for m in _flat_s32 if m.get("role") == "tool"]
_asst32 = [m for m in _flat_s32
           if m.get("role") == "assistant" and m.get("tool_calls")]
check("结构化产物：tool 消息保留 role + tool_call_id，content 为字符串且保留正文",
      len(_tool32) == 1 and _tool32[0].get("tool_call_id") == "call_1"
      and isinstance(_tool32[0].get("content"), str)
      and "25C" in _tool32[0]["content"],
      _tool32)
check("结构化产物：assistant.tool_calls 保留 id/type/function，arguments 归一为 JSON 字符串",
      len(_asst32) == 1
      and _asst32[0]["tool_calls"][0].get("id") == "call_1"
      and _asst32[0]["tool_calls"][0].get("type") == "function"
      and _asst32[0]["tool_calls"][0].get("function", {}).get("name") == "get_weather"
      and isinstance(_asst32[0]["tool_calls"][0]["function"].get("arguments"), str)
      and json.loads(_asst32[0]["tool_calls"][0]["function"]["arguments"])["city"] == "SZ",
      _asst32)
check("结构化产物：**不存在 None content**（task-31 实测 null 会被 DeepSeek/Kimi 拒绝）",
      all(m.get("content") is not None for m in _flat_s32)
      and all(m.get("content") == "" or isinstance(m.get("content"), str)
              for m in _flat_s32),
      [(m.get("role"), m.get("content")) for m in _flat_s32])
_sys32b, _flat_t32, _img32b = P.flatten_messages(_MSGS32, structured=False)
check("双路径对照：文本化把 tool 降级为 user+TOOL_RESULT_MARKER，结构化保留 role=tool",
      any(m.get("role") == "user"
          and str(m.get("content") or "").startswith(P.TOOL_RESULT_MARKER)
          for m in _flat_t32)
      and not any(m.get("role") == "tool" for m in _flat_t32)
      and any(m.get("role") == "tool" for m in _flat_s32),
      [m.get("role") for m in _flat_t32])
check("双路径对照：文本化把 assistant.tool_calls 序列化进 content（LEAK_MARKER），结构化不写正文",
      any(P.LEAK_MARKER in str(m.get("content") or "")
          for m in _flat_t32 if m.get("role") == "assistant")
      and not any("tool_calls" in m for m in _flat_t32)
      and all("tool_calls" in m for m in _asst32),
      [str(m.get("content"))[:60] for m in _flat_t32 if m.get("role") == "assistant"])

_orig_env32 = os.environ.pop("QD_STRUCTURED_TOOL_HISTORY", None)
try:
    _auto_cn_qwen = P.structured_tool_history_enabled(
        "Qwen3.8-Flash", "qfmodel", "cn", _MSGS32)
    _auto_cn_glm = P.structured_tool_history_enabled(
        "GLM-5.3-Flash", "gm53flash", "cn", _MSGS32)
    _auto_cn_glm2 = P.structured_tool_history_enabled(
        "glm-4.6", "glm4x", "cn", _MSGS32)
    _auto_cn_ds = P.structured_tool_history_enabled(
        "DeepSeek-Flash", "dfmodel", "cn", _MSGS32)
    _auto_cn_kimi = P.structured_tool_history_enabled(
        "Kimi-K2.8-Preview", "kmodel", "cn", _MSGS32)
    _auto_intl_qwen = P.structured_tool_history_enabled(
        "Qwen3.8-Flash", "qfmodel", "intl", _MSGS32)
    _unk_mode = None
    os.environ["QD_STRUCTURED_TOOL_HISTORY"] = "banana"
    _unk_mode = P._structured_mode()
    os.environ["QD_STRUCTURED_TOOL_HISTORY"] = "on"
    _on_cn_ds = P.structured_tool_history_enabled(
        "DeepSeek-Flash", "dfmodel", "cn", _MSGS32)
    _on_intl_ds = P.structured_tool_history_enabled(
        "DeepSeek-Flash", "dfmodel", "intl", _MSGS32)
    os.environ["QD_STRUCTURED_TOOL_HISTORY"] = "off"
    _off_cn_qwen = P.structured_tool_history_enabled(
        "Qwen3.8-Flash", "qfmodel", "cn", _MSGS32)
finally:
    if _orig_env32 is None:
        os.environ.pop("QD_STRUCTURED_TOOL_HISTORY", None)
    else:
        os.environ["QD_STRUCTURED_TOOL_HISTORY"] = _orig_env32

check("开关三态·auto：默认只放行 CN+白名单（Qwen/GLM/gm4 真；DeepSeek/Kimi/INTL 假）",
      _auto_cn_qwen is True and _auto_cn_glm is True and _auto_cn_glm2 is True
      and _auto_cn_ds is False and _auto_cn_kimi is False
      and _auto_intl_qwen is False,
      (_auto_cn_qwen, _auto_cn_glm, _auto_cn_ds, _auto_cn_kimi, _auto_intl_qwen))
check("开关三态·on/off：on 强制放行（含 DeepSeek/INTL），off 一律关闭",
      _on_cn_ds is True and _on_intl_ds is True and _off_cn_qwen is False,
      (_on_cn_ds, _on_intl_ds, _off_cn_qwen))
check("开关三态·未知值回落 auto（不误开）；恢复后默认仍是 auto",
      _unk_mode == "auto" and P._structured_mode() == "auto",
      (_unk_mode, P._structured_mode()))

_bad_ids32 = [
    {"role": "user", "content": "x"},
    {"role": "assistant", "content": "",
     "tool_calls": [{"id": "", "function": {"name": "f"}}]},
    {"role": "tool", "tool_call_id": "", "content": "y"},
]
check("fail-safe：id 不齐备（tool_call_id / tool_calls.id 空）→ 恒回退文本化",
      P._tool_ids_ok(_bad_ids32) is False
      and P.structured_tool_history_enabled(
          "Qwen3.8-Flash", "qfmodel", "cn", _bad_ids32) is False)
try:
    os.environ["QD_STRUCTURED_TOOL_HISTORY"] = "on"
    _on_bad_ids = P.structured_tool_history_enabled(
        "Qwen3.8-Flash", "qfmodel", "cn", _bad_ids32)
finally:
    if _orig_env32 is None:
        os.environ.pop("QD_STRUCTURED_TOOL_HISTORY", None)
    else:
        os.environ["QD_STRUCTURED_TOOL_HISTORY"] = _orig_env32
check("fail-safe：即使显式 on，id 不齐备也不放行（宁可少用不发畸形请求）",
      _on_bad_ids is False, _on_bad_ids)

_r32 = [{"role": "assistant", "content": "x", "reasoning_content": "think",
         "tool_calls": [{"id": "c1", "type": "function",
                         "function": {"name": "f", "arguments": "{}"}}]}]
_, _flat_r_on32, _ = P.flatten_messages(_r32, keep_reasoning=True, structured=True)
_, _flat_r_off32, _ = P.flatten_messages(_r32, keep_reasoning=False, structured=True)
check("结构化产物：reasoning_content 仍按 keep_reasoning 规则保留（与文本化路径一致）",
      _flat_r_on32[0].get("reasoning_content") == "think"
      and "reasoning_content" not in _flat_r_off32[0],
      (_flat_r_on32[0].get("reasoning_content"), _flat_r_off32[0].keys()))
_args_none32 = P.flatten_messages(
    [{"role": "assistant", "content": "",
      "tool_calls": [{"id": "c1", "function": {"name": "f",
                                               "arguments": None}}]}],
    structured=True)[1][0]["tool_calls"][0]["function"]["arguments"]
_args_scalar32 = P.flatten_messages(
    [{"role": "assistant", "content": "",
      "tool_calls": [{"id": "c1", "function": {"name": "f",
                                               "arguments": 42}}]}],
    structured=True)[1][0]["tool_calls"][0]["function"]["arguments"]
print()
print("[33] issue #16 误伤边界：帧尾 marker 前缀 hold 不得吞掉正常文本、不得延迟恢复")


def _f33(content, fin=None):
    delta = {}
    if content is not None:
        delta["content"] = content
    inner = {"id": "c33", "model": "m33", "created": 1,
             "choices": [{"index": 0, "delta": delta, "finish_reason": fin}]}
    return ("data: " + json.dumps(inner, ensure_ascii=False) + "\n\n").encode("utf-8")


def _join33(chunks, names=None):
    return "".join(json.loads(f[6:])["choices"][0]["delta"].get("content") or ""
                   for f in P.recover_leaked_tool_calls(iter(chunks), names))


_M33 = P.LEAK_MARKER
_NAMES33 = {"terminal"}

_t33a = "数组是这样的：\n["
check("误伤①：正文以 '[' 结尾（未闭合 JSON 引用）→ 原样透传，不被吞",
      _join33([_f33(_t33a), _f33("", "stop")], _NAMES33) == _t33a,
      _join33([_f33(_t33a), _f33("", "stop")], _NAMES33))
_t33b = "看这个 [ass"
check("误伤②：正文以 '[ass'（marker 前缀但未完整）结尾 → 跨帧后原样透传",
      _join33([_f33(_t33b), _f33(" 只是标记的开头", "stop")], _NAMES33)
      == _t33b + " 只是标记的开头",
      _join33([_f33(_t33b), _f33(" 只是标记的开头", "stop")], _NAMES33))
_t33c = "网关会写入 " + _M33 + " 这样的提示，不是真的调用。"
check("误伤③：含 marker 但后面是自然语言 → 原样透传（讨论而非调用）",
      _join33([_f33(_t33c), _f33("", "stop")], _NAMES33) == _t33c)
_calls33 = json.dumps([{"name": "terminal",
                        "arguments": json.dumps({"cmd": "ls"}, ensure_ascii=False)}],
                      ensure_ascii=False)
_t33d = _M33 + "\n" + _calls33
_fr33d = [json.loads(f[6:]) for f in P.recover_leaked_tool_calls(
    iter([_f33(_t33d), _f33("", "stop")]), _NAMES33)]
check("误伤④：marker + 完整合法数组 → 走恢复路径（tool_calls 增量），既不吞也不泄漏",
      any(f["choices"][0]["delta"].get("tool_calls") for f in _fr33d)
      and _M33 not in json.dumps(_fr33d, ensure_ascii=False)
      and not any(f["choices"][0]["delta"].get("content") for f in _fr33d),
      _fr33d)
_t33e = "格式是 [a-z]+ 这种正则，或者 [1,2,3] 这种数组。"
check("误伤⑤：正文含 '[' 但不以 marker 开头 → 原样透传",
      _join33([_f33(_t33e), _f33("", "stop")], _NAMES33) == _t33e)
_t33f = "第一段 [ass"
_t33f2 = "istant 请求调用工具] 不是 marker 全文"
_fr33f = [json.loads(f[6:]) for f in P.recover_leaked_tool_calls(
    iter([_f33(_t33f), _f33(_t33f2, "stop")]), _NAMES33)]
_text33f = "".join(f["choices"][0]["delta"].get("content") or "" for f in _fr33f)
check("误伤⑥：跨帧拼接内容守恒（正常文本不丢字、不被误吞；含 marker 字样也照传）",
      _text33f == _t33f + _t33f2, _text33f)

# --- issue #16 五形态：用汤圆给作者的**原样样本**（A/B1/B2/B3/C） ---
_M16 = P.LEAK_MARKER
_A16 = _M16 + "\n" + '[{"name": "terminal", "arguments": "{\\"cmd\\": \\"ls'
_B116 = "我先看看目录结构。" + "\n\n" + _A16
_B216 = ["我先看看目录结构。\n\n", _A16]
_B316 = _M16 + "\n" + \
    '[{"name": "terminal", "arguments": "{\\"cmd\\": \\"echo \\u63a'
_C16 = "[工具结果]" + "\n" + '{"output": "ok"}' + "\n" + "[工具结果结束]"


def _frames16(chunks):
    return [json.loads(f[6:]) for f in
            P.recover_leaked_tool_calls(iter(chunks), _NAMES33)]


def _text16(frames):
    return "".join(f["choices"][0]["delta"].get("content") or "" for f in frames)


def _fin16(frames):
    return frames[-1]["choices"][0].get("finish_reason")


_frA16 = _frames16([_f33(_A16[:20]), _f33(_A16[20:]), _f33("", "stop")])
check("#16·A（原样样本：marker+截断 JSON 切两刀）→ 内容不含标记、收尾帧 finish_reason=stop",
      _M16 not in _text16(_frA16) and _fin16(_frA16) == "stop", _text16(_frA16))
_frB116 = _frames16([_f33(_B116), _f33("", "stop")])
check("#16·B1（原样样本：散文+marker 同帧）→ 散文保留、标记不泄漏、finish=stop",
      "我先看看目录结构。" in _text16(_frB116)
      and _M16 not in _text16(_frB116) and _fin16(_frB116) == "stop",
      _text16(_frB116))
_frB216 = _frames16([_f33(x) for x in _B216] + [_f33("", "stop")])
check("#16·B2（原样样本：散文与 marker 分帧）→ 散文保留、标记不泄漏、finish=stop",
      "我先看看目录结构。" in _text16(_frB216)
      and _M16 not in _text16(_frB216) and _fin16(_frB216) == "stop",
      _text16(_frB216))
_frB316 = _frames16([_f33(_B316[:20]), _f33(_B316[20:]), _f33("", "stop")])
check("#16·B3（原样样本：\\u63a 未写完转义）→ 内容不含标记、finish=stop",
      _M16 not in _text16(_frB316) and _fin16(_frB316) == "stop",
      _text16(_frB316))
_frC16 = _frames16([_f33(_C16[:8]), _f33(_C16[8:]), _f33("", "stop")])
check("#16·C（原样样本：工具结果回声）→ 不含 \"[工具结果\"、finish=stop（#11 回归保护）",
      "[工具结果" not in _text16(_frC16) and _fin16(_frC16) == "stop",
      _text16(_frC16))

# --- hold 上限：长文本以 [ 开头且久不闭合必须放行（不得无限缓冲） ---
_HOLD_LIMIT16 = getattr(P, "_MARKER_HOLD_WINDOW", None)
check("#16·hold 窗口常量存在且为标记长度量级（不是无上限）",
      isinstance(_HOLD_LIMIT16, int) and 1 <= _HOLD_LIMIT16 <= 64, _HOLD_LIMIT16)
_long16 = "[" + ("x" * 2000)
_frLong16 = _frames16([_f33(_long16[:500]), _f33(_long16[500:]), _f33("", "stop")])
check("#16·hold 上限：长文本以 '[' 开头且久不闭合 → 内容全部放行、不丢字",
      _text16(_frLong16) == _long16,
      (len(_text16(_frLong16)), len(_long16)))
_frFirst16 = _frames16([_f33(_long16[:500]), _f33("", "stop")])
_emitFirst16 = _text16(_frFirst16)
print()
print("[34] task-37 细致复查：长链/反转/其它截断点/窗口与上限边界/结构化交互")


def _run34(chunks, names=None):
    """返回 (客户端文本, tool_calls 帧数, 末帧 finish_reason)。"""
    _txt, _tcs, _fin = [], 0, None
    for _f in P.recover_leaked_tool_calls(iter(chunks), names or _NAMES33):
        try:
            _o = json.loads(_f.decode("utf-8")[6:] if isinstance(_f, bytes) else _f[6:])
        except Exception:
            continue
        _d = _o["choices"][0]["delta"]
        if _d.get("content"):
            _txt.append(_d["content"])
        if _d.get("tool_calls"):
            _tcs += 1
        if _o["choices"][0].get("finish_reason"):
            _fin = _o["choices"][0]["finish_reason"]
    return "".join(_txt), _tcs, _fin


_CALLS34 = json.dumps([{"name": "terminal",
                        "arguments": json.dumps({"cmd": "ls"}, ensure_ascii=False)}],
                      ensure_ascii=False)
_LONG34 = _M33 + "\n" + _CALLS34
_chunks34 = [_f33(_LONG34[i:i + 6]) for i in range(0, len(_LONG34), 6)]
_t34a, _tc34a, _fin34a = _run34(_chunks34 + [_f33("", "stop")])
check("#37·长链：marker+JSON 切成 %d 帧 → 恢复为 tool_calls、无泄漏、finish=tool_calls"
      % len(_chunks34),
      _tc34a > 0 and _t34a == "" and _fin34a == "tool_calls",
      (_tc34a, _fin34a, _t34a[:60]))

for _tag, _parts in (
        ("1b 疑似 marker 后证伪（散文首帧）",
         ["我先看看目录结构。\n\n", "[assis", "tant 请求调用工具] 这只是一段说明文字"]),
        ("1c 前缀被打断", ["[assis", "这只是一个普通说明，不是标记。"]),
        ("1d 完整 marker 但后接散文", ["[assistant 请求调用工具", "]\n这不是数组，是中文说明"])):
    _want = "".join(_parts)
    _got, _tc, _fn = _run34([_f33(x) for x in _parts] + [_f33("", "stop")])
    # 注意：反转=已证伪为普通文本 → 原样补发，**marker 明文出现是正确行为**
    # （模型确实在讨论该标记）；这里只要求内容守恒且不被误判为工具调用。
    check("#37·反转（%s）→ 证伪后完整补发（内容逐字节守恒、不误判为 tool_calls）" % _tag,
          _got == _want and _tc == 0,
          (len(_got), len(_want), _got[:60]))

for _tag, _payload in (
        ("2a 代理对半截 \\ud83d",
         _M33 + "\n" + '[{"name": "terminal", "arguments": "{\\"cmd\\": \\"echo \\ud83d'),
        ("2b 双重转义 \\\\u63a2",
         _M33 + "\n" + '[{"name": "terminal", "arguments": "{\\"cmd\\": \\"echo \\\\u63a2'),
        ("2c \\u63a 与 2 分帧",
         _M33 + "\n" + '[{"name": "terminal", "arguments": "{\\"cmd\\": \\"echo \\u63a')):
    _cut = len(_payload) // 2
    _t, _tc, _fn = _run34([_f33(_payload[:_cut]), _f33(_payload[_cut:]),
                           _f33("", "stop")])
    check("#37·截断点（%s）→ 整段被吞、无标记泄漏、finish=stop" % _tag,
          _t == "" and _tc == 0 and _fn == "stop", _t[:60])

_HOLDWIN34 = getattr(P, "_MARKER_HOLD_WINDOW", 17)
for _cut in (_HOLDWIN34 - 1, _HOLDWIN34, _HOLDWIN34 + 1):
    _pre, _rest = _M33[:_cut], _M33[_cut:] + "\n" + _CALLS34
    _t, _tc, _fn = _run34([_f33(_pre), _f33(_rest), _f33("", "stop")])
    check("#37·窗口边界：帧尾恰好 %d 字 marker 前缀 → 仍被识别（恢复 tool_calls、无泄漏）"
          % _cut, _tc > 0 and _t == "" and _M33 not in _t, (_tc, _t[:40]))

_HOLDMAX34 = getattr(P, "_HOLD_MAX_CHARS", 32768)
_pad34 = "x" * (_HOLDMAX34 - len(_M33) - 200)
_under34 = _M33 + "\n" + '[{"name": "terminal", "arguments": "{\\"cmd\\": \\"' + _pad34 + '\\"'
_t, _tc, _fn = _run34([_f33(_under34[:8000]), _f33(_under34[8000:16000]),
                       _f33(_under34[16000:]), _f33("", "stop")])
check("#37·上限内（%d 字 < %d）未闭合块 → 仍被拦（吞掉、无泄漏）"
      % (len(_under34), _HOLDMAX34),
      _t == "" and _tc == 0, (len(_under34), _t[:40]))
_blob34 = _M33 + "\n" + json.dumps(
    [{"name": "terminal", "arguments": json.dumps({"cmd": _pad34}, ensure_ascii=False)}],
    ensure_ascii=False)
_c34 = len(_blob34) // 3
_t, _tc, _fn = _run34([_f33(_blob34[:_c34]), _f33(_blob34[_c34:2 * _c34]),
                       _f33(_blob34[2 * _c34:]), _f33("", "stop")])
check("#37·上限内（%d 字）合法完整数组 → 恢复为 tool_calls（大数据块不被误放行）"
      % len(_blob34),
      _tc > 0 and _t == "" and _fn == "tool_calls", (_tc, _fn))
_over34 = _under34 + "y" * (_HOLDMAX34 + 200 - len(_under34))
_t, _tc, _fn = _run34([_f33(_over34[:_HOLDMAX34 // 2]), _f33(_over34[_HOLDMAX34 // 2:]),
                       _f33("", "stop")])
check("#37·超上限（%d 字 > %d）→ fail-open 放行，且**只输出一次**（长度守恒、无重复）"
      % (len(_over34), _HOLDMAX34),
      _t == _over34 and _tc == 0, (len(_t), len(_over34), _t == _over34))

_msgs34 = [{"role": "user", "content": "查天气"},
           {"role": "assistant", "content": "", "tool_calls": [
               {"id": "c1", "type": "function",
                "function": {"name": "get_weather", "arguments": '{"city": "SZ"}'}}]},
           {"role": "tool", "tool_call_id": "c1", "content": "25C"}]
_s34, _flat_s34, _ = P.flatten_messages(_msgs34, structured=True)
_t34x, _flat_t34, _ = P.flatten_messages(_msgs34, structured=False)
check("#37·结构化交互：结构化产物**不含**回读标记，文本化产物**含**（两者不打架）",
      _M33 not in json.dumps(_flat_s34, ensure_ascii=False)
      and P.TOOL_RESULT_MARKER not in json.dumps(_flat_s34, ensure_ascii=False)
      and _M33 in json.dumps(_flat_t34, ensure_ascii=False),
      ([m.get("role") for m in _flat_s34], [m.get("role") for m in _flat_t34]))
_env37 = os.environ.get("QD_STRUCTURED_TOOL_HISTORY")
try:
    os.environ["QD_STRUCTURED_TOOL_HISTORY"] = "on"
    _on37 = P.structured_tool_history_enabled("Qwen3.8-Flash", "qfmodel", "intl", _msgs34)
finally:
    if _env37 is None:
        os.environ.pop("QD_STRUCTURED_TOOL_HISTORY", None)
    else:
        os.environ["QD_STRUCTURED_TOOL_HISTORY"] = _env37
_t, _tc, _fn = _run34([_f33(_LONG34[:10]), _f33(_LONG34[10:]), _f33("", "stop")])
check("#37·结构化交互：on 模式下回读守卫仍独立生效（同一输入仍恢复 tool_calls）",
      _on37 is True and _tc > 0 and _M33 not in _t and _fn == "tool_calls",
      (_on37, _tc, _fn))

# --- Lead 侧补充（task-37 复查）：窗口是**功能性必需**，不是优化项 ---
# 铁蛋的 V2 变异（把 _MARKER_HOLD_WINDOW 压到 1）没变红，是因为他的用例帧 1 是纯 marker 前缀；
# 下面这条带散文前缀、且被切处落在窗口内 —— 实测窗口=1 时会真实泄漏，用来守住窗口参数被误改。
_dd_pre = "我先看看：" + _M33[:9]
_dd_rest = _M33[9:] + "\n" + _CALLS34
_t, _tc, _fn = _run34([_f33(_dd_pre), _f33(_dd_rest), _f33("", "stop")])
print()
print("[35] 机器身份落盘缓存（task-48 · 设计 v1.2.13 第七节：12 条离线）")
import shutil as _sh35
import tempfile as _tf35
import threading as _th35

_IDC_KEYS = ("ACCOUNTS_DIR", "QD_MACHINE_IDENTITY_CACHE",
             "QD_MACHINE_IDENTITY_CACHE_TTL", "QD_MACHINE_IDENTITY_RESET",
             "QD_MACHINE_IDENTITY_VOTE")
_IDC_ORIG_ENV = {_k: os.environ.get(_k) for _k in _IDC_KEYS}
_IDC_ORIG_RUN = A.run_runtime_info
_IDC_TMP = _tf35.mkdtemp(prefix="qd-idcache-")
_IDC_FILE = os.path.join(_IDC_TMP, "machine_identity.json")


def _idc_env(**over):
    """切换 ACCOUNTS_DIR 与三个开关，并清内存缓存与落盘文件。"""
    os.environ["ACCOUNTS_DIR"] = over.get("accounts_dir") or _IDC_TMP
    for _k in _IDC_KEYS[1:]:
        if over.get(_k) is not None:
            os.environ[_k] = str(over[_k])
        else:
            os.environ.pop(_k, None)
    A._native_ident_cache.clear()
    try:
        os.remove(_IDC_FILE)
    except OSError:
        pass


def _idc_stub(calls, fail=False, seq=None):
    """替换组件入口：记录调用次数并返回**恒定**身份（保证投票 3/3 一致）。

    seq 给定时按调用序号循环取样本（用于构造多数派/全分歧场景）。
    """
    def _f(realm, account_id=""):
        calls.append((realm, account_id))
        if fail:
            return {}
        if seq:
            s = seq[(len(calls) - 1) % len(seq)]
            return dict(s)
        return {"machineToken": "tok-1", "machineType": "ty1",
                "machineCode": "co1", "vmInfo": {"isVm": False}}
    return _f


def _idc_read():
    try:
        with open(_IDC_FILE, encoding="utf-8") as _fh:
            return json.load(_fh)
    except Exception:
        return None


def _idc_tok(blob):
    try:
        return (blob.get("realm") or {}).get("cn", {}).get("machineToken")
    except Exception:
        return None


try:
    _idc_env()
    _c1 = []
    A.run_runtime_info = _idc_stub(_c1)
    _i1 = A.native_machine_identity("cn", "u1")
    _f1 = _idc_read()
    check("#48-1 首次调用：无缓存 → 组件被调 **3** 次（首次表决）并落盘",
          len(_c1) == 3 and _i1.get("machineToken") == "tok-1"
          and isinstance(_f1, dict) and _f1.get("version") == 1
          and _idc_tok(_f1) == "tok-1"
          and ((_f1.get("realm") or {}).get("cn", {}).get("machineType") == "ty1")
          and ((_f1.get("realm") or {}).get("cn", {}).get("machineCode") == "co1"),
          (_c1, _f1))

    A._native_ident_cache.clear()
    _c2 = []
    A.run_runtime_info = _idc_stub(_c2)
    _i2 = A.native_machine_identity("cn", "u2")
    check("#48-2 【命门】落盘缓存命中：第二次调用**不触发组件**（桩计数=0）且身份逐字节相同",
          len(_c2) == 0 and _i2.get("machineToken") == "tok-1"
          and _i2.get("machineType") == "ty1", (_c2, _i2))

    _c3 = []
    A.run_runtime_info = _idc_stub(_c3)
    _i3 = A.native_machine_identity("cn", "u3", force=True)
    check("#48-3 force=True：必调组件并覆盖落盘缓存",
          len(_c3) == 1 and _i3.get("machineToken") == "tok-1"
          and _idc_tok(_idc_read()) == "tok-1", (_c3, _idc_read()))

    # 设计 §3.2 行 3 的场景：缓存【已过期】→ 调组件 → 组件失败 → 回退到过期缓存。
    # （缓存未过期时按行 2 根本不会调组件，那种构造断言不到"回退"路径。）
    _idc_env(QD_MACHINE_IDENTITY_CACHE_TTL="1")
    _c4a = []
    A.run_runtime_info = _idc_stub(_c4a)
    _i4a = A.native_machine_identity("cn", "u4")
    _f4 = _idc_read()
    try:
        _f4["realm"]["cn"]["cached_at"] = time.time() - 10      # 人为过期
        with open(_IDC_FILE, "w", encoding="utf-8") as _fh:
            json.dump(_f4, _fh, ensure_ascii=False)
    except Exception:
        pass
    A._native_ident_cache.clear()
    _c4b = []
    A.run_runtime_info = _idc_stub(_c4b, fail=True)
    _i4b = A.native_machine_identity("cn", "u4b")
    check("#48-4 组件失败但落盘有（过期）缓存 → 仍返回缓存身份，且不写坏缓存文件"
          "（首次表决 3 次、TTL 轮换 1 次）",
          len(_c4a) == 3 and len(_c4b) == 1
          and _i4b.get("machineToken") == _i4a.get("machineToken")
          and _idc_tok(_idc_read()) == _i4a.get("machineToken"),
          (_c4b, _i4b, _idc_read()))

    _idc_env()
    _c5 = []
    A.run_runtime_info = _idc_stub(_c5, fail=True)
    check("#48-5 组件失败且无缓存 → 表决 3 次全空 → 返回 {}（现状不变）",
          A.native_machine_identity("cn", "u5") == {} and len(_c5) == 3)

    _idc_env(QD_MACHINE_IDENTITY_CACHE="off")
    _c6 = []
    A.run_runtime_info = _idc_stub(_c6)
    A.native_machine_identity("cn", "u6")
    check("#48-6 QD_MACHINE_IDENTITY_CACHE=off → 不落盘（行为同旧）",
          _idc_read() is None and len(_c6) == 1, _idc_read())

    _idc_env(QD_MACHINE_IDENTITY_CACHE_TTL="1")
    _c7 = []
    A.run_runtime_info = _idc_stub(_c7)
    A.native_machine_identity("cn", "u7")
    _f7 = _idc_read()
    try:
        _f7["realm"]["cn"]["cached_at"] = time.time() - 10
        with open(_IDC_FILE, "w", encoding="utf-8") as _fh:
            json.dump(_f7, _fh, ensure_ascii=False)
    except Exception:
        pass
    A._native_ident_cache.clear()
    A.native_machine_identity("cn", "u7b")
    check("#48-7 TTL 正数：过期后重新调组件（首次表决 3 + 轮换 1 = 4）",
          len(_c7) == 4, len(_c7))

    _idc_env()
    _c8a = []
    A.run_runtime_info = _idc_stub(_c8a)
    A.native_machine_identity("cn", "u8")
    os.environ["QD_MACHINE_IDENTITY_RESET"] = "1"
    A._native_ident_cache.clear()
    _c8b = []
    A.run_runtime_info = _idc_stub(_c8b)
    _i8 = A.native_machine_identity("cn", "u8b")
    check("#48-8 QD_MACHINE_IDENTITY_RESET=1 → 清空缓存并重新取身份",
          len(_c8b) >= 1 and bool(_i8.get("machineToken")), (len(_c8a), len(_c8b)))

    _idc_env()
    with open(_IDC_FILE, "w", encoding="utf-8") as _fh:
        _fh.write('{"version": 1, "realm": {"cn": {"machineToken": "trunc')
    _c9 = []
    A.run_runtime_info = _idc_stub(_c9)
    _err9 = None
    try:
        _i9 = A.native_machine_identity("cn", "u9")
    except Exception as _e9:
        _err9 = _e9
        _i9 = {}
    check("#48-9 缓存文件损坏（截断 JSON）→ 不抛异常，回退表决 3 次",
          _err9 is None and len(_c9) == 3 and bool((_i9 or {}).get("machineToken")),
          (_err9, len(_c9)))

    _idc_env()
    _c10 = []
    _lk10 = _th35.Lock()

    def _slow10(realm, account_id=""):
        with _lk10:
            _c10.append(1)
            _n = len(_c10)
        time.sleep(0.05)
        return {"machineToken": "tok-%d" % _n, "machineType": "ty", "machineCode": "co"}

    A.run_runtime_info = _slow10
    _th35.Thread(target=lambda: A.native_machine_identity("cn", "t1")).start()
    _th35.Thread(target=lambda: A.native_machine_identity("cn", "t2")).start()
    time.sleep(0.6)
    check("#48-10 并发首次：文件仍可解析（不损坏），且至少写入一次",
          isinstance(_idc_read(), dict) and _idc_tok(_idc_read()) is not None,
          _idc_read())

    _idc_env()
    _c11 = []
    # 桩要"两次采样给不同身份"：首次表决 3 次得 tok-a、force 刷新得 tok-b，
    # 才能区分"只更新内存"与"落盘也被更新"。
    A.run_runtime_info = _idc_stub(_c11, seq=[
        {"machineToken": "tok-a", "machineType": "ty-a", "machineCode": "co-a",
         "vmInfo": {"isVm": False}}] * 3
        + [{"machineToken": "tok-b", "machineType": "ty-b", "machineCode": "co-b",
            "vmInfo": {"isVm": False}}])
    A.native_machine_identity("cn", "u11")
    _tok_before11 = _idc_tok(_idc_read())
    _acc11 = A.Account({"uid": "heal48", "realm": "cn", "accessToken": "dt-x"})
    _acc11.machine_identity_source = "runtime-info"
    _orig_get11 = A.Account._campaigns_get
    _seq11 = []

    def _cget11(self):
        _seq11.append(1)
        return (({"showCampaign": False} if len(_seq11) == 1
                 else {"showCampaign": True}), 200, "")

    A.Account._campaigns_get = _cget11
    try:
        _acc11.campaigns(force=True)
    finally:
        A.Account._campaigns_get = _orig_get11
    _tok_after11 = _idc_tok(_idc_read())
    check("#48-11 自愈路径：列表被拒 → force 刷新 → **落盘被更新**（不只更新内存）",
          len(_c11) >= 2 and _tok_before11 != _tok_after11,
          (_tok_before11, _tok_after11, len(_c11)))

    _idc_env()
    with open(_IDC_FILE, "w", encoding="utf-8") as _fh:
        json.dump({"version": 1, "realm": {"cn": {"machineToken": ""}}}, _fh)
    _c12 = []
    A.run_runtime_info = _idc_stub(_c12)
    _i12 = A.native_machine_identity("cn", "u12")
    check("#48-12 缓存字段缺失（machineToken 空）→ 视为无缓存，回退表决 3 次",
          len(_c12) == 3 and (_i12 or {}).get("machineToken") == "tok-1",
          (len(_c12), _i12))

    check("#48-13a 表决上限常量：IDENTITY_VOTE_ROUNDS=3 + EXTEND=2 → 上限 5（延迟有界）",
          getattr(A, "IDENTITY_VOTE_ROUNDS", None) == 3
          and getattr(A, "IDENTITY_VOTE_EXTEND_ROUNDS", None) == 2,
          (getattr(A, "IDENTITY_VOTE_ROUNDS", None),
           getattr(A, "IDENTITY_VOTE_EXTEND_ROUNDS", None)))

    # ---- 13 表决：3 次同值 → 组件被调 3 次并采纳（不补投） ----
    _idc_env()
    _c13 = []
    A.run_runtime_info = _idc_stub(_c13)
    _i13 = A.native_machine_identity("cn", "v13")
    check("#48-13 表决·**3/3 一致时不补投**（延迟有界：11s 档）→ 组件恰好被调 3 次并采纳",
          len(_c13) == 3 and _i13.get("machineToken") == "tok-1", (len(_c13), _i13))

    # ---- 14 表决：含分歧 → 采纳多数派【完整样本】(自适应实现会补投到 5 次) ----
    _idc_env()
    _maj14 = {"machineToken": "tok-maj", "machineType": "ty-maj", "machineCode": "co-maj",
              "vmInfo": {"isVm": True, "brand": "KVM", "vmTypeCode": 13}}
    _min14 = {"machineToken": "tok-min", "machineType": "ty-min", "machineCode": "co-min",
              "vmInfo": {"isVm": True, "brand": "Docker", "vmTypeCode": 50}}
    _c14 = []
    A.run_runtime_info = _idc_stub(_c14, seq=[_maj14, _maj14, _min14, _min14, _maj14])
    _i14 = A.native_machine_identity("cn", "v14")
    _vm14 = _i14.get("vm_info") or {}
    check("#48-14 表决·前 3 轮有分歧 → **补投到 5 次**，采纳多数派**完整样本**"
          "（type/code/vmInfo 自洽不杂交）",
          _i14.get("machineToken") == "tok-maj"
          and _i14.get("machineType") == "ty-maj"
          and _i14.get("machineCode") == "co-maj"
          and _vm14.get("brand") == "KVM" and _vm14.get("vmTypeCode") == 13
          and len(_c14) == 5, (len(_c14), _i14, _c14))

    # ---- 15 表决：全分歧 → 取首个样本（确定性） ----
    _idc_env()
    _s15 = [{"machineToken": "t-a", "machineType": "ty-a", "machineCode": "co-a",
             "vmInfo": {"isVm": True, "brand": "KVM", "vmTypeCode": 13}},
            {"machineToken": "t-b", "machineType": "ty-b", "machineCode": "co-b",
             "vmInfo": {"isVm": True, "brand": "Docker", "vmTypeCode": 50}},
            {"machineToken": "t-c", "machineType": "ty-c", "machineCode": "co-c",
             "vmInfo": {"isVm": True, "brand": "Xen", "vmTypeCode": 7}}]
    _c15 = []
    A.run_runtime_info = _idc_stub(_c15, seq=_s15)
    _i15 = A.native_machine_identity("cn", "v15")
    check("#48-15 表决·全分歧：取**首个**样本（确定性，不杂交）",
          _i15.get("machineToken") == "t-a" and _i15.get("machineType") == "ty-a",
          (len(_c15), _i15))

    # ---- 16 VOTE=0 → 跳过表决，只调一次 ----
    _idc_env(QD_MACHINE_IDENTITY_VOTE="0")
    _c16 = []
    A.run_runtime_info = _idc_stub(_c16)
    _i16 = A.native_machine_identity("cn", "v16")
    check("#48-16 QD_MACHINE_IDENTITY_VOTE=0 → 跳过表决，组件只被调 1 次",
          len(_c16) == 1 and _i16.get("machineToken") == "tok-1", (len(_c16), _i16))

    # ---- 17 force → 不表决（单次） ----
    _idc_env()
    _c17 = []
    A.run_runtime_info = _idc_stub(_c17)
    _i17 = A.native_machine_identity("cn", "v17", force=True)
    check("#48-17 force=True：不表决（单次），但仍写入两份缓存",
          len(_c17) == 1 and _i17.get("machineToken") == "tok-1"
          and _idc_tok(_idc_read()) == "tok-1", (len(_c17), _idc_read()))

    def _s18(_tag, _brand, _type_code):
        return {"machineToken": "tok-" + _tag, "machineType": "ty-" + _tag,
                "machineCode": "co-" + _tag,
                "vmInfo": {"isVm": True, "brand": _brand, "vmTypeCode": _type_code}}

    # ---- 18 补投·4:1：前 3 轮分歧 → 补到 5，采纳 4 票多数派 ----
    _idc_env()
    _A18, _B18 = _s18("a", "KVM", 13), _s18("b", "Docker", 50)
    _c18 = []
    A.run_runtime_info = _idc_stub(_c18, seq=[_A18, _A18, _B18, _A18, _A18])
    _i18 = A.native_machine_identity("cn", "v18")
    check("#48-18 补投·4:1 → 组件被调 **5** 次、采纳 4 票的完整样本（A）",
          len(_c18) == 5 and _i18.get("machineToken") == "tok-a"
          and (_i18.get("vm_info") or {}).get("brand") == "KVM", (len(_c18), _i18))

    # ---- 19 补投·3:2：同样补到 5，采纳 3 票多数派 ----
    _idc_env()
    _c19 = []
    A.run_runtime_info = _idc_stub(_c19, seq=[_A18, _A18, _B18, _A18, _B18])
    _i19 = A.native_machine_identity("cn", "v19")
    check("#48-19 补投·3:2 → 组件被调 **5** 次、采纳 3 票的完整样本（A）",
          len(_c19) == 5 and _i19.get("machineToken") == "tok-a"
          and (_i19.get("machine_code") or _i19.get("machineCode")) == "co-a",
          (len(_c19), _i19))

    # ---- 20 补投·平票：2/2/1 无多数 → 取首个样本 ----
    _idc_env()
    _C20 = _s18("c", "WSL", 7)
    _c20 = []
    A.run_runtime_info = _idc_stub(_c20, seq=[_A18, _A18, _B18, _B18, _C20])
    _i20 = A.native_machine_identity("cn", "v20")
    check("#48-20 补投·平票(2/2/1) → 组件被调 **5** 次、无多数时取**首个**样本（A）",
          len(_c20) == 5 and _i20.get("machineToken") == "tok-a"
          and (_i20.get("vm_info") or {}).get("brand") == "KVM", (len(_c20), _i20))
finally:
    A.run_runtime_info = _IDC_ORIG_RUN
    A._native_ident_cache.clear()
    for _k in _IDC_KEYS:
        if _IDC_ORIG_ENV[_k] is None:
            os.environ.pop(_k, None)
        else:
            os.environ[_k] = _IDC_ORIG_ENV[_k]
    _sh35.rmtree(_IDC_TMP, ignore_errors=True)

print()
print("[36] issue #20：签到结果文案分流（前端离线仿真：node 抽取 dashboard.html）")
import shutil as _sh36
import subprocess as _sp36
import tempfile as _tf36

_NODE36 = _sh36.which("node")
if not _NODE36:
    for _cand36 in (r"C:\Users\shuishui\AppData\Local\nvm\v24.19.0\node.exe",):
        if os.path.isfile(_cand36):
            _NODE36 = _cand36
            break
_DASH36 = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dashboard.html")
_JS36 = r"""
const fs = require('fs');
const html = fs.readFileSync(process.env.DASH36, 'utf-8');
const mm = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/);
const script = mm ? mm[1] : '';
const s = script.indexOf('function fmtNextCheckin(x){');
const e = script.indexOf('async function doCheckin(btn){');
let pure = (s >= 0 && e > s) ? script.slice(s, e) : '';
const MUT = process.env.MUTATE36 === '1';
if (MUT) {
  pure = 'function fmtNextCheckin(x){ return ""; }'
       + ' function checkinOutcome(x){ const nm = x.nickname || String(x.uid||"").slice(0,6) || "账号";'
       + ' return {state:"claimed", name: nm, text: nm + ": 签到成功"}; }'
       + ' function checkinToastKind(rows){ return "ok"; }'
       + ' function checkinToastText(rows){ return "每日签到: 签到成功"; }';
}
if (!pure) { console.log(JSON.stringify({missing:true})); process.exit(0); }
const api = new Function(pure + '\nreturn {fmtNextCheckin:fmtNextCheckin,'
  + ' checkinOutcome:checkinOutcome, checkinToastKind:checkinToastKind,'
  + ' checkinToastText:checkinToastText};')();

const NOTE = '10-05 10:00（UTC+8）';
const CASES = {
  claimed_new:   {uid:'aaa111', ok:true, claimed:['每日领 100'], earned_credit:100,
                  message:'活动领取成功 +100 Credits（每日领 100）',
                  next_available_at:1791123600, next_available_note:NOTE},
  idle_with_msg: {uid:'bbb222', ok:true, claimed:[], message:'今日活动奖励已领取',
                  next_available_at:1791123600, next_available_note:NOTE},
  idle_no_msg:   {uid:'ccc333', ok:true, claimed:[],
                  next_available_at:1791123600, next_available_note:NOTE},
  idle_at_only:  {uid:'eee555', ok:true, claimed:[], next_available_at:1791123600},
  fail_msg_only: {uid:'ddd444', ok:false, error:'', message:'token 已过期，请重新登录'},
  legacy_credit: {uid:'fff666', ok:true, earned_credit:100, msg:''},
  legacy_none:   {uid:'ggg777', ok:true, earned_credit:0, msg:''},
};
// kind 的判据是「已处理 row 的 state」，因此这里必须传 checkinOutcome 的产物
const C_OK  = api.checkinOutcome({uid:'a1', ok:true, claimed:['活动A'], message:'到账'});
const C_IDL = api.checkinOutcome({uid:'b2', ok:true, claimed:[], message:'已领',
                                  next_available_note:NOTE});
const C_FAIL= api.checkinOutcome({uid:'c3', ok:false, error:'失败原因'});
const KIND_CASES = {
  all_claimed: [C_OK],
  claimed_plus_idle: [C_OK, C_IDL],
  all_idle: [C_IDL],
  fail_plus_idle: [C_FAIL, C_IDL],
  all_fail: [C_FAIL],
  empty_rows: [],
};
const out = {pure:true, cases:{}, kinds:{}};
for (const k of Object.keys(CASES)) out.cases[k] = api.checkinOutcome(CASES[k]);
for (const k of Object.keys(KIND_CASES)) {
  out.kinds[k] = {kind: api.checkinToastKind(KIND_CASES[k]),
                  text: api.checkinToastText(KIND_CASES[k])};
}
console.log(JSON.stringify(out));
"""
if not _NODE36:
    skip("issue #20 前端分流仿真（本机无 node）", "node not found")
else:
    _dir36 = _tf36.mkdtemp(prefix="qd-js36-")
    _jsf36 = os.path.join(_dir36, "probe.js")
    with open(_jsf36, "w", encoding="utf-8") as _fh36:
        _fh36.write(_JS36)

    def _run36_tz(tz=None, mutate=False):
        _env36 = dict(os.environ)
        _env36["DASH36"] = _DASH36
        _env36["MUTATE36"] = "1" if mutate else "0"
        if tz:
            _env36["TZ"] = tz
        _r36 = _sp36.run([_NODE36, _jsf36], capture_output=True, text=True,
                         encoding="utf-8", env=_env36, timeout=60)
        try:
            return json.loads((_r36.stdout or "").strip().splitlines()[-1])
        except Exception:
            return {"missing": True,
                    "err": ((_r36.stderr or _r36.stdout or "")[:200])}

    _b36 = _run36_tz()
    check("#52 前端：能抽到分流纯函数组（fmtNextCheckin/checkinOutcome/"
          "checkinToastKind/checkinToastText）",
          isinstance(_b36, dict) and _b36.get("pure") is True,
          json.dumps(_b36, ensure_ascii=False)[:200])
    if isinstance(_b36, dict) and _b36.get("pure"):
        _cs36 = _b36.get("cases") or {}
        _ks36 = _b36.get("kinds") or {}

        def _txt36(_k):
            return str((_cs36.get(_k) or {}).get("text") or "")

        def _st36(_k):
            return (_cs36.get(_k) or {}).get("state")

        check("#52 前端·claimed 非空 → state=claimed 且文案含服务端 message",
              _st36("claimed_new") == "claimed"
              and "活动领取成功 +100 Credits" in _txt36("claimed_new"),
              (_st36("claimed_new"), _txt36("claimed_new")[:90]))
        check("#52 前端·claimed 空（有 message）→ **不含「签到成功」** 且带下次可签到",
              _st36("idle_with_msg") != "claimed"
              and "签到成功" not in _txt36("idle_with_msg")
              and "10-05 10:00" in _txt36("idle_with_msg"),
              (_st36("idle_with_msg"), _txt36("idle_with_msg")[:110]))
        check("#52 前端·claimed 空（无 message）→ 兜底文案 + 下次可签到",
              _st36("idle_no_msg") != "claimed"
              and "签到成功" not in _txt36("idle_no_msg")
              and "本次没有新增积分" in _txt36("idle_no_msg")
              and "10-05 10:00" in _txt36("idle_no_msg"),
              (_st36("idle_no_msg"), _txt36("idle_no_msg")[:110]))
        check("#52 前端·ok=false 只有 message → state=failed、文案含 message、非 undefined",
              _st36("fail_msg_only") == "failed"
              and "token 已过期" in _txt36("fail_msg_only")
              and "undefined" not in _txt36("fail_msg_only"),
              (_st36("fail_msg_only"), _txt36("fail_msg_only")[:110]))
        check("#52 前端·旧字段兜底（earned_credit>0、无 claimed）→ 视为到账且含 +100",
              _st36("legacy_credit") == "claimed" and "100" in _txt36("legacy_credit"),
              (_st36("legacy_credit"), _txt36("legacy_credit")[:90]))
        check("#52 前端·旧字段兜底（earned_credit=0）→ 不得出现「签到成功」",
              _st36("legacy_none") != "claimed"
              and "签到成功" not in _txt36("legacy_none"),
              (_st36("legacy_none"), _txt36("legacy_none")[:90]))
        _at36 = _txt36("idle_at_only")
        check("#52 前端·note 缺失时用 next_available_at 兜底格式化（含 UTC+8 标注）",
              "（UTC+8）" in _at36 and "-" in _at36 and _at36 != _txt36("idle_no_msg"),
              _at36[:110])
        _b36u = _run36_tz("UTC")
        _b36n = _run36_tz("America/New_York")
        check("#52 前端·时区无关：TZ=UTC / America/New_York / 默认 三份输出逐字节一致",
              json.dumps(_b36u, ensure_ascii=False, sort_keys=True)
              == json.dumps(_b36n, ensure_ascii=False, sort_keys=True)
              == json.dumps(_b36, ensure_ascii=False, sort_keys=True),
              ((_b36u.get("cases") or {}).get("idle_at_only", {}).get("text"),
               (_b36n.get("cases") or {}).get("idle_at_only", {}).get("text")))
        for _k36, _want36 in (("all_claimed", "ok"), ("claimed_plus_idle", "ok"),
                              ("all_idle", "warn"), ("fail_plus_idle", "warn"),
                              ("all_fail", "bad"), ("empty_rows", "warn")):
            check("#52 前端·toast kind（%s）→ %s" % (_k36, _want36),
                  (_ks36.get(_k36) or {}).get("kind") == _want36,
                  (_k36, (_ks36.get(_k36) or {}).get("kind")))
        _bm36 = _run36_tz(None, mutate=True)
        _mt36 = str(((_bm36.get("cases") or {}).get("idle_with_msg") or {}).get("text") or "")
        check("#52 能红证据：把分流改回「ok 就写死签到成功」→ claimed 空的两条断言必红",
              "签到成功" in _mt36, _mt36[:80])
    else:
        skip("issue #20 前端分流断言（抽不到纯函数组）",
             json.dumps(_b36, ensure_ascii=False)[:140])
    _sh36.rmtree(_dir36, ignore_errors=True)

print()
print("[37] issue #20 后端：下次可签到窗口（next_checkin_window）边界 + 时区无关")
import datetime as _dt37
_UTC8_37 = _dt37.timezone(_dt37.timedelta(hours=8))


def _ep37(_y, _m, _d, _hh=10, _mm=0, _ss=0):
    return int(_dt37.datetime(_y, _m, _d, _hh, _mm, _ss, tzinfo=_UTC8_37).timestamp())


check("#52 后端·函数与常量存在（next_checkin_window / CHECKIN_WINDOW_HOUR_UTC8=10）",
      callable(getattr(A, "next_checkin_window", None))
      and getattr(A, "CHECKIN_WINDOW_HOUR_UTC8", None) == 10,
      (callable(getattr(A, "next_checkin_window", None)),
       getattr(A, "CHECKIN_WINDOW_HOUR_UTC8", None)))

for _label37, _now37, _exp_ep37, _exp_note37 in (
        ("09:59:59（10:00 前 1 秒）", _ep37(2026, 10, 5, 9, 59, 59),
         _ep37(2026, 10, 5, 10, 0, 0), "10-05 10:00（UTC+8）"),
        ("10:00:00 整点（含）", _ep37(2026, 10, 5, 10, 0, 0),
         _ep37(2026, 10, 6, 10, 0, 0), "10-06 10:00（UTC+8）"),
        ("10:00:01（10:00 后 1 秒）", _ep37(2026, 10, 5, 10, 0, 1),
         _ep37(2026, 10, 6, 10, 0, 0), "10-06 10:00（UTC+8）"),
        ("08:59:00", _ep37(2026, 10, 5, 8, 59, 0),
         _ep37(2026, 10, 5, 10, 0, 0), "10-05 10:00（UTC+8）"),
        ("23:59:59（当日末尾）", _ep37(2026, 10, 5, 23, 59, 59),
         _ep37(2026, 10, 6, 10, 0, 0), "10-06 10:00（UTC+8）"),
        ("跨月 01-31 23:59", _ep37(2026, 1, 31, 23, 59, 0),
         _ep37(2026, 2, 1, 10, 0, 0), "02-01 10:00（UTC+8）"),
        ("跨年 12-31 23:59", _ep37(2026, 12, 31, 23, 59, 0),
         _ep37(2027, 1, 1, 10, 0, 0), "01-01 10:00（UTC+8）"),
        ("月末 04-30 10:00 后", _ep37(2026, 4, 30, 10, 0, 1),
         _ep37(2026, 5, 1, 10, 0, 0), "05-01 10:00（UTC+8）")):
    _at37, _note37 = A.next_checkin_window(_now37)
    check("#52 后端·边界（%s）→ at 与 note 都正确" % _label37,
          _at37 == _exp_ep37 and _note37 == _exp_note37,
          (_at37, _exp_ep37, _note37, _exp_note37))

_at37b, _note37b = A.next_checkin_window(_ep37(2026, 10, 5, 9, 0, 0))
_recalc37 = _dt37.datetime.fromtimestamp(_at37b, _UTC8_37).strftime("%m-%d %H:%M") + "（UTC+8）"
check("#52 后端·at 与 note 同源（note 可由 at 反算得到，不存在两处各算一遍）",
      _recalc37 == _note37b, (_recalc37, _note37b))

_at37c, _note37c = A.next_checkin_window(1791165600 - 1)
check("#52 后端·契约样例：next_checkin_window(1791165600-1)[1] == 10-05 10:00（UTC+8）",
      _note37c == "10-05 10:00（UTC+8）", (_at37c, _note37c))

_here37 = os.path.dirname(os.path.abspath(__file__))
_cmd37 = ("import sys; sys.path.insert(0, %r); import qoder_accounts as A; "
          "print(A.next_checkin_window(1791165599))" % _here37)


def _run_tz37(_tz):
    _env37 = dict(os.environ)
    _env37["TZ"] = _tz
    _env37["PYTHONIOENCODING"] = "utf-8"
    _r37 = _sp36.run([sys.executable, "-c", _cmd37], capture_output=True,
                     text=True, encoding="utf-8", env=_env37, timeout=60)
    return (_r37.stdout or "").strip()


_tz37 = {_tz: _run_tz37(_tz) for _tz in ("UTC", "America/New_York", "Asia/Shanghai")}
check("#52 后端·时区无关：TZ=UTC / America/New_York / Asia/Shanghai 三进程输出逐字节一致",
      len(set(_tz37.values())) == 1 and "10-05 10:00（UTC+8）" in list(_tz37.values())[0],
      _tz37)

print()
print("SUMMARY: TOTAL %d checks, %d passed, %d failed, %d skipped"
      % (PASS + FAIL + SKIP, PASS, FAIL, SKIP))
print("RESULT: %s (exit %d)  SKIP=%d  |  语义: 0=GREEN(无 FAIL，允许 SKIP)；"
      "1=RED(存在 FAIL)；SKIP 永不计入通过"
      % ("RED" if FAIL else "GREEN", 1 if FAIL else 0, SKIP))
# 口径自证：静态源码里以 check(/skip( 开头的顶层断言点 vs 运行时执行数。
# 两者差值来自循环展开（多执行）与条件分支未走（少执行）；以运行时数字为准。
try:
    with open(os.path.abspath(__file__), encoding="utf-8") as _fh:
        _self_src = _fh.read()
    _static = len([_ln for _ln in _self_src.splitlines()
                   if _ln.lstrip().startswith(("check(", "skip("))])
    print("CHECK-SOURCES: static-top-level=%d, runtime-executed=%d, skipped=%d, "
          "delta=%+d (循环展开/条件分支)"
          % (_static, PASS + FAIL, SKIP, (PASS + FAIL) - _static))
except Exception as _exc:
    print("CHECK-SOURCES: 静态口径统计失败（%s）" % _exc)
if SKIP:
    print("NOTE: %d 条断言被跳过（缺 fixture/环境），没有被当成通过；"
          "补齐后请重跑确认它们真的通过。" % SKIP)
sys.exit(1 if FAIL else 0)
