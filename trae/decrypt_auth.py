#!/usr/bin/env python3
"""Offline decryptor for TRAE SOLO CN credential store.

Reverse-engineered from out/main.js module "out-build/vs/base/common/byteCrypto.js":

  blob = magic(6) + keymat(32) + AES-CBC(payload)
  magic  = "tc" 05 10 00 00        (tc = trae crypt, 05?, AES variant tag)
  keymat = 32 random bytes

  KDF(keymat):
      n = SHA512(keymat)            # 64
      n += qoe XOR zoe              # 64  (64-byte constant table)
      n = SHA512(n)                 # 64, then
      aesKey = n[0:16], iv = n[16:32]

  payload = SHA512(plaintext)[64] + plaintext
  -> verify SHA512(pt[64:]) == pt[:64]

The qoe/zoe tables are parsed straight out of main.js so they always match the
installed build. Read-only: never writes to the Trae profile.
"""

import base64
import hashlib
import json
import os
import re
import sys

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

MAIN_JS = r"D:\TRAE SOLO CN\resources\app\out\main.js"
STORAGE = os.path.expandvars(
    r"%APPDATA%\TRAE SOLO CN\User\globalStorage\storage.json"
)


def load_tables():
    src = open(MAIN_JS, encoding="utf-8", errors="replace").read()
    out = {}
    for name in ("qoe", "zoe"):
        m = re.search(
            name + r"\s*=\s*Uint8Array\.from\(\[([0-9,\s]+)\]\)", src
        )
        if not m:
            raise SystemExit("table %s not found in main.js" % name)
        out[name] = bytes(int(x) for x in m.group(1).split(",") if x.strip() != "")
    assert len(out["qoe"]) == 64 and len(out["zoe"]) == 64, "table size != 64"
    return out["qoe"], out["zoe"]


QOE, ZOE = load_tables()
MASK = bytes(a ^ b for a, b in zip(QOE, ZOE))


def derive(keymat):
    n = bytearray(128)
    n[0:64] = hashlib.sha512(keymat).digest()
    n[64:128] = MASK
    n[0:64] = hashlib.sha512(bytes(n)).digest()
    return bytes(n[0:16]), bytes(n[16:32])


def decrypt_blob(b64):
    blob = base64.b64decode(b64)
    if blob[:2] != b"tc" or blob[2] != 5 or blob[4] != 0 or blob[5] != 0:
        raise ValueError("bad magic %s (len=%d)" % (list(blob[:6]), len(blob)))
    if blob[3] != 16:
        raise ValueError("unexpected variant byte %d" % blob[3])
    keymat, ct = blob[6:38], blob[38:]
    if len(ct) % 16 or not ct:
        raise ValueError(
            "ciphertext not block aligned: %d bytes (total %d)" % (len(ct), len(blob))
        )
    aes_key, iv = derive(keymat)
    dec = Cipher(algorithms.AES(aes_key), modes.CBC(iv)).decryptor()
    pt = dec.update(ct) + dec.finalize()
    # WebCrypto applies PKCS7; raw CBC keeps it.
    pad = pt[-1]
    if 0 < pad <= 16:
        pt = pt[:-pad]
    if hashlib.sha512(pt[64:]).digest() != pt[:64]:
        raise ValueError("sha512 header mismatch (wrong tables / build?)")
    return pt[64:]


def main():
    data = json.load(open(STORAGE, encoding="utf-8"))
    want = sys.argv[1:] or [k for k in data if k.startswith("iCubeAuthInfo://")]
    for key in want:
        val = data.get(key)
        if val is None:
            print("## %s : <missing>" % key)
            continue
        print("## %s  (b64 len %d)" % (key, len(val)))
        try:
            raw = decrypt_blob(val)
        except Exception as exc:  # noqa: BLE001
            print("   FAILED: %s" % exc)
            continue
        try:
            obj = json.loads(raw)
        except Exception:  # noqa: BLE001
            print("   plaintext (raw): %r" % raw[:400])
            continue
        print("   decrypted %d bytes" % len(raw))
        print(json.dumps(redact(obj), indent=2, ensure_ascii=False)[:20000])


def redact(obj, depth=0):
    """Keep structure visible, bleed proof that secrets are really there."""
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if isinstance(v, str) and any(
                s in k.lower()
                for s in ("token", "secret", "password", "mobile", "email")
            ):
                out[k] = "<%d chars: %s...%s>" % (len(v), v[:12], v[-6:])
            else:
                out[k] = redact(v, depth + 1)
        return out
    if isinstance(obj, list):
        return [redact(v, depth + 1) for v in obj[:5]]
    return obj


if __name__ == "__main__":
    main()
