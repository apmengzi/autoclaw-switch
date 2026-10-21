# -*- coding: utf-8 -*-
"""Bridge: 新版 AutoClaw(official 渠道) 的 account-credentials.enc
→ 旧版 auth.json 布局，供 a_switch.py discover_accounts() 使用。

新版布局：%APPDATA%/AutoClaw-official/accounts/<hash>/account-credentials.enc
文件内容是裸的 v10||nonce(12)||AES-256-GCM(ciphertext)，密钥在
AutoClaw-official/Local State 的 os_crypt.encrypted_key（DPAPI 保护）——
与 a_switch.decrypt_chromium_value 完全同构，只是存储载体不同。
"""
import base64
import json
import os
import sys
from pathlib import Path

APPDATA = Path(os.environ["APPDATA"])
SRC = APPDATA / "AutoClaw-official"
OUT = Path.home() / ".autoclaw-relay" / "auth-compat"

sys.argv = ["x"]
import importlib.util
spec = importlib.util.spec_from_file_location(
    "a_switch", Path(__file__).resolve().parent / "a_switch.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def _read_device_id(user_data: Path) -> str:
    """2.x 把设备指纹单独放在 <userData>/device/device-id.json。"""
    p = user_data / "device" / "device-id.json"
    try:
        return str(json.loads(p.read_text(encoding="utf-8")).get("deviceId") or "")
    except Exception:
        return ""


def main():
    key = m._os_crypt_key(SRC)  # DPAPI unprotect, 仅本机当前用户可解
    print("os_crypt key recovered:", key[:4].hex(), "... len", len(key))

    acc_dirs = [d for d in (SRC / "accounts").iterdir() if d.is_dir()]
    print("account dirs:", [d.name[:12] + "..." for d in acc_dirs])

    for acc_dir in acc_dirs:
        enc_path = acc_dir / "account-credentials.enc"
        prof_path = acc_dir / "account-profile.json"
        if not enc_path.is_file():
            continue
        blob = enc_path.read_bytes()
        assert blob[:3] == b"v10", f"unexpected prefix {blob[:3]!r}"
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        plain = AESGCM(key).decrypt(blob[3:15], blob[15:], None)
        cred = json.loads(plain.decode("utf-8"))
        print("credentials keys:", sorted(cred.keys()))
        for k, v in cred.items():
            if isinstance(v, str):
                print(f"  {k}: len={len(v)} head={v[:12]}...")
            else:
                print(f"  {k}: {type(v).__name__}", v if not isinstance(v, dict) else sorted(v.keys()))

        profile = json.loads(prof_path.read_text(encoding="utf-8")) if prof_path.is_file() else {}
        prof = profile.get("profile", {})

        # 映射到旧版 auth.json 布局
        ui = {
            "user_id": cred.get("userId") or cred.get("user_id") or prof.get("numericUserId"),
            "user_name": cred.get("nickname") or cred.get("userName") or prof.get("displayName"),
            "email": cred.get("email") or prof.get("email") or "",
        }
        auth = {
            "token": cred.get("token") or cred.get("accessToken"),
            "refreshToken": cred.get("refreshToken"),
            # 2.x 的 account-credentials.enc 里没有 deviceId（只有 accessToken /
            # refreshToken / revision / updatedAt），设备指纹单独存在
            # <userData>/device/device-id.json。取错地方会写空串，随后
            # POST /userapi/v1/refresh 报 400000「用户未登录」——该 lane 的号在
            # 池子里看着"票还新鲜"，却永远刷不出可用票，表现为 chat 一直失败。
            "deviceId": cred.get("deviceId") or _read_device_id(SRC),
            "userInfo": ui,
        }
        assert auth["token"], "no token field found in decrypted credentials"

        tgt = OUT
        tgt.mkdir(parents=True, exist_ok=True)
        (tgt / "auth.json").write_text(json.dumps(auth, ensure_ascii=False, indent=2), encoding="utf-8")
        # Local State / channel.json 一并放入：token 轮换写回与渠道识别需要
        (tgt / "Local State").write_bytes((SRC / "Local State").read_bytes())
        (tgt / "channel.json").write_bytes((SRC / "channel.json").read_bytes())
        print("staging auth dir ready:", tgt)


if __name__ == "__main__":
    main()
