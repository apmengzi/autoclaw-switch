# A-SWITCH · All-in-One relay platform

[English](README.en.md) | [中文](README.md) | [A-SWITCH 1.x standalone tool (releases)](../../releases/latest)

**One job: turn the built-in credits of seven Chinese AI clients/platforms into models you can select directly in your IDE.**

The prebuilt Windows console exe is on the [Releases](../../releases/latest) page; you can also run the console from source (Node only). The seven gateways themselves are plain files in this repo — Node scripts for five of them, pure-stdlib Python for the sixth, and one `wb2api.exe` that ships as a release asset.

| Platform | Credits | Gateway exposes | Upstream protocol † | Port | Models * | Tools |
|---|---|---|---|---|---|---|
| **AutoClaw** (Zhipu Z.ai) | account points, multi-account pool | anthropic + openai + responses | **native chat completions** (persona gate) | 18766 | 4 | ✅ structured |
| **WorkBuddy** (Tencent CodeBuddy) | ~100 credits/month + 30/day (free tier) | openai | **native chat completions** (body passed through verbatim) | 7863 | 46 | ✅ structured |
| **Trae SOLO CN** (ByteDance) | free session quota | openai + anthropic | remote agent session protocol (history flattened to text) | 18768 | 28 | ❌ text only |
| **豆包工作 / Doubao Work** (ByteDance) | client-bundled quota | openai + anthropic | web IM protocol (history flattened to text) | 18770 | 2 (synthetic) | ❌ text only |
| **Comate 文心快码** (Baidu) | Comate IDE quota | openai + anthropic | three-step cloud-agent chain (`/v2/execute` SSE, truly streamed; history flattened, **tools ride `toolUseResults` continuations**) | 18774 | 15 | ✅ continuation ‡ |
| **Qoder CN** (Alibaba) | client-bundled quota (Qwen3.8 line works on Free) | openai + responses | COSY envelope agent SSE (history flattened, **real tools list**) | 8791 | 14 | ✅ forwarded |
| **千问办公 / QwenWork CN** (Alibaba) | same Qoder platform, separate gateway | openai + responses | same as Qoder (qwork scene + workbench declaration) | 8791 | 3 | ✅ forwarded |

