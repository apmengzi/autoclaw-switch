# A-SWITCH · All-in-One relay platform

[English](README.en.md) | [中文](README.md) | [A-SWITCH 1.x standalone tool (releases)](../../releases/latest)

**Turn the built-in credits of seven Chinese AI clients/platforms into models you can select directly in ZCode, Codex CLI, or any OpenAI / Anthropic client.**

Every component listens on `127.0.0.1` by default, with one exception: the AutoClaw gateway binds `0.0.0.0` unless you set `AUTOCLAW_BIND_HOST=127.0.0.1`. Credentials never leave your machine. The seven links share one console, one model-naming convention and one inbound-auth layer. In ZCode they are sibling providers with no model-name collisions, so you can switch between them freely inside one session.

| Platform | Credits | Gateway exposes | Real upstream protocol † | Port | Models * | Tools |
|---|---|---|---|---|---|---|
| **AutoClaw** (Zhipu Z.ai) | account points, multi-account pool | anthropic + openai + responses | **native chat completions** (persona gate) | 18766 | 4 | ✅ structured |
| **WorkBuddy** (Tencent CodeBuddy) | ~100 credits/month + 30/day (free tier) | openai | **native chat completions** (body passed through verbatim) | 7863 | 46 | ✅ structured |
| **Trae SOLO CN** (ByteDance) | free session quota | openai + anthropic | **dual channel**: `llm_utils_chat` native tools / `chat_sessions` agent session (history flattened) | 18768 | 33 live (snapshot 28) | ✅ native / ✅ prompt-emulated ‡ |
| **豆包工作 / Doubao Work** (ByteDance) | client-bundled quota | openai + anthropic | web IM protocol (history flattened to text) | 18770 | 2 (synthetic) | ❌ text only |
| **Comate 文心快码** (Baidu) | Comate IDE quota | openai + anthropic | three-step cloud-agent chain (`/v2/execute` SSE, truly streamed; **tools ride `toolUseResults` continuations**) | 18774 | 15 | ✅ continuation § |
| **Qoder CN** (Alibaba) | client-bundled quota (Qwen3.8 line works on Free) | openai + responses | COSY envelope agent SSE (history flattened, **real tools list**) | 8791 | 14 | ✅ forwarded |
| **千问办公 / QwenWork CN** (Alibaba) | same Qoder platform, separate exit | openai + responses | same as Qoder (qwork scene + workbench declaration) | 8791 | 3 | ✅ forwarded |

