#!/usr/bin/env python3
"""从 DoubaoWork 客户端 profile 解密 Cookie（Windows DPAPI + AES-GCM）。

只读客户端自己的 Chromium profile：<LocalAppData>/DoubaoWork/User Data/Default/Network/Cookies
密钥在 Local State 的 os_crypt.encrypted_key（DPAPI 包裹）。
输出默认写到 ~/.doubao-relay/cookies.json（不进项目树）。
"""
import base64, ctypes, json, os, sqlite3, sys, shutil, tempfile
from ctypes import wintypes

UD = os.path.join(os.environ["LOCALAPPDATA"], "DoubaoWork", "User Data")
COOKIE_DB = os.path.join(UD, "Default", "Network", "Cookies")
LOCAL_STATE = os.path.join(UD, "Local State")
OUT = os.path.join(os.path.expanduser("~"), ".doubao-relay", "cookies.json")


def dpapi_unprotect(data: bytes) -> bytes:
    class DATA_BLOB(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

    blob_in = DATA_BLOB(len(data), ctypes.cast(ctypes.create_string_buffer(data, len(data)), ctypes.POINTER(ctypes.c_char)))
    blob_out = DATA_BLOB()
    if not ctypes.windll.crypt32.CryptUnprotectData(ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out)):
        raise RuntimeError("CryptUnprotectData failed")
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(blob_out.pbData)


def get_key() -> bytes:
    with open(LOCAL_STATE, "r", encoding="utf-8") as f:
        state = json.load(f)
    enc = base64.b64decode(state["os_crypt"]["encrypted_key"])
    assert enc[:5] == b"DPAPI", "unexpected key prefix"
    return dpapi_unprotect(enc[5:])


def decrypt_value(key: bytes, value: bytes) -> str:
    if value[:3] in (b"v10", b"v11"):
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        nonce, ct = value[3:15], value[15:]
        return AESGCM(key).decrypt(nonce, ct, None).decode("utf-8", "replace")
    # 老格式：整段 DPAPI
    try:
        return dpapi_unprotect(value).decode("utf-8", "replace")
    except Exception:
        return ""


def main():
    tmp = None
    try:
        db = COOKIE_DB
        if not os.path.exists(db):
            sys.exit(f"cookie db not found: {db}")
        key = get_key()
        # 客户端持有 DB，优先只读 URI 直读；失败则复制副本再读
        try:
            conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
            rows = conn.execute("select host_key, name, value, encrypted_value, path, expires_utc from cookies").fetchall()
            conn.close()
        except sqlite3.Error:
            tmp = tempfile.mkdtemp(prefix="dbck-")
            cp = os.path.join(tmp, "Cookies")
            shutil.copy2(db, cp)
            conn = sqlite3.connect(cp)
            rows = conn.execute("select host_key, name, value, encrypted_value, path, expires_utc from cookies").fetchall()
            conn.close()

        out = []
        for host, name, val, enc, path, expires in rows:
            if "doubao" not in host and "byte" not in host and "ci ci" not in host:
                continue
            v = val or (decrypt_value(key, enc) if enc else "")
            out.append({"host": host, "name": name, "value": v, "path": path, "expires": expires})

        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        with open(OUT, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=1)

        print(f"total cookies for doubao/byte hosts: {len(out)}")
        print(f"saved -> {OUT}")
        names = sorted({c["name"] for c in out})
        print("names:", ", ".join(names))
        key_ones = [c for c in out if c["name"] in ("sessionid", "sessionid_ss", "sid_tt", "sid_guard", "ttwid", "passport_csrf_token", "uid_tt", "uid_tt_ss")]
        for c in key_ones:
            print(f"  {c['host']:28s} {c['name']:22s} len={len(c['value'])} head={c['value'][:12]}...")
    finally:
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