\* Model catalogs are pulled live per account; counts are what this machine measured in Oct 2026. AutoClaw's four are that account's current catalog (upstream removed the two `tdpsk_deepseek-*` routes on 2026-09-29; see the provider-registration note). Doubao's catalog lives server-side and is not enumerable — the gateway exposes two synthetic entries. Trae's upstream case-duplicates (e.g. `DeepSeek-V4-Flash`, solo_coder only) merge into the lowercase canonical entries; the snapshot lives in `models-catalog.json`.
† This is how the **upstream** actually talks, which is not the same thing as what the gateway exposes. All seven gateways accept `POST /v1/chat/completions`; only the first two talk chat completions to their upstream. Per-platform evidence in [Protocol fidelity](#protocol-fidelity-which-links-are-really-chat-completions).
‡ Comate's "continuation" is its tool loop: calls the upstream agent issues (`Write`/`Read`/`Bash`…) are translated into the caller's tool-call shape, and results are delivered back through `toolUseResults` on the **same conversation+task**. The toolset belongs to the upstream agent, not to you — the caller must declare a tool with the same (or canonically equivalent) name; see [Protocol fidelity](#protocol-fidelity-which-links-are-really-chat-completions) and the Comate note under [Per-link notes](#per-link-notes).

Everything runs on `127.0.0.1`, credentials never leave your machine. In ZCode the seven platforms are sibling providers (`autoclaw-glm-provider`, `workbuddy-openai-provider`, `trae-openai-provider`, `doubao-openai-provider`, `comate-openai-provider`, `qoder-openai-provider`, `qwenwork-openai-provider`) with no model-name collisions, so you can switch between them freely inside one session. Model ids follow the [unified naming convention](#unified-model-naming-models-catalogjson) (all lowercase, no upstream hashes or route prefixes); every gateway still accepts the old names.

Qoder CN and QwenWork CN share **one** gateway process on `8791` (same account pool, same COSY signing). On the ZCode side they are two providers, selected by API key: ZCode's provider config has no custom-request-header field, so binding a key to a realm is the only supported way to choose an exit. The console generates both keys, writes them into the gateway, and turns that gateway's key check off (it listens on loopback only and was unauthenticated before anyway).

## What it is / isn't

All seven upstreams are **consumer agent clients**, not public model APIs. Each spends its own credits inside its own official client; the relays here let a standard IDE (ZCode, or anything speaking OpenAI/Anthropic) spend those credits too.

- **It is** a local protocol translation layer: IDE → standard request → gateway translates to the upstream's real protocol → streams back.
- **It is not** an official API. Every link is reverse-engineered from the client (credential storage format, gateway hostnames, request signing, WAF gates, session protocols). When an upstream changes, the adapter must be re-reverse-engineered.
- **The cost**: unofficial usage carries a ban risk (AutoClaw in particular looks at the *shape* of your inference traffic), and billing follows each platform's own rules.

## Protocol fidelity: which links are really chat completions

Judging by the **gateway entry point**, you would conclude all seven are chat completions — they all serve `POST /v1/chat/completions`. Look at what each gateway sends **upstream** and the picture splits into three tiers.

**Tier A · upstream is natively chat completions (structured `messages`/`tools`, tool loops work)**

| Platform | Upstream endpoint | Payload |
|---|---|---|
| WorkBuddy | `POST copilot.tencent.com/v2/chat/completions` | The client body is **passed through verbatim**; only the model name is rewritten (the prefix is the gateway's own routing convention, the upstream takes bare names). `messages`, `tools`, `tool_calls` and reasoning fields all survive — the main reason it feels best as an agent pool |
| AutoClaw | `POST autoglm-api.zhipuai.cn/autoclaw-proxy/proxy/autoclaw/chat/completions` | OpenAI-shaped body (`messages` + `max_completion_tokens` + `stream_options.include_usage` + `store:false` + `reasoning_effort:high`). The Anthropic entry converts first (`anthropicToOpenai()`, tools via `anthropicToolsToOpenai()`); the Responses entry likewise (`responsesToolsToChat()`). **Protocol-wise it is WorkBuddy's equal — when it is unusable today that is a credits problem (402), not a protocol one** |

**Tier B · custom protocol that still carries real tools (tool calls translate, history is flattened)**

- **Qoder CN / QwenWork CN**: the outbound body is a deep copy of the official `baseprompt.json`. It *does* contain a `messages` array — but it is `[{role:"system"}, ...flattened history]`: `flatten_messages()` serializes assistant `tool_calls` into text markers. The one genuinely structured part is the tool declaration: a client-supplied `tools` list is placed into the envelope as-is, and the upstream parses it and answers `finish_reason:tool_calls`. So it is a **hybrid: real tools, fake message history**.
- **Comate**: your `tools` are not forwarded (the execute endpoints carry a single text `query` field), but tools **coming down** carry real semantics: `FUNCTION_CALL_START/_PARAMS_APPEND/_END` frames hold `toolUse:[{id,name,input}]`, with parameters streaming in as per-key fragments (the string-concatenation semantics of `appendParamContent`), and results go home through the upstream's own `toolUseResults` field, continuing the **same conversation+task** with `query:""`, `isFirstQuery:false` (exactly what the IDE kernel does). So it is a **closed tool loop, but with the upstream agent's own toolset** — frame names (`Write`/`Read`/`Bash`, Claude vocabulary) are mapped back to the caller's declared names via `V10_TOOL_ALIASES`, and a call the caller never declared cannot be executed.
- **Trae**: there is nowhere to put tools at all — `initial_message.query` is `JSON.stringify(prompt(text))`, and the protocol has neither a field for receiving `tools` nor a channel for returning tool calls. It is not that we drop tools; there is no place to put them.

**Tier C · web/product chat endpoints (simulation only)**

- **豆包工作 / Doubao Work**: `POST www.doubao.com/chat/completion` SSE with editor-block payloads (`messages[0].content_block[0].content.text_block.text`) — the furthest thing from chat completions here.

**What this means in practice.** Ranked by "can it drive an agent tool loop": **WorkBuddy ≈ AutoClaw (structurally faithful, tool loop closed) > Comate ≈ Qoder CN ≈ QwenWork CN (both close the loop, with complementary weaknesses: Comate continues the agent natively but the toolset is the agent's own; Qoder/QwenWork forward your tools for real but re-flatten history every turn, so repeated round-trips of the same tool are noticeably less faithful) > Trae (their own agent does the work; your tools are invisible) > Doubao (chat credits only)**. Symptom-wise, flattened links tend to be accurate on turn one and start drifting later; this is the root cause.

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
| Node.js 18+ | AutoClaw relay, Trae / Doubao / Comate gateways | "relay needs Node.js in PATH"; the packaged exe has a fallback runtime (PATH → AutoClaw's bundled node → the console itself) |
| Python 3.10+ with `pip install cryptography` | one-click register / balance query / credential sync (loads `a_switch.py`, found either at the repo root or under `autoclaw-switch/`) | button reports "no executable: python"; without `cryptography` the watcher spawns and dies instantly — the symptom is "the button does nothing" |
| Python 3.9+ (pure stdlib) | Qoder CN / QwenWork CN gateway (`qoder/qoder_proxy.py`) | Qoder card reports a missing gateway file or crashes on start (same `python` as above) |
| AutoClaw desktop app, logged in | credential source for the relay (2.x reads `%APPDATA%\AutoClaw-official\`) | relay starts but has no usable upstream |
| ZCode installed and run at least once | registration target `~/.zcode/v2/provider_config.json` | prompt to install ZCode first |
| Trae SOLO CN, logged in | Trae gateway credentials (decrypted offline) | Trae card shows "not started" |
| 豆包工作 client, logged in | Doubao credentials (CDP cookie capture; first time use "restart client and sync") | card shows missing cookie, requests return 401 |
| Comate (文心快码) IDE, logged in | reads `baidu.comate.license` from `%APPDATA%\Comate\User\settings.json` (re-login needs no relay restart) | Comate card shows "not started" / 401 |
| Qoder CN app, logged in | `%APPDATA%\com.qodercn.app.stable\auth.v1.dat`; import with the console's "Sync accounts" | that exit reports `no usable account for realm` |
| QwenWork CN app, logged in | `%APPDATA%\QwenWorkCN\auth-v2.dat`; same sync imports it | that exit finds no catalog, requests fail with `503 Model catalog unavailable` |
| `wb2api.exe` | the WorkBuddy gateway binary | card reports a missing file; it ships as a **Release** asset, not in git — unpack to `workbuddy/workbuddy-manager-v1.0.79/upstream/` |

## Desktop console (`app/`)

An Electron panel: **seven platform cards + a ZCode registration card + a log viewer + top bar**.

- **AutoClaw card** — status / upstream route / uptime / model aliases; start, stop, connectivity test (a real inference).
- **Account card** (same row) — points balance and expiring amount (queried on demand), token expiry, credential-watcher state and start/stop.
- **WorkBuddy card** — gateway status / credits / account / model catalog; start, stop, connectivity test.
- **Trae card** — status / account / credential expiry / mode (stateless) / catalog; start, stop, connectivity test.
- **Doubao Work card** — status / cookie health / pinned conversation (transport only) / mode / catalog; start, stop, connectivity test, **sync login state**, **restart client and sync**.
- **Comate card** — status / license state / mode (stateless + tool loop: conversation continuation, with the routing-table size) / catalog; start, stop, connectivity test.
- **Qoder CN card** — status / account pool / exit (`cn`) / listener / catalog (only models the account can use); start, stop, connectivity test, **sync accounts**.
- **QwenWork CN card** — the *other exit of the same gateway process* (card shows `出口 qworkcn (qwenwork.cn)` and the shared port); catalog shows the three `qwork`-scene models; same four buttons.
- **ZCode registration card** — registration state (including the most recent dynamic sync's additions/removals) / per-provider endpoint and model count / full model list / one-click register (full catalog refresh) / **config check** (read-only validation of `provider_config.json`).
- **Log viewer** — eight tabs: `relay` / watcher / WorkBuddy / Trae / Doubao Work / Comate / Qoder / console.
- **Top bar** — **Start all** (dependency-ordered; a missing prerequisite only affects its own link, and failures surface the environment-check output) and **Environment check**.

The environment check probes: Node runtime, Python, `cryptography`, every gateway's source and runtime files, the `a_switch.py` backend (what register/balance/sync load), every platform's login state (AutoClaw credentials, Trae `storage.json`, Doubao cookies, Comate `settings.json`, Qoder `auth.v1.dat`, QwenWork `auth-v2.dat`) and the ZCode config — each with "what it costs you" and "how to fix it".

Closing the window does not stop the background services (relays, gateways and the watcher are detached processes).

```
cd app && npm start                     # equal to: npx electron .
ASWITCH_SELFTEST=1 npx electron .       # 27-case functional self-test (7 connectivity + 7 registrations + Comate tool-loop capability + env check + gate assertions + logs + relay stop/start)
ASWITCH_SELFTEST=1 ASWITCH_SELFTEST_ONLY="zcode:register" npx electron .   # run a single handler
node app/test_zcode_config.js           # sandbox regression test for the config-write gate (synthetic fixtures, 19 cases)
node test_model_catalog.mjs             # model-naming consistency check (11 offline cases; --live also verifies running gateways)
```

The self-test covers `env:check`, `status:query`, `points:refresh`, `credential:sync`, watcher stop/start, all seven `*:smoke` handlers (real inference, not liveness pings), `comate:tool-loop` (reads `/health` to assert this relay build reports its tool loop — it recognizes a relay still running old code without spending credits), `all:start`, `zcode:register` (with per-provider assertions), `zcode:realm-keys`, `zcode:register:未被闸门拦下`, `zcode:check`, `logs:tail` and `relay:stop/start`. Results are written to `~/.autoclaw-relay/selftest-result.txt` (per-case pass/fail); `selftest-progress.txt` next to it is the running log. **Running the full self-test from the exe produces no stdout** — Electron is a GUI-subsystem process there, so read that JSON file instead. Two caveats: the full run restarts the relay (that is what the two relay cases assert), and editing `app/main.js` or `preload.js` requires restarting the Electron process — a running window never hot-reloads.

## Per-link notes

**All seven links are stateless gateways**, semantically aligned with AutoClaw's relay: no session state is kept anywhere, the caller sends the full history every request, and the answer depends only on that request. The AutoClaw link was always like this; Trae creates a fresh remote session per request and throws it away; Doubao has no "create session" API, so it uses one pinned conversation as **transport scratch paper** and never reuses server-side context; Comate replays the IDE kernel's three-step chain per request (the single exception is the tool loop within one turn of questioning, which continues the same conversation+task and reuses nothing across questions); Qoder CN and QwenWork CN flatten `messages` into a plain transcript inside the envelope's `messages` array (tools, in contrast, are sent as a real list). The benefit is predictability (same `messages`, same answer, no cross-request pollution); the cost is two-layered — protocol-level fidelity (above) plus each link's fixed per-turn overhead (Trae re-pays its agent system prompt every turn, Doubao re-sends the whole history).

**AutoClaw** — 2.0.1 moved credentials to `%APPDATA%\AutoClaw-official\accounts\<hash>\account-credentials.enc` (DPAPI-protected AES-256-GCM key in Local State), moved inference to an acceleration host, added `X-Auth-Sign`/`X-Channel`/`X-Session-Id` headers, and gates requests behind a WAF that demands a "real OpenAI SDK" shape. The 406 gate has five factors (clean HTTP/1.1 fingerprint via `node:https`, full OpenAI SDK fingerprint headers, `X-Session-Id`, a system message byte-identical to the app persona, and the exact body parameters) — missing any one returns an empty 406. The gateway substitutes the persona and moves your own system instructions into the first user message, so the model still sees them.

> **★ Dual-lane relay (2026-10)**: upstream folded the 2.x work into `relay/server.mjs` — a single unified proxy for **both CN and international accounts**: one port (18766), one pool, per-account lane routing. International accounts (`aswitch_cloud_pool.json`, default lane) hit `autoglm-api.autoglm.ai` with the 2.0.2 contract (harness-marker gate + fresh-token-per-request). CN accounts (`~/.autoclaw-relay/auth-compat/auth-cn.json`, written by `bridge/watch_auth.py`, which decrypts the 2.x client's credentials and follows its token rotation) hit `autoglm-api.zhipuai.cn` with the official-channel contract (exact-persona system gate + X-Session-Id/signature headers + `node:https` transport). Pick logs tag the lane as `(cn)`/`(oversea)` and the healthz pool mixes both. To add a CN account: sign in via the 2.x client, then keep `python bridge/watch_auth.py` running. `relay/server.mjs` is also what `a_switch.py`'s one-click relay deploys (the dual-client credential bridge, the 410004 ban list and the 2.0.2 gateway fixes all live there); the console deploys the PR#4 standalone 2.x relay at `bridge/server_2x.mjs`, which routes both lanes per account as well.

**WorkBuddy** — a local Go gateway (`wb2api`, api_key `wb-local-key`, config in the same directory), CLI OAuth login (`wb2api-login.exe url|poll --realm=cn`), 38-day tokens, account pool / circuit breaker / check-in keep-alive built in. Model names must be lowercase or `cn:`-prefixed. Credits shown and free quota are two separate ledgers (0 credits still completes).

**Trae SOLO CN** — the client does not call models directly; it drives a remote agent sandbox. Credentials are decrypted **offline** from `storage.json`'s `iCubeAuthInfo://icube.cloudide` blob (`byteCrypto`, pure JS, hard-coded tables) — no client patching, no IDE restart. The real user token is the only thing that passes auth (temp JWTs get 401). Each request creates a remote session, flattens history into a role-tagged transcript, answers, and discards — about 17.6k–20.8k prompt tokens of fixed overhead per turn. The catalog needs `functions=...&show_custom_model=true` or you only get the default 12 models; the gateway unions both calls (27 models here).

**豆包工作 / Doubao Work** — no signing parameters and no local gateway: cookie authentication only (`a_bogus` can be omitted, `msToken` comes from the cookie), so the relay runs standalone without the client open. Cookies come from CDP (`Network.getAllCookies`) rather than DPAPI. The request must carry the client's fingerprint query parameters and UA. Ten SSE event types were enumerated; the body text is assembled from the `CHUNK_DELTA` increments. The catalog is not enumerable, so two synthetic models are exposed (`doubao`, `doubao-think`). Tool calls are not supported (`tools` is ignored, not rejected). Note the relay's traffic really does show up in your local Doubao conversation list — point it at a dedicated conversation via `POST /admin/conversation` if that bothers you.

**Comate 文心快码** — the license is plaintext in the IDE's `settings.json` (a UUID under `baidu.comate.license`); the 32-hex `comate_login_ID` in globalStorage is *not* valid, and the DPAPI/AES-GCM path is a dead end documented in `comate/decrypt_auth.py`. The relay replays the kernel→cloud three-step chain (conversation → task → execute), which requires real conversation/task ids (the official CLI's `-1/-1` placeholders are rejected by OpenRASP). **Execution has two endpoints with the identical body**, exactly like the CLI's `execute` / `executeNonStream` pair: `…/v2/execute` (`text/event-stream`, frames pushed as the agent produces them) and `…/v2/execute-sync` (the whole `{"frames":[…]}` at once). The relay prefers the SSE one, so reasoning (`reasoningDelta`) and text (`delta`) reach the caller while they are still being produced, and only degrades to `execute-sync` when the stream cannot be established (`stream_fallbacks` in `/health` counts that). Reasoning is shaped properly on both protocols: OpenAI gets `reasoning_content` deltas, Anthropic gets a real thinking block (`content_block_start` → `thinking_delta` → `content_block_stop`) — previously a lone `thinking_delta` arrived with no block around it, and the OpenAI path dropped reasoning entirely. **Every new question is stateless** (fresh conversation+task, history flattened into `query`), and the tool loop is the single exception: `FUNCTION_CALL_*` frames are assembled into OpenAI `tool_calls` / Anthropic `tool_use`, the caller's results are translated into the upstream's own `toolUseResults` items (`{id, name, success, params, message}`) and continued on the **same conversation+task** with `query:""`, `isFirstQuery:false` — the kernel's own idiom. Control tools (`compress_message`/`task_complete`/`memory_extract`) have no client handler and are answered relay-side (up to 2 extra hops per request); if the caller hangs up mid-turn the upstream request is aborted so a zombie agent turn stops spending credits. Frame names are Claude vocabulary and are mapped back to the caller's spelling (canonical aliases: `Bash`↔`run_command`), with parameters filtered against the caller's declared schema; a call the caller never declared cannot be executed. Results must return to the conversation+task that produced them, so the relay keeps a **bounded routing table** (256 entries, 30-minute TTL, surfaced as `tool_routing_cached` in `/health`) — a routing table, not a session pool: a miss degrades to the flattened-history path instead of failing. `COMATE_RELAY_WORKSPACE=<path>` (or `--workspace`) tells the cloud agent which workspace root to assume. 15 models, `auto` plus real model keys.

**Qoder CN / QwenWork CN** — COSY signing (RSA-wrapped AES session key + MD5 signature + custom Base64 body encoding), vendored from the community [qoder2api-hub](https://github.com/shuishuipingan/qoder2api-hub) (MIT) with local patches for the `qworkcn` realm. Desktop credentials are imported into a pool; the panel login (default password `admin`, loopback only) plus `/accounts/import/desktop` does it in two steps. Free accounts get `Qwen3.8-Max/Flash` at 0 credits; other models return 403 code 112, and the catalog marks them `enabled:false` so registration filters them out. QwenWork CN's two traps both surface as a **503 embedded in a 200 SSE stream**: its catalog is scene-partitioned (`chat` is empty for qworkcn; the models live under `qwork`), and the outbound body must declare the workbench shape (`session_type` / `business.product = qoder_work`). Its model names are a **closed catalog** — CN aliases of the same name point at different keys and return 403 `Model is not available for this user`, so that realm resolves only within its own catalog and alias table.

## Dynamic add/remove of ZCode providers

Which providers appear in ZCode = which platform links are currently on. The console maintains this automatically:

- **Starting** a platform (its own start button or "Start all") registers its provider in ZCode automatically (catalog pulled live);
- **Stopping** a platform removes its provider from ZCode (Qoder CN and QwenWork CN share one gateway process, so they toggle together);
- **Console boot reconciles**: running links are (re-)registered, stopped links are removed (serialized in the background; skipped in self-test mode).

Implementation and safety: the sync shares the exact registration builders and write path with the one-click register (`platformCatalogs()` / `applyPlatformReg()` in `app/main.js`) and always goes through the four `writeZcodeConfig` gates. The "remove" half is `removeProviders()` in `zcode-config.js` — it only detaches our own providers from `providerRules` / `providerModelRules` / `providerOrder`, never touching anyone else; the intentionally-deleted structure paths must be allowed via `removedProviderAllowPaths()`, otherwise the gate rejects the whole write (cases H2/H4 pin this down). Syncs run in a serial queue (one at a time); the latest result is shown on the ZCode card as e.g. "synced 10-07 23:55 (+comate -trae)".

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

- **Gateway layer**: `/v1/models` serves canonical ids only (Comate strips hashes, Trae lowercases and merges the case-duplicate, Qoder/QwenWork map abbreviation keys to canonical names, AutoClaw drops route prefixes), while chat resolution accepts canonical/old/raw spellings alike and maps them to the same upstream model;
- **Registration layer**: the `modelId` registered into ZCode is the canonical id (AutoClaw's truth, column one of `a_switch.py`'s `ZCODE_MODELS`, is canonical now);
- **Test layer**: `node test_model_catalog.mjs` guards it — offline it validates the catalog itself and its parity with `a_switch.py`; with `--live` it also checks every running gateway's served ids for conformance and that every canonical id of a static-catalog platform is online (new upstream models are allowed if conforming, with an INFO hint to extend the catalog).

## ZCode provider registration: the write gate (important)

`~/.zcode/v2/provider_config.json` belongs to **ZCode**; the console is only allowed to touch the seven providers it registered. Two historical incidents shared one root cause: writing an invalid `api.type` (treating the internal kind `openai-compatible` as legal, which broke provider loading entirely), and "normalizing to the set I know" deleting other people's entries (dropping the required `manualProviderModelRules`, and shrinking AutoClaw's catalog to 4 models). The rules now live in `app/zcode-config.js`:

- **`api.type` accepts exactly three values**: `anthropic-messages` / `openai-responses` / `openai-chat-completions`.
- **Structural key-set assertion before and after writing**: losing any pre-existing key or entry rejects the whole write. The allow-list only covers the seven catalogs (dynamic removals use `removedProviderAllowPaths()` to generate per-provider allow prefixes — see [Dynamic add/remove](#dynamic-addremove-of-zcode-providers)).
  - The allow-list has a trap: array elements are identified as `providerId/modelId` in structural paths, and a **malformed entry missing `modelId` yields only `providerId`** — so each provider must allow both the `…providerModelRules[<pid>]` and `…providerModelRules[<pid>/` prefixes. Otherwise the very write that repairs bad data gets rejected by your own gate, and the bad entry can never be fixed.
- **`ok` in the registration result only means "the catalog was fetched"**; whether the write survived the gate is a separate `registerError` field. There was a "all green but the config never changed" incident; a dedicated self-test case now asserts `registerError` is empty.
- **Catalogs are union-only**: `personalModelIds` grows, never shrinks; capabilities like `supportsImage` are preserved, only `contextWindow` is refreshed.
- **Atomic write + read-back + rollback**: temp file then rename, re-parse, and roll back to `*.bak-<timestamp>` on failure.
- **AutoClaw's catalog truth is `a_switch.py`'s `ZCODE_MODELS`** (4 models with per-route vision flags measured live), not a hard-coded list in the console; the two `tdpsk_deepseek-*` entries (DeepSeek-V4.1-Flash / DeepSeek-V4-Pro) are not registered because upstream pulled them from the account catalog on 2026-09-29 (requests return 400) — they stay in the list as commented-out entries and come back when the entitlement does
- **Exit selection is by key, not by header**: the console asks the gateway panel to mint two realm-bound keys (`~/.autoclaw-relay/qoder-realm-keys.json`, mode 0600, plaintext local-only) and pushes `auth_disabled: true` — otherwise the existence of any key would make `/v1` require one and break pre-existing registrations. When writing the panel config, empty `key` values preserve other people's entries.

The sandbox regression test `node app/test_zcode_config.js` (**19 cases**, synthetic fixtures in a temp directory, never touching your real config) reproduces both historical incidents (A1/A2/A3), covers the malformed-entry rewrite (A4), the removal half of dynamic sync (H1–H4: clean detachment leaving everyone else intact, allow-list-less removal rejected by the gate, removing an absent provider is a no-op, allow prefixes cannot spill into prefix-siblings), and a source-hygiene check (G1): `app/main.js` must not declare two top-level functions with the same name — JavaScript silently overrides the later one (no error, `node --check` passes), which once turned `comateModels()` into a version returning plain strings and wrote `modelId: null` for all 15 Comate models while still reporting success.

## Verifying

```
# AutoClaw relay (:18766, anthropic)
curl http://127.0.0.1:18766/health
curl -X POST http://127.0.0.1:18766/v1/messages \
  -H "Content-Type: application/json" -H "x-api-key: autoclaw-local" \
  -d '{"model":"glm-5.3-flash","max_tokens":50,"messages":[{"role":"user","content":"reply OK"}]}'

# WorkBuddy gateway (:7863, openai; api_key wb-local-key)
curl http://127.0.0.1:7863/v1/models -H "Authorization: Bearer wb-local-key"

# Trae (:18768) / Doubao (:18770) / Comate (:18774), all openai + anthropic
curl http://127.0.0.1:18768/health
curl -X POST http://127.0.0.1:18770/v1/chat/completions \
  -H 'Content-Type: application/json' -H 'Authorization: Bearer doubao-local-key' \
  --data-binary @req.json            # {"model":"doubao","messages":[...]} — use a file for non-ASCII bodies

# Qoder CN / QwenWork CN gateway (:8791, openai; one process, two exits)
python qoder/qoder_proxy.py --port 8791 --accounts-dir ~/.qoder-relay/accounts &
curl http://127.0.0.1:8791/health
curl http://127.0.0.1:8791/v1/models -H "X-Realm: qworkcn"    # qwen3.8-flash(标准) / qwen-pro(高级) / qwen3.8-max
```

Regression tests: `node trae/test_relay.mjs`, `node trae/test_robust.mjs`, `node doubao/test-relay.mjs`, `node doubao/test-zcode-shape.mjs`, `node comate/test_relay.mjs` (Comate's tool-loop contract, 34 offline cases: frame→tool-call assembly, per-key parameter concatenation, the continuation routing table, message normalization for both protocols, tool-name mapping and schema filtering), `node comate/test_stream.mjs` (**fake-upstream integration test, 6 cases**: a local server impersonates comate.baidu.com and pushes real SSE, proving content chunks == upstream frames (true passthrough, not post-hoc slicing), reasoning blocks forming on both protocols, continuation landing on the same conversation+task, internal tools never leaking, and the sync fallback — no network, no credits), `node app/test_zcode_config.js` (config-write gate, 19 cases), `node test_model_catalog.mjs` (model-naming consistency: 11 offline cases, `--live` also checks running gateways), `python qoder/_test_qoder.py`, `python qoder/_test_leak_guard.py` (asserts tokens never leak), `python bridge/test_extract_persona.py` (persona extraction against a synthetic bundle: dependency ordering, self-checks, stale/write branches), and the console's per-card connectivity buttons for Qoder/QwenWork end-to-end. Comate's live multi-hop tool loop has its own `COMATE_E2E=1 node comate/e2e_tool_loop.mjs` (runs real tools, spends credits, skipped by default), and `node comate/probe_stream.mjs` timestamps every frame of one real streaming turn (spends credits, run by hand). In Git Bash, `curl -d '中文'` sends GBK bytes (the console code page) — use a Node script or `--data-binary @utf8file` for non-ASCII.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| 401 Invalid token (AutoClaw) | The app rotated its access token. The credential watcher follows it automatically; if it is not running, log into AutoClaw once or re-run `bridge/make_compat_auth.py` |
| 402 insufficient credits | Terminal error — wait for the daily grant (1000/day on login) or top up; the relay does not retry |
| 406 empty response | One of the five 2.x gate factors is missing — most often `persona.txt` was never deployed; the console's "start" button extracts it from the installed client (search the log for `persona:`) |
| 810001 "system busy" | GLM-5.3-Flash is rate-limited at peak hours; 23:00–09:00 is clear. The relay backs off and retries; use GLM-5.3 or an Auto route during the day |
| Trae 401 | Credentials expire in ~5 days; log into Trae again. The gateway re-reads `storage.json` on 401 without a restart |
| Qoder/QwenWork 401 or `no usable account for realm` | The realm's account pool is empty or expired. Press "Sync accounts"; cooling-down accounts become usable when the cooldown ends (or restart the gateway) |
| QwenWork returns `503 Model catalog unavailable` inside an SSE body (HTTP 200) | The catalog is scene-partitioned and the request must declare the workbench shape. Watch the payload, not the status code |
| Doubao 401 / missing cookie | The client's login state expired. Use "sync login state" (debug port already open) or "restart client and sync" |
| Doubao replies garbled or empty | Check that the request body really is UTF-8 (see the curl note above); if the pinned conversation was deleted, pick another with `POST /admin/conversation` |
| A provider suddenly disappeared from ZCode | The "remove" half of dynamic sync: that platform's link was stopped (or was not running at console boot reconciliation). Press "start" on it to register it back; if the write to `~/.zcode/v2/provider_config.json` failed, the ZCode card and the log carry the `zcode sync failed` detail |
| Why are all model names lowercase now / do old names still work | That is the [unified naming convention](#unified-model-naming-models-catalogjson): `/v1/models` serves canonical ids, but every gateway's chat entry **also accepts the old names** (Comate's old hash ids, AutoClaw's old TitleCase names, Qoder's display names, QwenWork's 标准/高级 all keep alias resolution), so configs registered before still work until the next registration |
| Button does nothing | Almost always Python missing `cryptography` — spawn succeeds, then the watcher dies instantly. Run the environment check |
| Console frozen | Rare, in old builds: an uncaught spawn error blocked the event loop. Current builds route through `trySpawn`; if it recurs, check PATH |

## Inherent limits

**Shared by all seven**: only WorkBuddy and AutoClaw keep the message history structured upstream. The other five flatten history into text before feeding their agent protocols, so multi-turn tool round-trips, structured roles and attachment references can lose fidelity — most visible in long conversations. Qoder CN and QwenWork CN are the exception among those five (tools are a real list, only history is text), so tool loops still hold.

**Vision** is configured per route from live tests: `glm-5.3-flash` and the Auto routes take images; `glm-5.3` (coding variant) does not and will say it cannot see. (In the measured matrix `deepseek-v4.1-flash` takes images and `deepseek-v4-pro` does not, but both routes have been out of the account catalog since 2026-09-29 and are not registered; the matrix comes back with the entitlement.)

**Trae**: tools are not forwarded (the agent decides for itself; OpenAI's `tools` field is ignored and the model only returns text); ~17.6k prompt tokens of fixed overhead per turn makes short Q&A uneconomical.

**Doubao Work**: no tool calls; only two synthetic catalog entries; request content stays in the local Doubao conversation.

**Comate**: the toolset is not yours to choose (the cloud agent uses its own; you can only execute a call if you declared a tool with the same or canonically equal name — declare none and there is nothing to call); the upstream agent's self-image comes from its own system prompt (it calls itself a Cursor-family assistant), not from your IDE; the `execute-sync` fallback path returns each turn's answer in one piece (8–40 s), while over SSE the first token usually lands in 1–2 s.

**Qoder CN**: most models sit behind a paywall on Free accounts (filtered out at registration via `enabled:false`); the usable ones still suffer flattened history. QwenWork CN's three-model catalog is **not interchangeable** with CN's — it only understands its own keys, so under the `qworkcn` exit none of CN's model names work (and vice versa). That is the upstream's closed catalog, not gateway filtering.

## Layout

```
(repo root — this is also the runtime resource root)
├── app/            Electron console (main.js / preload.js / zcode-config.js / test_zcode_config.js / renderer/)
├── bridge/         AutoClaw 2.x adapter: credential bridging, watcher, the standalone 2.x relay server_2x.mjs (what the console deploys), persona extractor, 406 experiments
├── trae/           Trae SOLO CN relay + offline credential decryptor + regression tests
├── doubao/         Doubao Work relay + CDP tooling + protocol probes
├── comate/         Comate relay + tool-loop regression test + fake-upstream stream test + live E2E + stream probe + license decryptor
├── qoder/          Qoder CN / QwenWork CN gateway (vendored qoder2api-hub + local patches)
├── a_switch.py     A-SWITCH 1.x backend (accounts, check-in, DPAPI, one-click relay, warming) — also what the
│                   console's register / balance / credential-sync handlers load
├── models-catalog.json  ★ unified model-naming convention + per-platform canonical catalogs (single source of truth)
├── test_model_catalog.mjs  naming-consistency guard (11 offline cases; --live also checks running gateways)
├── a_switch_app.py A-SWITCH 1.x GUI (pywebview)
├── relay/          upstream mainline relay (unified CN + international lanes)
├── workbuddy/      WorkBuddy gateway — NOT in git; unpack from Releases into workbuddy/workbuddy-manager-v1.0.79/upstream/
└── A-SWITCH.spec / tools/ / assets/ / docs / LICENSE
```

Runtime data is generated locally and never committed: `~/.autoclaw-relay/` (deployed relay, persona, logs, the Qoder realm keys), `~/.openclaw-autoclaw/` (credential source), `~/.trae-relay/`, `~/.doubao-relay/`, `~/.comate-relay/`, `~/.qoder-relay/` (account pool, real tokens — never share these), and the ZCode config itself (backed up as `.bak-autoclaw`).

## A-SWITCH 1.x (legacy, still working)

The original tool — a multi-account manager for AutoClaw with a local relay — is still in this repo and still works.

1. **Multi-account.** Add, switch and monitor balances from one window, plus batch check-in for daily points (the AutoClaw client itself only logs in one account at a time).
2. **Ban prevention.** Upstream risk control watches the *shape* of your traffic: an account making nothing but 1-token probes, or hammered at hundreds of requests per minute, gets banned. Hence account warming (8 rounds of real technical conversation for new accounts), rate limiting (12/min per account), a concurrency gate (≤4 in-flight per pool) and a daily budget (6000/day per account, counted locally). These numbers came from forensics on actually-banned accounts — don't tune them up.
3. **Relay.** One button deploys the local relay and registers AutoClaw in ZCode.

**Install (1.x)**: `pip install pywebview cryptography && python a_switch_app.py` (Windows only — token decryption uses DPAPI; Python 3.10+), or build the exe with `pip install pyinstaller && pyinstaller A-SWITCH.spec --noconfirm` → `dist/A-SWITCH.exe`.

**Usage (1.x)**: AutoClaw must be installed and logged in at least once. "Add via desktop login" pops the official login window and archives the account — fully quit AutoClaw first (tray icon included). "One-click relay" deploys the relay to `~/.autoclaw-relay/`, registers the provider and fires one verification request. "Warm-up" chats 8 rounds on real technical topics (skip it and the account won't last long). International accounts can register by email (CN is phone-only); new accounts receive 10,000 points over 7 days. `relay/server.mjs` is the upstream mainline relay (unified CN + international lanes; it is also what the one-click relay deploys), while the console deploys the standalone 2.x relay `bridge/server_2x.mjs`.

## Disclaimer

This project talks to AutoClaw, WorkBuddy, Trae SOLO CN, Doubao Work, Comate 文心快码, Qoder CN and QwenWork CN through reverse-engineered, unofficial interfaces, for study and research only. Account bans and credit losses are on you. Not for commercial use. AutoClaw is a Zhipu/Z.ai product, WorkBuddy's service comes from Tencent Cloud, Trae and Doubao Work are ByteDance products, Comate 文心快码 is a Baidu product, Qoder and QwenWork are Alibaba products. This project is not affiliated with any of them.
