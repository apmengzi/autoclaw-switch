#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Comate(文心快码) 登录凭证离线读取。

凭证位置（2026-10-06 实证）：Comate IDE 登录后把真实凭证写在
%APPDATA%\\Comate\\User\\settings.json：
  - baidu.comate.license  —— UUID 格式 license（agent 链路身份标识，
    也是 /api/key/valid/{license} 校验与 user_auth_token identity 的原料）
  - baidu.comate.username —— 用户名

注意：globalStorage/state.vscdb 里的 secret comate_login_ID 是 32 位 hex
旧式设备键，GET /api/key/valid/{id} 会返回"当前license无效"，不是 agent
链路的凭证——不要再走 DPAPI/AES-GCM 解密那条弯路。

用法：
  python decrypt_auth.py            # 输出 JSON：{"username":..., "license":...}
  python decrypt_auth.py --mask     # 只输出是否成功与长度（自测用）
"""
import json
import os
import sys

APP_SETTINGS = os.path.expandvars(r"%APPDATA%\Comate\User\settings.json")


def read_credentials() -> dict:
    """返回 {"username": str, "license": str}，任何缺失/失败抛异常。"""
    with open(APP_SETTINGS, encoding="utf-8") as f:
        settings = json.load(f)
    license_ = settings.get("baidu.comate.license")
    username = settings.get("baidu.comate.username")
    if not license_:
        raise LookupError("settings.json 无 baidu.comate.license（未登录或版本变化）")
    return {"username": username or "", "license": license_}


def main() -> int:
    try:
        creds = read_credentials()
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        return 1
    if "--mask" in sys.argv:
        print(json.dumps({
            "ok": True,
            "username_len": len(creds["username"]),
            "license_len": len(creds["license"]),
        }, ensure_ascii=False))
    else:
        print(json.dumps({"ok": True, **creds}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