\* Catalogs are pulled live per account; counts are what this machine measured on 2026-10-18: WorkBuddy 46, Trae 33 live (`models-catalog.json`'s static snapshot still holds the 28 entries from 2026-10-07), Comate 15, Qoder CN 14 usable, QwenWork 3. AutoClaw's four are the current catalog of this machine's account (upstream removed the two `tdpsk_deepseek-*` routes on 2026-09-29; see [the registration section](#zcode-provider-registration-the-write-gate-important)). Doubao's catalog lives server-side and is not enumerable — the gateway exposes two synthetic entries.
† This is how the **upstream** actually talks, which is not the same thing as what the gateway exposes. All seven gateways accept `POST /v1/chat/completions`; only the first two talk chat completions to their upstream. Per-platform evidence in [Protocol fidelity](#protocol-fidelity-which-links-are-really-chat-completions).
‡ Trae's `llm_utils_chat` channel sends `tools` as a real tool array (native tools); `chat_sessions` has no tool field, so the relay injects a strict text contract through the system prompt, parses one fenced ```tool_call block, and turns it into `tool_calls`. **Not every model obeys**: on this machine glm-5.x / qwen / kimi / minimax do, deepseek-v4-flash / deepseek-v4-pro do not. Free personal accounts often get `2001 failed to get app config` from `llm_utils_chat`, so auto mode falls back to `chat_sessions` — in practice the default is usually the emulated layer, not native tools.
§ Comate's "continuation" is its tool loop: calls the upstream agent issues (`Write`/`Read`/`Bash`…) are translated into the caller's tool-call shape, and results are delivered back through `toolUseResults` on the **same conversation+task**. The toolset belongs to the upstream agent, not to you — the caller must declare a tool with the same (or canonically equivalent) name.

Qoder CN and QwenWork CN share **one** gateway process on `8791` (same account pool, same COSY signing). On the ZCode side they are two providers, selected by API key: ZCode's provider config has no custom-request-header field, so binding a key to a realm is the only supported way to choose an exit. The console mints both keys, writes them into the gateway, and **keeps inbound auth enabled** (`/v1` requires a key, probes such as `/health` are exempt); each key is both the exit selector and the inbound gate key.

**All seven links also serve Codex CLI** — Codex 0.100+ accepts `wire_api = "responses"` only. Links with a native `/v1/responses` (AutoClaw, Comate, Qoder CN, QwenWork CN) are registered directly; WorkBuddy / Trae / Doubao go through a local front door (`bridge/codex_front.mjs`, :18776) that translates Responses ⇄ Chat Completions. The console starts/stops the front door and manages a managed section in `~/.codex/config.toml` (bearer token in the provider table, never `~/.codex/auth.json`); see [Codex CLI (Responses API)](#codex-cli-responses-api).

## What changed recently (October 2026)

| Date | Change |
|---|---|
| **2026-10-18** | **Trae dual channel**: added `llm_utils_chat` (native SSE + native tools); Free accounts' `2001` automatically falls back to `chat_sessions`; the session channel gained a prompt-emulated tool layer, a streaming gate, tolerant tool parsing, case-spelling alias retries, a `4001` model-health table and explicit errors; 33 live models. Offline dual-channel regression `trae/test_dual.mjs`: 47/47 |
| **2026-10-18** | Documentation: **manual Codex configuration** and **using the relay as a plain API** (OpenAI / Anthropic / Responses endpoint matrix, SDK and curl examples, streaming, model names, security boundaries) |
| **2026-10-17** | Console rebuilt into a **12-page platform sidebar**; new **balance / quota overview** card (all seven links on one screen) |
| **2026-10-11** | **Codex CLI integration** (front door + managed `config.toml` + catalog merge); console "generate api_key" and `sk-` standard-key aliases; inbound gates for the C-tier Trae/Doubao links |
| **2026-10-07** | Seven links unified as **stateless** gateways; unified naming (`models-catalog.json`); dynamic ZCode provider add/remove; inbound api_key gates for the A/B tiers |

## What it is / isn't

All seven upstreams are **consumer agent clients**, not public model APIs. Each spends its own credits inside its own official client; the relays here let a standard IDE spend those credits too.

- **It is** a local protocol translation layer: standard request → gateway translates to the upstream's real protocol → streams back.
- **It is not** an official API. Every link is reverse-engineered from the client (credential storage, gateway hostnames, request signing, WAF gates, session protocols). When an upstream changes, the adapter must be re-reverse-engineered.
- **The cost**: unofficial usage carries a ban risk (AutoClaw in particular looks at the *shape* of your inference traffic), and billing follows each platform's own rules.

## Protocol fidelity: which links are really chat completions

Judging by the **gateway entry point**, you would conclude all seven are chat completions — they all serve `POST /v1/chat/completions`. Look at what each gateway sends **upstream** and the picture splits into three tiers.

**Tier A · upstream is natively chat completions (structured `messages`/`tools`, tool loops work)**

| Platform | Upstream endpoint | Payload |
|---|---|---|
| WorkBuddy | `POST copilot.tencent.com/v2/chat/completions` | The client body is **passed through verbatim**; only the model name is rewritten (the prefix is the gateway's own routing convention, the upstream takes bare names). `messages`, `tools`, `tool_calls` and reasoning fields all survive — the main reason it feels best as an agent pool |
| AutoClaw | `POST autoglm-api.zhipuai.cn/autoclaw-proxy/proxy/autoclaw/chat/completions` | OpenAI-shaped body (`messages` + `max_completion_tokens` + `stream_options.include_usage` + `store:false` + `reasoning_effort:high`). The Anthropic entry converts first (`anthropicToOpenai()`, tools via `anthropicToolsToOpenai()`); the Responses entry likewise (`responsesToolsToChat()`). **Protocol-wise it is WorkBuddy's equal — when it is unusable today that is a credits problem (402), not a protocol one** |

**Tier B · custom protocol that still carries real tool semantics (tool calls translate, history is flattened)**

- **Trae `llm_utils_chat` (new on 2026-10-18, preferred)**: the outbound body is Trae's agent LLM protocol, with `tools` as a real array (`parameters` JSON-stringified) and `tool_calls` frames in the SSE response. This is a **native-tool channel** with no prompt emulation, but it needs an account with an app config (Free personal accounts often get `2001`) and the full IDE identity headers (device/machine/version, read from `storage.json` / `product.json`).
- **Trae `chat_sessions` (fallback / legacy)**: `initial_message.query` is `JSON.stringify(prompt(text))`; the protocol has neither a field for receiving `tools` nor a channel for returning tool calls. The relay writes the tool schemas and a "one ```tool_call block per reply" contract into the system prompt, parses that block into real `tool_calls`, and feeds tool results back as `role:"tool"` (or Anthropic `tool_result`) history. **Only models that obey the contract close the loop** (glm-5.x / qwen / kimi / minimax here; deepseek-v4-flash / pro do not).
- **Qoder CN / QwenWork CN**: the outbound body is a deep copy of the official `baseprompt.json`. It *does* contain a `messages` array — but it is `[{role:"system"}, ...flattened history]`: `flatten_messages()` serializes assistant `tool_calls` into text markers. The one genuinely structured part is the tool declaration: a client-supplied `tools` list is placed into the envelope as-is, and the upstream parses it and answers `finish_reason:tool_calls`. So it is a **hybrid: real tools, fake message history**.
- **Comate**: your `tools` are not forwarded (the execute endpoints carry a single text `query` field), but tools **coming down** carry real semantics: `FUNCTION_CALL_START/_PARAMS_APPEND/_END` frames hold `toolUse:[{id,name,input}]`, with parameters streaming in as per-key fragments, and results go home through the upstream's own `toolUseResults` field, continuing the **same conversation+task** with `query:""`, `isFirstQuery:false` — exactly what the IDE kernel does. So it is a **closed tool loop, but with the upstream agent's own toolset**; frame names (`Write`/`Read`/`Bash`, Claude vocabulary) are mapped back to the caller's declared names via `V10_TOOL_ALIASES`, and a call the caller never declared cannot be executed.

**Tier C · web/product chat endpoints (simulation only)**

- **豆包工作 / Doubao Work**: `POST www.doubao.com/chat/completion` SSE with editor-block payloads (`messages[0].content_block[0].content.text_block.text`) — the furthest thing from chat completions here; `tools` is ignored rather than rejected.

**What this means in practice.** Ranked by "can it drive an agent tool loop": **WorkBuddy ≈ AutoClaw (structurally faithful, tool loop closed) > Trae `llm_utils_chat` (native tools, but Free accounts are often blocked by 2001) > Comate ≈ Qoder CN ≈ QwenWork CN (both close the loop, with complementary weaknesses: Comate continues the agent natively but the toolset is the agent's own; Qoder/QwenWork forward your tools for real but re-flatten history every turn) > Trae `chat_sessions` (prompt-emulated tools; model-dependent) > Doubao (chat credits only)**. Flattened links tend to be accurate on turn one and start drifting later; this is the root cause.

## Quick start

```
git clone <this repo> && cd <repo>/app    # the repo root *is* the runtime resource root; don't copy app/ alone
npm install                               # single dependency: electron (npmmirror mirror is fine)
npm start
```

Then, in the console, three steps:

1. **Environment check** (top bar) — read-only probing; anything missing is listed with its impact and how to fix it.
2. **Start all** — brings up every gateway and the credential watcher in dependency order (Qoder CN and QwenWork CN share one process). **Whichever platform you start appears in ZCode automatically** (see [Dynamic add/remove](#dynamic-addremove-of-zcode-providers)).
3. **Register** — a manual full refresh of all seven catalogs (normally unnecessary — start/stop already keeps ZCode in sync).

**Restart ZCode** afterwards and the models of the running platforms appear.

Cold-start is handled: the relay's runtime files are prepared automatically — `server.mjs` is (re)deployed from `bridge/` whenever missing or changed, and the **persona is not shipped with the repo** (vendor text, per the PR#4 review): `bridge/extract_persona.py` extracts it from the installed AutoClaw client into `~/.autoclaw-relay/persona.txt`, follows client upgrades automatically, and falls back to the bundled seed only if extraction fails.

### Prerequisites

| Dependency | Needed for | If missing |
|---|---|---|
| Node.js 18+ | AutoClaw relay, Trae / Doubao / Comate gateways, Codex front door | "relay needs Node.js in PATH"; the packaged exe has a fallback runtime (PATH → AutoClaw's bundled node → the console itself) |
| Python 3.10+ with `pip install cryptography` | one-click register / balance query / credential sync (loads `a_switch.py`, found either at the repo root or under `autoclaw-switch/`) | button reports "no executable: python"; without `cryptography` the watcher spawns and dies instantly — the symptom is "the button does nothing" |
| Python 3.9+ (pure stdlib) | Qoder CN / QwenWork CN gateway (`qoder/qoder_proxy.py`) | Qoder page reports a missing gateway file or crashes on start (same `python` as above) |
| AutoClaw desktop app, logged in | credential source for the relay (2.x reads `%APPDATA%\AutoClaw-official\`) | relay starts but has no usable upstream |
| ZCode installed and run at least once | registration target `~/.zcode/v2/provider_config.json` | prompt to install ZCode first |
| Trae SOLO CN, logged in | Trae gateway credentials (decrypted offline) | Trae page shows "not started"; `/health` reports `credential.ok:false` |
| 豆包工作 client, logged in | Doubao credentials (CDP cookie capture; first time use "restart client and sync") | the page shows missing cookie, requests return 401 |
| Comate (文心快码) IDE, logged in | reads `baidu.comate.license` from `%APPDATA%\Comate\User\settings.json` (re-login needs no relay restart) | Comate page shows "not started" / 401 |
| Qoder CN app, logged in | `%APPDATA%\com.qodercn.app.stable\auth.v1.dat`; import with the console's "Sync accounts" | that exit reports `no usable account for realm` |
| QwenWork CN app, logged in | `%APPDATA%\QwenWorkCN\auth-v2.dat`; same sync imports it | that exit finds no catalog, requests fail with `503 Model catalog unavailable` |
| `wb2api.exe` | the WorkBuddy gateway binary | page reports a missing file; it ships as a **Release** asset, not in git — unpack to `workbuddy/workbuddy-manager-v1.0.79/upstream/` |

## Desktop console (`app/`)

An Electron panel: **platform-grouped sidebar + 12 page views + top bar**. The sidebar has three groups — 平台 (overview + one page per platform), 接入 (ZCode / Codex CLI / inbound api_key) and 诊断 (logs) — and every platform entry carries a live status dot. All views stay in the DOM and are only shown/hidden, so the top bar and the 3-second status poll keep working on every page; the current page is persisted in `localStorage`.

- **Overview page** — seven live platform tiles (click one to jump to its page) plus the balance / quota card: the "how much is left" of all seven links on one screen; click **Refresh balance** to query on demand (each link's own upstream API, no outbound polling). Links with a quota API give a real reading: AutoClaw points (A-SWITCH API), WorkBuddy credits (wb2api `/status`), Qoder CN and QwenWork CN (gateway account-pool quota, needs a panel session; when the live refresh fails it shows the last successful cache). Comate / Trae / Doubao Work genuinely have no upstream quota API (Comate only returns license validity, Trae's remote endpoints carry no billing, Doubao is a web API), so the card honestly labels them "no API" and shows only the login-state facts it can get — it never invents numbers.
- **AutoClaw page** — status / upstream route / uptime / model aliases; account, points balance and expiring amount (queried on demand), token expiry, credential-watcher state and start/stop all live on the same page; start, stop, connectivity test (a real inference).
- **WorkBuddy page** — gateway status / credits / account / catalog; start, stop, connectivity test. **Switching accounts**: drop the new auth file into `~/.workbuddy-gateway/auths/` and move the old one to `auths-disabled/`; the gateway hot-reloads in about 5 seconds, no restart, and the card shows the current account.
- **Trae page** — status / account / credential expiry / mode (stateless) / **dual-channel state** (`llm_utils_chat` availability and cooldown, `chat_sessions` online) / catalog / model-health table; start, stop, connectivity test.
- **Doubao Work page** — status / cookie health / pinned conversation (transport only) / mode / catalog; start, stop, connectivity test, **sync login state**, **restart client and sync**.
- **Comate page** — status / license state / mode (stateless + tool loop: conversation continuation, with the routing-table size) / catalog; start, stop, connectivity test.
- **Qoder CN page** — status / account pool / exit (`cn`) / listener / catalog (only models the account can use) plus an inline quota bar; start, stop, connectivity test, **sync accounts**.
- **QwenWork CN page** — the *other exit of the same gateway process* (shows `出口 qworkcn (qwenwork.cn)` and the shared port); catalog shows the three `qwork`-scene models; same four buttons and the inline quota bar.
- **ZCode page** — registration state (including the most recent dynamic sync's additions/removals) / per-provider endpoint and model count / full model list / one-click register (full catalog refresh) / **config check** (read-only validation of `provider_config.json`).
- **Codex CLI page** — Codex CLI / config file / current provider / registered links / front door (:18776) / bundled-catalog size, plus the per-link list (direct or front door, tools or text-only); register, deregister (managed section only, top-level keys restored), catalog preview, smoke (a real `/v1/responses` round-trip, not a liveness ping), front-door start/stop, check.
- **Inbound api_key page** — the seven links' key inventory (click to copy, reconciled against the ZCode registration), per-row **Generate**, standard-key aliases, and the auth probe.
- **Log page** — nine tabs: `relay` / watcher / WorkBuddy / Trae / Doubao Work / Comate / Qoder / Codex / console; each platform page's log button jumps straight to its tab.
- **Top bar** — **Start all** (dependency-ordered; a missing prerequisite only affects its own link, and failures surface the environment-check output) and **Environment check**.

The environment check probes: Node runtime, Python, `cryptography`, every gateway's source and runtime files, the `a_switch.py` backend (what register/balance/sync load), every platform's login state (AutoClaw credentials, Trae `storage.json`, Doubao cookies, Comate `settings.json`, Qoder `auth.v1.dat`, QwenWork `auth-v2.dat`) and the ZCode config — each with "what it costs you" and "how to fix it".

Closing the window does not stop the background services (relays, gateways and the watcher are detached processes).

```
cd app && npm start                     # equal to: npx electron .
ASWITCH_SELFTEST=1 npx electron .       # 39-case functional self-test (7 connectivity + 7 registrations + Comate tool-loop capability + 7 Codex cases + balance overview + env check + gate assertions + key generation/aliases + auth probe + logs + relay stop/start)
ASWITCH_SELFTEST=1 ASWITCH_SELFTEST_ONLY="zcode:register" npx electron .   # run a single handler
node app/test_zcode_config.js           # sandbox regression test for the config-write gate (synthetic fixtures, 19 cases)
node app/test_codex_config.js           # Codex config.toml managed-section gate (synthetic fixtures, 21 cases)
node app/test_inbound_keys.js           # generated-key storage + sk- alias regression (34 cases)
node test_model_catalog.mjs             # model-naming consistency check (11 offline cases; --live also verifies running gateways)
```

The self-test covers `env:check`, `status:query`, `points:refresh`, `credential:sync`, watcher stop/start, all seven `*:smoke` handlers (real inference, not liveness pings), the seven Codex cases (status / front door / catalog / register / re-check / smoke / deregister with byte-exact restore, run against a temporary `CODEX_HOME`), `comate:tool-loop` (reads `/health` to assert this relay build reports its tool loop — it recognizes a relay still running old code without spending credits), `all:start`, `balance:all` (seven rows structurally complete, values track account state and are not asserted), `zcode:register` (with per-provider assertions), `zcode:realm-keys`, `zcode:register:未被闸门拦下`, `zcode:check`, `keys:generate` (end-to-end: write → restart → inventory), `keys:alias` (add an sk- alias → hit `/v1/messages` with it → revoke), `keys:probe`, `logs:tail` and `relay:stop/start`. Results are written to `~/.autoclaw-relay/selftest-result.txt` (per-case pass/fail); `selftest-progress.txt` next to it is the running log. **Running the full self-test from the exe produces no stdout** — Electron is a GUI-subsystem process there, so read that JSON file instead. Two caveats: the full run restarts the relay (that is what the two relay cases assert), and editing `app/main.js` or `preload.js` requires restarting the Electron process — a running window never hot-reloads.

## Per-link notes

**All seven links are stateless gateways**, semantically aligned with AutoClaw's relay: no session state is kept anywhere, the caller sends the full history every request, and the answer depends only on that request. AutoClaw was always like this; Trae's `chat_sessions` creates a fresh remote session per request and throws it away, while `llm_utils_chat` is a single-turn LLM call with no session at all; Doubao has no "create session" API, so it uses one pinned conversation as **transport scratch paper** and never reuses server-side context; Comate replays the IDE kernel's three-step chain per request (the single exception is the tool loop within one turn of questioning, which continues the same conversation+task and reuses nothing across questions); Qoder CN and QwenWork CN flatten `messages` into a plain transcript inside the envelope's `messages` array (tools, in contrast, are sent as a real list). The benefit is predictability (same `messages`, same answer, no cross-request pollution); the cost is two-layered — protocol-level fidelity (above) plus each link's fixed per-turn overhead (Trae's session channel re-pays its agent system prompt every turn, Doubao re-sends the whole history).

**AutoClaw** — 2.0.1 moved credentials to `%APPDATA%\AutoClaw-official\accounts\<hash>\account-credentials.enc` (DPAPI-protected AES-256-GCM key in Local State), moved inference to an acceleration host, added `X-Auth-Sign`/`X-Channel`/`X-Session-Id` headers, and gates requests behind a WAF that demands a "real OpenAI SDK" shape. The 406 gate has five factors (clean HTTP/1.1 fingerprint via `node:https`, full OpenAI SDK fingerprint headers, `X-Session-Id`, a system message matching the app persona, and the exact body parameters) — missing any one returns an empty 406. The gateway substitutes the persona and moves your own system instructions into the first user message, so the model still sees them.

> **★ Dual-lane relay (2026-10)**: upstream folded the 2.x work into `relay/server.mjs` — a single unified proxy for **both CN and international accounts**: one port (18766), one pool, per-account lane routing. International accounts (`aswitch_cloud_pool.json`, default lane) hit `autoglm-api.autoglm.ai` with the 2.0.2 contract (harness-marker gate + fresh-token-per-request). CN accounts (`~/.autoclaw-relay/auth-compat/auth-cn.json`, written by `bridge/watch_auth.py`) hit `autoglm-api.zhipuai.cn` with the official-channel contract (persona system gate + X-Session-Id/signature headers + `node:https` transport). Pick logs tag the lane as `(cn)`/`(oversea)` and the healthz pool mixes both. To add a CN account: sign in via the 2.x client, then keep `python bridge/watch_auth.py` running. `relay/server.mjs` is also what `a_switch.py`'s one-click relay deploys; the console deploys the PR#4 standalone 2.x relay at `bridge/server_2x.mjs`, which routes both lanes per account as well.

**WorkBuddy** — a local Go gateway (`wb2api`, api_key `wb-local-key`, config in the same directory), CLI OAuth login (`wb2api-login.exe url|poll --realm=cn`), 38-day tokens, account pool / circuit breaker / check-in keep-alive built in. The upstream is standard chat completions and the gateway translates almost nothing: it reads the client body, rewrites only the bare model name, and forwards the rest verbatim, so `messages` / `tools` / `tool_calls` / reasoning fields all stay structured. Model names must be lowercase or `cn:`-prefixed; 46 models. Credits shown and free quota are two separate ledgers (0 credits still completes). Account switching: drop the new auth file into `~/.workbuddy-gateway/auths/`, move the old one to `auths-disabled/`; the gateway hot-reloads the directory in ~5 seconds.

**Trae SOLO CN** — the client does not call models directly; it drives a remote agent sandbox. Credentials are decrypted **offline** from `storage.json`'s `iCubeAuthInfo://icube.cloudide` blob (`byteCrypto`, pure JS, hard-coded tables) — no client patching, no IDE restart. The real user token is the only thing that passes auth; temp JWTs get 401. Credentials live ~5 days; the gateway re-reads `storage.json` on 401. Two channels since 2026-10-18:

- `llm_utils_chat` (`POST /api/agent/v3/llm_utils_chat`) — single-turn SSE, **native `tools`** (parameters JSON-stringified), `tool_calls` frames in the response, function group chosen per model (`solo_work_lite` → `solo_coder` → `solo_agent_lite` → `solo_agent` → `chat_v3`). Needs an app config; Free personal accounts often get `2001` and are cooled down for `TRAE_LLM_RETRY_MS` (10 min).
- `chat_sessions` (`POST /api/remote/v1/chat_sessions` → `…/:id/messages` → `…/:id/events` SSE) — always available, history flattened into a role-tagged transcript, about 17.6k–20.8k prompt tokens of fixed agent-system-prompt overhead per turn, and the only channel that works for accounts without app config. It has no tool field, so the relay's prompt-emulated tool layer applies (one ```tool_call block per reply; a streaming gate withholds markers so they never leak; tolerant parsing handles flat arguments, extra braces, case differences and truncated `finish` summaries, but executes only when all required parameters are complete). Obedient models: glm-5.x / qwen / kimi / minimax; deepseek-v4-flash / pro are not.
- `TRAE_UPSTREAM=auto` (default) prefers `llm_utils_chat`, falls back to `chat_sessions` on `2001`/hard errors. `llm` and `session` force one channel. The response's `trae.channel` says which one ran; `/health` exposes both channels, `model_cache_age_ms`, `model_health`, `model_fallback`, `upstreams`, `credential`, `mode:"stateless"`.
- `4001 config item is empty` means the model is not provisioned for this account/function: non-streaming returns 502 with an explicit message, streaming appends `[relay error] …`; the model enters the health table for `TRAE_MODEL_BAD_MS` (10 min) and is hidden from `/v1/models` unless `TRAE_MODELS_HIDE_BAD=0`. Optional `TRAE_MODEL_FALLBACK=glm-5.1` switches models automatically. Case-spelling aliases are retried before giving up (e.g. `deepseek-v4-flash` → `DeepSeek-V4-Flash`), and the response marks `model_alias`.
- Catalog: the bare `/models` endpoint returns only the default 12 `solo_coder` models; the client sends `functions=solo_coder,solo_agent_lite,solo_agent_remote,solo_work_lite,solo_work_remote,solo_design_lite,solo_design_remote,builder&show_custom_model=true`, which returns seven groups. The gateway unions both calls — **33 live models on 2026-10-18**, including new `glm-5.3-flash`, `glm-5.3-flashx`, `mimo-v2.6-flash`, `mimo-v2.6-pro`. `models-catalog.json` remains a 28-entry snapshot for naming and offline checks; live catalogs are always pulled from the gateway. The custom `z-ai/glm-5.2` entry returns 200 but empty content and is excluded.
- Env vars: `TRAE_UPSTREAM`, `TRAE_HOSTS`, `TRAE_LLM_RETRY_MS`, `TRAE_MODEL_CACHE_MS`, `TRAE_MODEL_BAD_MS`, `TRAE_MODELS_HIDE_BAD`, `TRAE_MODEL_FALLBACK`, `TRAE_REASONING=0`, `TRAE_INBOUND_KEYS` / `TRAE_INBOUND_AUTH=0`.

**豆包工作 / Doubao Work** — no signing parameters and no local gateway: cookie authentication only (`a_bogus` can be omitted, `msToken` comes from the cookie), so the relay runs standalone without the client open. Cookies come from CDP (`Network.getAllCookies`) rather than DPAPI. The request must carry the client's fingerprint query parameters and UA. SSE event types are enumerated; the body text is assembled from the `CHUNK_DELTA` increments (`end_type=1`'s `brief` is only a truncated fallback). The catalog is not enumerable, so two synthetic models are exposed (`doubao`, `doubao-think`). Tool calls are not supported (`tools` is ignored, not rejected). The pinned conversation is only transport scratch paper: every request flattens the full history into one message and nothing is reused. Note the relay's traffic really does show up in your local Doubao conversation list — point it at a dedicated conversation via `POST /admin/conversation` if that bothers you.

**Comate 文心快码** — the license is plaintext in the IDE's `settings.json` (a UUID under `baidu.comate.license`); the 32-hex `comate_login_ID` in globalStorage is *not* valid, and the DPAPI/AES-GCM path is a dead end documented in `comate/decrypt_auth.py`. The relay replays the kernel→cloud three-step chain (conversation → task → execute), which requires real conversation/task ids (the official CLI's `-1/-1` placeholders are rejected by OpenRASP). **Execution has two endpoints with the identical body**: `…/v2/execute` (`text/event-stream`, frames pushed as the agent produces them) and `…/v2/execute-sync` (the whole `{"frames":[…]}` at once). The relay prefers the SSE one, so reasoning (`reasoningDelta`) and text (`delta`) reach the caller while they are still being produced, and only degrades to `execute-sync` when the stream cannot be established (`stream_fallbacks` in `/health` counts that). Reasoning is shaped properly on both protocols: OpenAI gets `reasoning_content` deltas, Anthropic gets a real thinking block — previously a lone `thinking_delta` arrived with no block around it, and the OpenAI path dropped reasoning entirely. **Every new question is stateless** (fresh conversation+task, history flattened into `query`), and the tool loop is the single exception: `FUNCTION_CALL_*` frames are assembled into OpenAI `tool_calls` / Anthropic `tool_use`, the caller's results are translated into the upstream's own `toolUseResults` items (`{id, name, success, params, message}`) and continued on the **same conversation+task** with `query:""`, `isFirstQuery:false` — the kernel's own idiom. Control tools (`compress_message`/`task_complete`/`memory_extract`) have no client handler and are answered relay-side (up to 2 extra hops per request); if the caller hangs up mid-turn the upstream request is aborted so a zombie agent turn stops spending credits. Frame names are Claude vocabulary and are mapped back to the caller's spelling (canonical aliases: `Bash`↔`run_command`), with parameters filtered against the caller's declared schema; a call the caller never declared cannot be executed. Results must return to the conversation+task that produced them, so the relay keeps a **bounded routing table** (256 entries, 30-minute TTL, surfaced as `tool_routing_cached` in `/health`) — a routing table, not a session pool: a miss degrades to the flattened-history path instead of failing. `COMATE_RELAY_WORKSPACE=<path>` (or `--workspace`) tells the cloud agent which workspace root to assume. 15 models, `auto` plus real model keys.

**Qoder CN / QwenWork CN** — COSY signing (RSA-wrapped AES session key + MD5 signature + custom Base64 body encoding), vendored from the community [qoder2api-hub](https://github.com/shuishuipingan/qoder2api-hub) (MIT) with local patches for the `qworkcn` realm. Desktop credentials are imported into a pool; the panel login (default password `admin`, loopback only) plus `/accounts/import/desktop` does it in two steps. Free accounts get `Qwen3.8-Max/Flash` at 0 credits; other models return 403 code 112, and the catalog marks them `enabled:false` so registration filters them out. QwenWork CN's two traps both surface as a **503 embedded in a 200 SSE stream**: its catalog is scene-partitioned (`chat` is empty for qworkcn; the models live under `qwork`), and the outbound body must declare the workbench shape (`session_type` / `business.product = qoder_work`). Its model names are a **closed catalog** — CN aliases of the same name point at different keys and return 403 `Model is not available for this user`, so that realm resolves only within its own catalog and alias table.

## Codex CLI (Responses API)

Codex CLI 0.100+ only accepts `wire_api = "responses"`. Links with a native `/v1/responses` are registered **directly** — AutoClaw (:18766), Comate (:18774, with IDE tool vocabulary translated into Codex's shell vocabulary by `comate/codex_shell.mjs`), Qoder CN and QwenWork CN (:8791, split by the realm-bound key). WorkBuddy (`:18776/wb`), Trae (`:18776/trae`) and Doubao (`:18776/doubao`, text only) go through the **front door** `bridge/codex_front.mjs` (loopback only), which forwards `/<link>/v1/responses` to the upstream's `/v1/chat/completions` and passes everything else (models, auth headers) through untouched; upstream status codes come back verbatim (401/402 semantics). The shared transform `bridge/responses_transform.mjs` is reused by Comate's native `/v1/responses` route (one streaming state machine; reasoning, tool calls and usage are all filled in by the translation layer, and a compaction turn must return exactly one compaction item or codex-rs fatals).

**Trae's Codex registration stays on the chat tier by default** (model `deepseek-v4-flash-official`) even though the relay now supports tools: that default does not follow the prompt-emulated contract, and Trae model ids are case/suffix sensitive (`deepseek-v4-flash` silently returns an empty 200; the `-official` entry is the one that speaks). To use Trae tools in Codex, pick `glm-5.1` or another obedient model and verify it yourself; don't switch the default back to bare `deepseek-v4-flash`.

Registration (`app/codex-config.js`) touches only a managed section of `~/.codex/config.toml`, behind four gates: shape allow-list, everything outside the managed section **byte-identical** (it compares "the remainder after removing managed lines"), atomic tmp+rename with a backup, and read-back verification with rollback. Credentials live in the provider table's `experimental_bearer_token` — `~/.codex/auth.json` (the official login) is never touched. `model_catalog_json` **replaces** Codex's bundled catalog (0.160.1), so the generated catalog clones the bundled entries first and appends ours using a minimal template (no `apply_patch_tool_type` / `supports_search_tool`, since the bridge only translates shell vocabulary).

Qoder upstream tool quirks (hard-won 2026-10-11): only `type:"function"` tools are accepted (Codex also sends `web_search` and a `namespace`, which the gateway must filter), and the tools must be in **nested Chat Completions shape** — flat Responses-shaped tools get an HTTP 400 `Error in upstream response` hidden inside an HTTP 200 stream, which surfaces in Codex as `stream disconnected before completion`. `responses_to_chat()` now normalizes tools on the Responses path too (the chat path always did); `QODER_DUMP_BODY=<file>` dumps the outbound upstream body for this kind of bisect.

Verified end-to-end with `node bridge/test_codex_e2e.mjs [link]` (register → a real `codex exec` tool loop → deregister and byte-exact restore; `CODEX_HOME` points into a sandbox, your real `~/.codex` is never touched). 2026-10-11: Comate ✓, WorkBuddy ✓, Trae ✓ (text), Doubao ✓ (text), QwenWork CN ✓ (tool loop); Qoder CN was blocked by the vendor's daily quota cap and AutoClaw's desktop app was not running — both environmental, no code change needed.

### Manual Codex configuration (bypassing the console)

The console's Codex CLI page is the recommended path: it merges the catalog, applies the four write gates, and restores `config.toml` byte-for-byte on removal. The equivalent minimal hand-written config is:

```toml
# ~/.codex/config.toml
model = "glm-5.3"
model_provider = "aswitch-autoclaw"

[model_providers.aswitch-autoclaw]
name = "A-SWITCH AutoClaw"
base_url = "http://127.0.0.1:18766/v1"
wire_api = "responses"
experimental_bearer_token = "autoclaw-local"
```

- Front-door links: replace `base_url` with `http://127.0.0.1:18776/wb/v1` (WorkBuddy), `/trae/v1` (Trae) or `/doubao/v1` (Doubao), and the token with that link's inbound key.
- `wire_api` must be `"responses"`; `experimental_bearer_token` keeps this provider independent of `~/.codex/auth.json` (leave the official login alone).
- Multiple links: give each one a `[model_providers.aswitch-<link>]` table and switch only the top-level `model_provider` / `model`.
- `model_catalog_json` **replaces** Codex's bundled catalog (measured on 0.160.1): hand-writing it means either omitting it (use the bundled catalog) or pointing it at a complete catalog that already clones the bundled entries; console registration performs that merge for you.
- Verify with `codex exec "reply OK"`; inspect the catalog with `codex debug models`.

## Using the relay as a plain API (OpenAI / Anthropic / Responses)

You do not need ZCode or Codex registration: point any standard client at the local gateway. Model endpoints require an inbound key (generation/rotation is on the Inbound api_key page — see the next section); the table lists the built-in fallback keys.

| Link | Port | OpenAI chat | Anthropic messages | Responses | Built-in key / exit selection |
|---|---|---|---|---|---|
| AutoClaw | 18766 | `/v1/chat/completions` | `/v1/messages` | `/v1/responses` native | `autoclaw-local` (or `autoclaw-dsh`) |
| WorkBuddy | 7863 | `/v1/chat/completions` | — | via front door `:18776/wb/v1/responses` | `wb-local-key` (**Bearer only**) |
| Trae SOLO CN | 18768 | `/v1/chat/completions` | `/v1/messages` | via front door `:18776/trae/v1/responses` | `trae-local-key` |
| Doubao Work | 18770 | `/v1/chat/completions` | `/v1/messages` | via front door `:18776/doubao/v1/responses` | `doubao-local-key` |
| Comate | 18774 | `/v1/chat/completions` | `/v1/messages` | `/v1/responses` native | `comate-local` |
| Qoder CN | 8791 | `/v1/chat/completions` | — | `/v1/responses` native | `cn` in `~/.autoclaw-relay/qoder-realm-keys.json` |
| QwenWork CN | 8791 | `/v1/chat/completions` | — | `/v1/responses` native | `qworkcn` in the same file |

The front door `bridge/codex_front.mjs` (loopback `127.0.0.1:18776` by default) only translates Responses→Chat under `/wb`, `/trae` and `/doubao`; `Authorization` / `x-api-key` pass through to the upstream untouched, and so do upstream status codes.

**OpenAI SDK** (`base_url` includes `/v1`):

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:18766/v1", api_key="autoclaw-local")
resp = client.chat.completions.create(
    model="glm-5.3-flash",
    messages=[{"role": "user", "content": "reply OK"}],
)
print(resp.choices[0].message.content)
```

**Anthropic SDK** (`base_url` has no `/v1`; the SDK appends `/v1/messages`):

```python
from anthropic import Anthropic

client = Anthropic(base_url="http://127.0.0.1:18768", api_key="trae-local-key")
msg = client.messages.create(
    model="glm-5.1", max_tokens=64,
    messages=[{"role": "user", "content": "reply OK"}],
)
print(msg.content[0].text)
```

**curl, three shapes** (for non-ASCII bodies use `--data-binary @utf8.json`; Git Bash turns `-d '中文'` into GBK garbage):

```bash
# OpenAI chat
curl -X POST http://127.0.0.1:18766/v1/chat/completions \
  -H "Authorization: Bearer autoclaw-local" -H "Content-Type: application/json" \
  -d '{"model":"glm-5.3-flash","messages":[{"role":"user","content":"reply OK"}]}'

# Anthropic messages
curl -X POST http://127.0.0.1:18768/v1/messages \
  -H "x-api-key: trae-local-key" -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"glm-5.1","max_tokens":64,"messages":[{"role":"user","content":"reply OK"}]}'

# Responses (native)
curl -X POST http://127.0.0.1:18766/v1/responses \
  -H "Authorization: Bearer autoclaw-local" -H "Content-Type: application/json" \
  -d '{"model":"glm-5.3-flash","input":"reply OK"}'

# Responses (front-door translation)
curl -X POST http://127.0.0.1:18776/wb/v1/responses \
  -H "Authorization: Bearer wb-local-key" -H "Content-Type: application/json" \
  -d '{"model":"glm-5.3","input":"reply OK"}'
```

**Streaming**: OpenAI endpoints take `"stream":true` and emit `data: {...}` chunks ending in `data: [DONE]` (add `"stream_options":{"include_usage":true}` for usage); Anthropic endpoints emit `message_start` / `content_block_delta` / `message_stop`; Responses endpoints emit semantic events. Native and front-door streams have the same shape, so clients need no special case.

**Model names**: call `GET /v1/models` with the same key to get canonical ids; chat endpoints also accept old/raw names. Trae is case- and suffix-sensitive — `deepseek-v4-flash-official` and `deepseek-v4-flash` are not the same entry (the latter can silently return an empty 200); Doubao exposes only the synthetic `doubao` / `doubao-think`; Qoder entries with `enabled:false` are paywalled and return 403 on Free accounts.

**Capability boundaries**: tool calling depends on the upstream protocol (see [protocol fidelity](#protocol-fidelity-which-links-are-really-chat-completions)) — WorkBuddy / AutoClaw are natively structured; Comate / Qoder / QwenWork close the loop; Trae needs a model that obeys the emulated contract (`glm-5.1` and friends); Doubao is chat-only. `401` means a bad inbound key; `402` (credits), `406` (AutoClaw risk gate) and `4001`/`2001` (Trae model / account app config) are upstream states, not key problems.

**Security boundaries**: the other gateways bind `127.0.0.1` by default, but **AutoClaw listens on `0.0.0.0`** — on an untrusted network set `AUTOCLAW_BIND_HOST=127.0.0.1` and restart it. Keys and exit keys are plaintext under `~/.autoclaw-relay/` (`inbound-keys.json` / `qoder-realm-keys.json`, mode 0600); never commit or share them.

## Dynamic add/remove of ZCode providers

Which providers appear in ZCode = which platform links are currently on. The console maintains this automatically:

- **Starting** a platform (its own start button or "Start all") registers its provider in ZCode automatically (catalog pulled live);
- **Stopping** a platform removes its provider from ZCode (Qoder CN and QwenWork CN share one gateway process, so they toggle together);
- **Console boot reconciles**: running links are (re-)registered, stopped links are removed (serialized in the background; skipped in self-test mode).

Implementation and safety: the sync shares the exact registration builders and write path with the one-click register (`platformCatalogs()` / `applyPlatformReg()` in `app/main.js`) and always goes through the four `writeZcodeConfig` gates. The "remove" half is `removeProviders()` in `zcode-config.js` — it only detaches our own providers from `providerRules` / `providerModelRules` / `providerOrder`, never touching anyone else; the intentionally-deleted structure paths must be allowed via `removedProviderAllowPaths()`, otherwise the gate rejects the whole write (cases H2/H4 pin this down). Syncs run in a serial queue (one at a time); the latest result is shown on the ZCode page as e.g. "synced 10-07 23:55 (+comate -trae)".

Scope note: **this syncs the switch, not health.** Press start (even if that platform's login is expired and requests will 401) and the provider appears; press stop and it disappears. A gateway crash does not auto-remove the provider — that is a failure, not your choice.

## Unified model naming (models-catalog.json)

Model ids across the seven platforms used to be a zoo: Comate carried `_<hash>` suffixes, AutoClaw carried internal route prefixes (`zaicoding_glm-5.3`), Qoder/QwenWork used official display names (`Qwen3.8-Max`, or even Chinese tier names), and Trae mixed cases with the same model listed twice. **`models-catalog.json` at the repo root is the single source of truth** for externally visible model names, with seven rules:

1. all lowercase: `glm-5.3`, `deepseek-v4.1-flash`;
2. `<family>-<version>[-<variant>]` (families: glm / deepseek / kimi / minimax / qwen / doubao-seed / step / hunyuan);
3. no upstream internals: Comate's `_<hash>`, AutoClaw's route prefixes (`zaicoding_`/`tdpsk_`/`zai_`), Comate's `-fc`/`-oneapi` tool markers;
4. the same underlying model has the same id everywhere (`glm-5.3` is identical on four platforms); **identities that cannot be verified are not claimed** (Qoder's `DeepSeek-Flash` stays `deepseek-flash` rather than pretending to be `deepseek-v4-flash`; QwenWork's "Advanced" tier is `qwen-pro` because its underlying version is unverified);
5. platform-native namespaces keep their prefix (WorkBuddy's `cn:`), lowercase inside as well;
6. variant suffixes are fixed vocabulary (`-flash`/`-pro`/`-plus`/`-turbo`/`-think`/`-official`/`-preview`/`-code`/`-evolving`/`-max`);
7. compatibility: every gateway **also accepts the old/raw names** (alias resolution); ZCode switches to canonical ids at the next registration, and old configs keep working until then.

Enforcement (not just documentation — three closed loops):

- **Gateway layer**: `/v1/models` serves canonical ids only (Comate strips hashes, Trae lowercases and merges case-duplicates, Qoder/QwenWork map abbreviation keys to canonical names, AutoClaw drops route prefixes), while chat resolution accepts canonical/old/raw spellings alike and maps them to the same upstream model;
- **Registration layer**: the `modelId` registered into ZCode is the canonical id (AutoClaw's truth, column one of `a_switch.py`'s `ZCODE_MODELS`, is canonical now);
- **Test layer**: `node test_model_catalog.mjs` guards it — offline it validates the catalog itself and its parity with `a_switch.py`; with `--live` it also checks every running gateway's served ids for conformance and that every canonical id of a static-catalog platform is online (new upstream models are allowed if conforming, with an INFO hint to extend the catalog). Trae's live catalog now runs ahead of the static snapshot (33 vs 28) — expected; the snapshot follows the release cadence.

## ZCode provider registration: the write gate (important)

`~/.zcode/v2/provider_config.json` belongs to **ZCode**; the console is only allowed to touch the seven providers it registered. Two historical incidents shared one root cause: writing an invalid `api.type` (treating the internal kind `openai-compatible` as legal, which broke provider loading entirely), and "normalizing to the set I know" deleting other people's entries (dropping the required `manualProviderModelRules`, and shrinking AutoClaw's catalog to 4 models). The rules now live in `app/zcode-config.js`:

- **`api.type` accepts exactly three values**: `anthropic-messages` / `openai-responses` / `openai-chat-completions`.
- **Structural key-set assertion before and after writing**: losing any pre-existing key or entry rejects the whole write. The allow-list only covers the seven catalogs (dynamic removals use `removedProviderAllowPaths()` to generate per-provider allow prefixes — see [Dynamic add/remove](#dynamic-addremove-of-zcode-providers)).
  - The allow-list has a trap: array elements are identified as `providerId/modelId` in structural paths, and a **malformed entry missing `modelId` yields only `providerId`** — so each provider must allow both the `…providerModelRules[<pid>]` and `…providerModelRules[<pid>/` prefixes. Otherwise the very write that repairs bad data gets rejected by your own gate, and the bad entry can never be fixed.
- **`ok` in the registration result only means "the catalog was fetched"**; whether the write survived the gate is a separate `registerError` field. There was a "all green but the config never changed" incident; a dedicated self-test case now asserts `registerError` is empty.
- **Catalogs are union-only**: `personalModelIds` grows, never shrinks; capabilities like `supportsImage` are preserved, only `contextWindow` is refreshed.
- **Atomic write + read-back + rollback**: temp file then rename, re-parse, and roll back to `*.bak-<timestamp>` on failure.
- **AutoClaw's catalog truth is `a_switch.py`'s `ZCODE_MODELS`** (4 models with per-route vision flags measured live), not a hard-coded list in the console; the two `tdpsk_deepseek-*` entries (DeepSeek-V4.1-Flash / DeepSeek-V4-Pro) are not registered because upstream pulled them from the account catalog on 2026-09-29 (requests return 400) — they stay in the list as commented-out entries and come back when the entitlement does.
- **Exit selection is by key, not by header**: ZCode's provider entry has no custom-request-header field, and Qoder CN / QwenWork CN share port 8791, so the console first asks the gateway panel to mint two realm-bound keys (`~/.autoclaw-relay/qoder-realm-keys.json`, mode 0600, plaintext local-only) and **keeps `auth_disabled:false`** — every `/v1` path requires a key, and the key also decides which exit to use. When writing the panel config, empty `key` values preserve other people's entries.

The sandbox regression test `node app/test_zcode_config.js` (**19 cases**, synthetic fixtures in a temp directory, never touching your real config) reproduces both historical incidents (A1/A2/A3), covers the malformed-entry rewrite (A4), the removal half of dynamic sync (H1–H4: clean detachment leaving everyone else intact, allow-list-less removal rejected by the gate, removing an absent provider is a no-op, allow prefixes cannot spill into prefix-siblings), and a source-hygiene check (G1): `app/main.js` must not declare two top-level functions with the same name — JavaScript silently overrides the later one (no error, `node --check` passes), which once turned `comateModels()` into a version returning plain strings and wrote `modelId: null` for all 15 Comate models while still reporting success.

## Inbound api_key gate

Model-serving paths (`/v1/messages`, `/v1/chat/completions`, `/v1/responses`, `/v1/models`, `/routes`; the Comate gateway also has unprefixed variants) require `x-api-key` or `Authorization: Bearer`, compared in constant time. **Anonymous inference is always 401** — the `access.apiKey` registered in ZCode is a real, enforced key now, not decoration. Exemptions: `/health`, `/healthz`, `/`, `/fwd` (GUI bridge), `/admin/*` (Doubao), OPTIONS preflight — the desktop app and console need no changes. Built-in keys: AutoClaw `autoclaw-local` ∪ `autoclaw-dsh`; Comate `comate-local`; Trae `trae-local-key`; Doubao `doubao-local-key` ∪ config `key`; WorkBuddy wb2api's own `api_key` (`wb-local-key`, Bearer only); Qoder/QwenWork the two realm-bound exit keys. Rotation is available per link via `*_INBOUND_KEYS` env vars (or `*_RELAY_KEY` for Doubao/Comate) and can be disabled with `*_INBOUND_AUTH=0`.

**Generate api_key** (console's "Inbound api_key" page, since 2026-10-11): the per-row **Generate** button mints a random key (`tr-<36 hex>`, platform prefix included) and **adds** it rather than replacing the lock. It is written to `~/.autoclaw-relay/inbound-keys.json` (0600, runtime data, never committed), the link is restarted so it reads the new key, and the ZCode registration value is switched to it. **The built-in fallback key is never revoked** (it is a constant in the relay source; the console cannot delete it) — it just drops from primary to backup; the gate accepts the union of stored, built-in and env-rotated keys. The four env-driven links (AutoClaw / Trae / Doubao / Comate) read that file at startup; WorkBuddy is a single-key Go binary (Generate rewrites its `config.json` and restarts it); Qoder/QwenWork generate a new exit key (local plaintext → gateway → re-register) and cannot hold multiple keys. A manually started relay won't pick up the immediate restart — restart it once and it follows.

**Standard keys (`sk-` shape aliases, since 2026-10-11)**: tools that only accept `sk-`-shaped keys (DeepSeek Harness, Codex, OpenAI SDK family) may reject the platform-prefixed primary key, but changing the primary key to `sk-` would also change the ZCode registration and break the prefix convention. The **sk key** button on each env-driven row generates `sk-<platform>-<36 hex>` (or accepts your own `sk-xxx`), stores it under the reserved top-level `_aliases` map in `inbound-keys.json` (`{ "<link>": ["sk-…"] }`, fully backward compatible with the flat primary-key map), and restarts the link so the gate accepts **primary ∪ aliases**. Aliases **only enter the gate; they never change the ZCode registration value**, so adding/removing one needs no re-registration and does not affect ZCode. The inventory lists aliases on their own row (green edge, "(sk)" tag); the ✕ removes and restarts, invalidating it immediately. Manual equivalent: add an entry and restart the relay, then `Authorization: Bearer sk-tr-…` (or `x-api-key`). Only the four env-driven links support aliases — WorkBuddy is a single-key Go binary and Qoder/QwenWork use gateway-side exit keys; for those, use Generate / `keys:rotate` with an `sk-`-shaped primary value.

Regression: `node test_inbound_key.mjs` (67 offline cases, zero outbound: 401/allow predicates, both header shapes, OPTIONS 204, `/health` exemption, rotated keys, the disable switch, old and new auth coexisting on non-loopback listeners, all three Trae endpoints gated, Doubao catalog gated while `/admin` is exempt, generated stored keys accepted alongside built-ins, aliases accepted with both header shapes, aliases not crossing links, revoked aliases invalid after restart, old-format files without `_aliases` still working). `node app/test_inbound_keys.js` (34 cases) covers the generator/storage: random key shape and platform prefix, invalid values rejected, read/write and corruption fallback, alias add/remove/dedupe/tolerant read, the primary and alias write paths not consuming each other, and a drift guard asserting all four relays really read this file and `_aliases`.

## Anti-ban and credit management (AutoClaw)

Upstream risk control watches the **shape of your inference traffic**: an account making nothing but 1-token probes, or hammered at hundreds of requests per minute, gets banned. These numbers came from forensics on actually-banned accounts — don't tune them up:

- **Warm-up**: a new account should first run "🔥 Warm up" — 8 rounds of real technical conversation to make the traffic look human. Skip it and the account won't last long.
- **Rate limit**: 12 requests/min per account; **concurrency gate**: ≤4 in-flight across the pool; **daily budget**: 6000 requests/day per account (counted locally).
- **Multiple accounts**: the relay picks by balance and idleness and moves on when one runs dry. Add accounts with the GUI's "add via desktop login" (fully quit AutoClaw first, tray included).
- International accounts can register by email (CN is phone-only); new accounts receive 10,000 points over 7 days.

## Verifying

```
# AutoClaw relay (:18766, anthropic)
curl http://127.0.0.1:18766/health
curl -X POST http://127.0.0.1:18766/v1/messages \
  -H "Content-Type: application/json" -H "x-api-key: autoclaw-local" \
  -d '{"model":"glm-5.3-flash","max_tokens":50,"messages":[{"role":"user","content":"reply OK"}]}'

# WorkBuddy gateway (:7863, openai; the Go binary wb2api.exe)
workbuddy/workbuddy-manager-v1.0.79/upstream/wb2api.exe -config ~/.workbuddy-gateway/config.json &
curl http://127.0.0.1:7863/v1/models -H 'Authorization: Bearer wb-local-key'
curl -X POST http://127.0.0.1:7863/v1/chat/completions \
  -H 'Content-Type: application/json' -H 'Authorization: Bearer wb-local-key' \
  --data-binary @req.json                  # {"model":"glm-5.3","messages":[...]} — lowercase or cn: prefix

# Trae gateway (:18768, openai + anthropic; /health is exempt)
node trae/relay.mjs &
curl http://127.0.0.1:18768/health        # credential, dual channels, model cache, model_health, mode=stateless
curl -X POST http://127.0.0.1:18768/v1/chat/completions \
  -H 'Content-Type: application/json' -H 'Authorization: Bearer trae-local-key' \
  --data-binary @req.json                  # {"model":"glm-5.1","messages":[...],"tools":[...]} — no key => 401
# force one channel for debugging:
# TRAE_UPSTREAM=session node trae/relay.mjs
# TRAE_UPSTREAM=llm TRAE_MODEL_FALLBACK=glm-5.1 node trae/relay.mjs

# Doubao Work gateway (:18770, openai + anthropic)
node doubao/relay.mjs &
curl http://127.0.0.1:18770/health        # cookie health, pinned conversation, mode (stateless), models
curl -X POST http://127.0.0.1:18770/v1/chat/completions \
  -H 'Content-Type: application/json' -H 'Authorization: Bearer doubao-local-key' \
  --data-binary @req.json                  # {"model":"doubao","messages":[...]} — use a file for non-ASCII

# Comate gateway (:18774, openai + anthropic)
node comate/relay.mjs &
curl http://127.0.0.1:18774/health        # license, mode (stateless), tool loop + continuation routing-table size
curl -X POST http://127.0.0.1:18774/v1/chat/completions \
  -H 'Content-Type: application/json' -H 'x-api-key: comate-local' \
  -d '{"model":"auto","messages":[{"role":"user","content":"reply OK"}]}'

# Qoder CN / QwenWork CN gateway (:8791, openai + responses; one process, two exits)
python qoder/qoder_proxy.py --port 8791 --accounts-dir ~/.qoder-relay/accounts &
curl http://127.0.0.1:8791/health         # pool size, current realm, per-realm detail (probe exempt)
curl http://127.0.0.1:8791/v1/models -H "Authorization: Bearer <cn exit key>"
                                          # enabled=false items are paywalled for Free accounts (403 if called)
curl http://127.0.0.1:8791/v1/models -H "X-Realm: qworkcn"    # qwen3.8-flash / qwen-pro / qwen3.8-max
```

In Git Bash, `curl -d '中文'` sends GBK bytes (the console code page) — use a Node script or `--data-binary @utf8file` for non-ASCII.

**Trae dual-channel regression**:

- `node trae/test_dual.mjs` — **47 offline cases** (fake upstream, no network, no credits): channel-A text/reasoning/tools/usage, OpenAI and Anthropic streaming shapes, `2001` fallback, `4001` explicit error and health table, the emulated tool contract, the streaming gate never leaking markers, flat args / extra braces / case tolerance, truncated-repair boundaries, case-spelling aliases, model fallback, inbound gate. 47/47 on 2026-10-18.
- `TRAE_LIVE_BASE=http://127.0.0.1:18768 node trae/live_check.mjs` — live acceptance (real account; emulated tools, alias retry, 4001 messages); spends credits.
- `TRAE_LIVE_BASE=http://127.0.0.1:18768 node trae/live_stream.mjs` — live streaming acceptance (chunks arrive, markers never leak); spends credits.
- `node trae/test_relay.mjs` / `node trae/test_robust.mjs` — older online smoke/robustness scripts; need a running gateway and its inbound key, hit the real upstream.

Other regressions: `node doubao/test-relay.mjs`, `node doubao/test-zcode-shape.mjs`, `node comate/test_relay.mjs` (34 offline cases), `node comate/test_stream.mjs` (fake-upstream integration, 6 cases), `node app/test_zcode_config.js` (19), `node app/test_inbound_keys.js` (34), `node test_inbound_key.mjs` (67, zero outbound), `node test_model_catalog.mjs` (11 offline, `--live` against gateways), `python qoder/_test_qoder.py`, `python qoder/_test_leak_guard.py`, `python bridge/test_extract_persona.py`. Codex offline: `node app/test_codex_config.js` (21), `node bridge/test_responses_transform.mjs` (88), `node bridge/test_codex_front.mjs` (6), `node comate/test_responses.mjs` (10), `node comate/test_codex_shell.mjs` (14), `node comate/test_codex_shell_win.mjs` (5). Live: `node bridge/test_codex_e2e.mjs [link]`; Comate multi-hop tool loop `COMATE_E2E=1 node comate/e2e_tool_loop.mjs` (spends credits).

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `unauthorized: missing or invalid api key` (401, any gateway) | The gate is on but the request carries no/wrong key. ZCode uses the registered value automatically; manual curl uses `x-api-key` or `Authorization: Bearer` (wb2api accepts Bearer only). See the console's inbound page or `keys:query`. If a key is present and still rejected, the relay is running with an older env (restart it) or the registration value is stale. **If a standard tool complains about key shape**, add an `sk-…` alias via that link's "sk key" button; aliases are per-link, so an alias from link A will not work on link B |
| 401 Invalid token (AutoClaw) | The app rotated its access token. The credential watcher follows it automatically; if it is not running, log into AutoClaw once or re-run `bridge/make_compat_auth.py` |
| 402 insufficient credits | Terminal error — wait for the daily grant (1000/day on login) or top up; the relay does not retry |
| 406 empty response | One of the five 2.x gate factors is missing — most often `persona.txt` was never deployed; the console's "start" button extracts it from the installed client (search the log for `persona:`) |
| 810001 "system busy" | GLM-5.3-Flash is rate-limited at peak hours; 23:00–09:00 is clear. The relay backs off and retries; use GLM-5.3 or an Auto route during the day |
| Trae 401 | Credentials expire in ~5 days; log into Trae again. The gateway re-reads `storage.json` on 401 without a restart |
| Trae `2001 failed to get app config` | The account has no `llm_utils_chat` app config (common on Free personal accounts). Auto mode falls back to `chat_sessions`; check `/health.channels` or `trae.channel` to see which channel ran |
| Trae `4001 config item is empty` | The model is not provisioned for this account/function. Use `glm-5.1`/`glm-5.2`/`glm-5`/`kimi-k2.6`/`qwen-3.6-plus`, or set `TRAE_MODEL_FALLBACK=glm-5.1`; the health table hides it for `TRAE_MODEL_BAD_MS` (10 min) |
| Trae 200 but empty content | Wrong case/suffix (bare `deepseek-v4-flash` silently returns empty; `-official` speaks), or the model does not obey the emulated contract. Check `model_health`, retry with `glm-5.1` |
| Trae never calls tools / dumps the tool block as text | You are on the `chat_sessions` emulated layer and the model does not obey. Use glm-5.x / qwen / kimi / minimax; deepseek-v4-flash / pro are unsuitable |
| Qoder/QwenWork 401 or `no usable account for realm` | Split the 401: `invalid api key` means the request lacks/wrong exit key (inbound auth is on; keys in `~/.autoclaw-relay/qoder-realm-keys.json`); `no usable account` means the realm pool is empty or expired — press "Sync accounts"; cooling accounts become usable when the cooldown ends (or restart the gateway) |
| QwenWork returns `503 Model catalog unavailable` inside an SSE body (HTTP 200) | The catalog is scene-partitioned and the request must declare the workbench shape. Watch the payload, not the status code |
| Qoder/QwenWork gateway won't start | Needs Python 3.9+ (pure stdlib). Run `python qoder/qoder_proxy.py --port 8791` to see the real error; an occupied port means one is already running |
| Edits to `qoder/*.py`, `trae/relay.mjs` or `comate/relay.mjs` have no effect | A long-running process still has the old code — stop and start it (restart the console process for `app/main.js`; the exe must be rebuilt) |
| Comate 401 / won't start | The license in `settings.json` is stale; log into Comate once (the relay reads the file every request, no restart needed) |
| Comate 406 | Baidu's WAF: the request fingerprint must be node:https + axios headers; python-urllib is rejected outright |
| New models don't show in ZCode | The config is polled every 60 s; first make sure registration's `registerError` is empty (`ok` only means the catalog was fetched), then restart ZCode |
| A provider suddenly disappeared from ZCode | The "remove" half of dynamic sync: that platform's link was stopped (or was not running at console boot reconciliation). Press "start" on it to register it back; if the write to `~/.zcode/v2/provider_config.json` failed, the ZCode page and the log carry the `zcode sync failed` detail |
| Why are all model names lowercase now / do old names still work | That is the [unified naming convention](#unified-model-naming-models-catalogjson): `/v1/models` serves canonical ids, but every gateway's chat entry **also accepts the old names** (Comate's old hash ids, AutoClaw's old TitleCase names, Qoder's display names, QwenWork's 标准/高级 all keep alias resolution), so configs registered before still work until the next registration |
| Doubao 401 / missing cookie | The client's login state expired. Use "sync login state" (debug port already open) or "restart client and sync" |
| Doubao replies garbled or empty | Check that the request body really is UTF-8 (see the curl note above); if the pinned conversation was deleted, pick another with `POST /admin/conversation` |
| Button does nothing | Almost always Python missing `cryptography` — spawn succeeds, then the watcher dies instantly. Run the environment check |
| Console frozen | Rare, in old builds: an uncaught spawn error blocked the event loop. Current builds route through `trySpawn`; if it recurs, check PATH |

## Inherent limits

**Shared by all seven**: only WorkBuddy and AutoClaw keep message history structured upstream. The other five flatten history into text before feeding their agent protocols, so multi-turn tool round-trips, structured roles and attachment references can lose fidelity — most visible in long conversations. Qoder CN and QwenWork CN are the exception among those five (tools are a real list, only history is text), and Trae's `llm_utils_chat` also sends real tools, so tool loops still hold there. `chat_sessions` depends on model obedience.

**Vision** is configured per route from live tests: `glm-5.3-flash` and the Auto routes take images; `glm-5.3` (coding variant) does not and will say it cannot see. (In the measured matrix `deepseek-v4.1-flash` takes images and `deepseek-v4-pro` does not, but both routes have been out of the account catalog since 2026-09-29 and are not registered; the matrix comes back with the entitlement.)

**Trae**: the `chat_sessions` channel costs ~17.6k–20.8k prompt tokens of fixed overhead per turn (Trae's own agent system prompt), so short Q&A is uneconomical; the emulated tools only work with obedient models; Free accounts are often blocked on `llm_utils_chat` by `2001`, so the practical default is the emulated layer. The `llm_utils_chat` channel has no such fixed overhead but needs an account with an app config.

**Doubao Work**: no tool calls; only two synthetic catalog entries; request content stays in the local Doubao conversation.

**Comate**: the toolset is not yours to choose (the cloud agent uses its own; you can only execute a call if you declared a tool with the same or canonically equal name — declare none and there is nothing to call); the upstream agent's self-image comes from its own system prompt (it calls itself a Cursor-family assistant), not from your IDE; the `execute-sync` fallback path returns each turn's answer in one piece (8–40 s), while over SSE the first token usually lands in 1–2 s.

**Qoder CN**: most models sit behind a paywall on Free accounts (filtered out at registration via `enabled:false`); the usable ones still suffer flattened history. QwenWork CN's three-model catalog is **not interchangeable** with CN's — it only understands its own keys, so under the `qworkcn` exit none of CN's model names work (and vice versa). That is the upstream's closed catalog, not gateway filtering.

## Layout

```
(repo root — this is also the runtime resource root)
├── app/            Electron console (main.js / preload.js / zcode-config.js / codex-config.js /
│                   inbound-keys.js / test_*.js / renderer/ — 12-page sidebar)
├── bridge/         AutoClaw 2.x adapter (credential bridging, watcher, server_2x.mjs, persona extractor,
│                   406 experiments) + Codex front door codex_front.mjs + shared Responses⇄Chat transform
├── trae/           Trae SOLO CN relay (dual channel) + offline credential decryptor + probes +
│                   test_dual.mjs (47 offline) + live_check/live_stream + test_relay/test_robust
├── doubao/         Doubao Work relay + CDP tooling + protocol probes + regression tests
├── comate/         Comate relay (native /v1/responses + Codex shell bridge) + tool-loop/stream/
│                   /v1/responses tests + live E2E + stream probe + license reader
├── qoder/          Qoder CN / QwenWork CN gateway (vendored qoder2api-hub + local patches)
├── a_switch.py     A-SWITCH 1.x backend (accounts, check-in, DPAPI, one-click relay, warming)
├── models-catalog.json  ★ unified model-naming convention + per-platform canonical catalogs
├── test_model_catalog.mjs  naming guard (11 offline; --live also checks gateways)
├── test_inbound_key.mjs    inbound gate regression (67, zero outbound)
├── a_switch_app.py A-SWITCH 1.x GUI (pywebview)
├── relay/          upstream mainline relay (unified CN + international lanes)
├── workbuddy/      WorkBuddy gateway — NOT in git; unpack from Releases into
│                   workbuddy/workbuddy-manager-v1.0.79/upstream/
└── A-SWITCH.spec / tools/ / assets / README.md / README.en.md / TEST_REPORT.md / LICENSE
```

The repo root **is** the runtime resource root: the console locates gateways at `<root>/trae`, `<root>/comate`, etc., and loads `<root>/a_switch.py` for register/balance/sync — copying `app/` alone will not work. Runtime data is generated locally and never committed: `~/.autoclaw-relay/` (deployed relay, persona, logs, `inbound-keys.json` (0600; flat primary keys + top-level `_aliases`), Qoder realm keys), `~/.workbuddy-gateway/` (`auths/` pool, `config.json`, logs; `auths-disabled/` holds disabled accounts), `~/.openclaw-autoclaw/` (credential source), `~/.trae-relay/`, `~/.doubao-relay/`, `~/.comate-relay/`, `~/.qoder-relay/` (account pool, real tokens — never share these), and the ZCode config itself (backed up as `.bak-autoclaw`).

## A-SWITCH 1.x (legacy, still working)

The original tool — a multi-account manager for AutoClaw with a local relay — is still in this repo and still works.

1. **Multi-account.** Add, switch and monitor balances from one window, plus batch check-in for daily points (the AutoClaw client itself only logs in one account at a time).
2. **Ban prevention.** The parameters above (warming, 12/min, ≤4 in-flight, 6000/day) came from forensics on actually-banned accounts — don't tune them up.
3. **Relay.** One button deploys the local relay and registers AutoClaw in ZCode.

**Install (1.x)**: `pip install pywebview cryptography && python a_switch_app.py` (Windows only — token decryption uses DPAPI; Python 3.10+), or build the exe with `pip install pyinstaller && pyinstaller A-SWITCH.spec --noconfirm` → `dist/A-SWITCH.exe`.

**Usage (1.x)**: AutoClaw must be installed and logged in at least once. "Add via desktop login" pops the official login window and archives the account — fully quit AutoClaw first (tray icon included). "One-click relay" deploys the relay to `~/.autoclaw-relay/`, registers the provider and fires one verification request. "Warm-up" chats 8 rounds on real technical topics (skip it and the account won't last long). International accounts can register by email (CN is phone-only); new accounts receive 10,000 points over 7 days. `relay/server.mjs` is the upstream mainline relay (unified CN + international lanes; it is also what the one-click relay deploys), while the console deploys the standalone 2.x relay `bridge/server_2x.mjs`.

## Disclaimer

This project talks to AutoClaw, WorkBuddy, Trae SOLO CN, Doubao Work, Comate 文心快码, Qoder CN and QwenWork CN through reverse-engineered, unofficial interfaces, for study and research only. Account bans and credit losses are on you. Not for commercial use. AutoClaw is a Zhipu/Z.ai product, WorkBuddy's service comes from Tencent Cloud, Trae and Doubao Work are ByteDance products, Comate 文心快码 is a Baidu product, Qoder and QwenWork are Alibaba products. This project is not affiliated with any of them.
