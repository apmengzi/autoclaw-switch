# A-SWITCH

[English](README.en.md) | [中文](README.md)

Multi-account manager for AutoClaw, bundled with a local relay that turns your AutoClaw credits into models you can pick directly inside ZCode.

Three things it does:

1. **Multi-account.** Add, switch, and monitor balances from one window, plus batch check-in for daily points. The AutoClaw desktop app itself only logs in one account at a time.
2. **Ban prevention.** The upstream risk system watches the *shape* of your inference traffic: an account making nothing but 1-token probes, or hammered at hundreds of requests per minute, gets banned. So there's account warming (real conversations for new accounts), rate limiting (12/min per account), a concurrency gate (≤4 in-flight per pool), and a daily budget (6000/day per account, local counter). These numbers came from forensics on actually-banned accounts — don't tune them up.
3. **Relay.** One button deploys a local relay and registers AutoClaw as a provider in ZCode. After that, GLM-5.3, DeepSeek-V4.1-Flash and friends show up in ZCode's model list, burning AutoClaw credits.

## International sign-up

AutoClaw's international endpoint supports email registration (the CN endpoint is phone-only). New accounts get 10,000 points, granted over 7 days. Register from the official client's login page or the web portal. Running several accounts in rotation beats leaning on one.

## Install

Two ways.

**Option A: run from source**

```
pip install pywebview cryptography
python a_switch_app.py
```

Windows only (token decryption uses DPAPI). Python 3.10+.

**Option B: build the exe**

```
pip install pyinstaller
pyinstaller A-SWITCH.spec --noconfirm
```

Output lands in `dist/A-SWITCH.exe`.

## Usage

Prerequisite: AutoClaw installed and logged in at least once (the tool reads its login state for credentials).

**Add accounts**: "Add via desktop login" pops the official login window and archives the account afterwards. Fully quit AutoClaw first (tray icon included), or the running instance intercepts the login.

**One-click relay**: hit "⚡ One-click relay". It deploys the local relay (`~/.autoclaw-relay/`), registers AutoClaw into ZCode's provider list, and fires one verification request. Then **restart ZCode** — AutoClaw shows up in the model list.

**Warm up**: run "🔥 Warm-up" once for freshly registered accounts. It chats with the model for 8 rounds on real technical topics so the traffic looks human. Skip this and the account won't last long.

## How the relay works

`relay/server.mjs` is a purely local node service listening on `127.0.0.1:18766`. It translates Anthropic/OpenAI requests into AutoClaw cloud format. The single most important detail: the request's system prompt must start with the official harness marker, or the gateway answers 406 with an empty body. The relay injects that marker automatically.

With multiple accounts, the relay picks per-request based on balance and idle time, rotating to the next account when one runs dry. Everything stays on your machine; credentials never leave it.

Credentials come from two sources: multi-account users get them from the account-pool export (`~/.openclaw-autoclaw/aswitch_cloud_pool.json`); single-account users are read straight from the current login state.

## Known issues

- The upstream intermittently resets TLS handshakes from non-browser fingerprints. Python/curl direct requests get killed; node usually squeaks through. GUI traffic already falls back through a node bridge, so it's mostly invisible. If it flares up, wait a bit or restart your proxy.
- Vision support is configured per route from live tests: GLM-5.3-Flash, DeepSeek-V4.1-Flash and the Auto routes take images; GLM-5.3 (the coding variant) and DeepSeek-V4-Pro do not, and will tell you they can't see.
- `DeepSeek-V4.1-Flash` is AutoClaw's own label. The upstream actually serves `deepseek-v4-flash-202605`, which has vision — no bait-and-switch.

## Disclaimer

This project talks to AutoClaw through reverse-engineered, unofficial interfaces, for study and research only. Account bans and point losses are on you. Not for commercial use. AutoClaw is a Zhipu/Z.ai product; this project is not affiliated with it.

## Layout

```
a_switch.py          Backend: accounts, check-in, DPAPI decryption, one-click relay, warming
a_switch_app.py      GUI (pywebview + embedded HTML)
relay/server.mjs     Local relay (node, zero dependencies)
relay/warm/          Account warming script
A-SWITCH.spec        PyInstaller build config
PROMPT_FOR_ZCODE.md  Paste this into ZCode and it deploys the relay for you
```
