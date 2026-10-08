# A·SWITCH（轻量版 · lite 分支）

> **📦 两个版本，按需取用**
>
> | 分支 | 适合谁 | 内容 |
> |---|---|---|
> | **[`lite`](../../tree/lite)**（本分支·轻量版） | 只想管理 AutoClaw 账号 + 反代到 ZCode | 多账号切换、活动领取、AutoClaw 反代（6 模型） |
> | **[`main`](../../tree/main)**（All-in-One） | 想一处管理多个平台的免费额度 | 七平台积分池：AutoClaw / WorkBuddy / 豆包 / Comate / Qoder / 千问办公 / Trae |

# A-SWITCH

[中文](README.md) | [English](README.en.md)

**下载exe**：[Releases · A-SWITCH.exe](../../releases/latest) （无需装 Python）

> **★ 2.x 适配说明（2026-10）**：本分支在 A-SWITCH 之上完成了对 **AutoClaw 2.0.1（官方渠道）** 的完整适配——新版凭证桥接、加速网关新契约（OpenAI SDK 指纹头 / 会话头 / persona system / 原生 https 传输）、凭证自动同步器与 Electron 管理控制台，端到端实测通过。详见下文 [「2.x 适配」](#autoclaw-2x-适配201官方渠道) 章节。不使用 2.x 的用户可跳过该章节，1.x 流程不受影响。

AutoClaw 的多账号管理工具，附带一个本地反代，能把 AutoClaw 账号的积分变成 ZCode 里可以直接选用的模型。

做了四件事：

1. **多账号**。一个窗口里加号、切号、看余额、批量签到领积分。AutoClaw 桌面端本身一次只能登一个号。
2. **防封**。上游风控看的是推理流水的形态：一个号如果全是 1-token 的探针调用、或者被并发打到每分钟几百次，就会封。所以这里有暖号（给新号跑真实对话建立用量基线）、限速（单号 12 次/分）、并发闸（整池同时在途 ≤4）、日预算（每号 6000 次/天，本地计数）。这些参数不是拍脑袋，是拿封掉的号的真实流水对出来的，别随便改大。
3. **反代**。点一下按钮，把 AutoClaw 注册成 ZCode 的一个模型供应商。之后 ZCode 里就能直接选 GLM-5.3 / DeepSeek-V4.1-Flash 这些模型，消耗的是 AutoClaw 账号的积分。
4. **2.x 适配**（新增）。AutoClaw 2.0.1 官方渠道改用了新的凭证存储、加速网关和风控闸门，本分支做了完整逆向适配：凭证自动桥接与轮换跟随、OpenAI SDK 指纹与会话头注入、persona system 替换、原生 https 传输层，并新增 Electron 桌面控制台管理全部运行状态。

## 国际端注册

AutoClaw 的国际端支持邮箱注册（国内端只有手机号）。新号送 10000 积分，分 7 天到账。注册入口在 AutoClaw 官方客户端的登录页，或者网页端。多注册几个号轮着用，比单号扛得住。

## 2.x 适配（2.0.1 官方渠道）

> **★ 双线统一（2026-10）**：`relay/server.mjs` 现在是**国内/国际通用**的单进程反代——
> 同一端口（18766）、同一账号池按号选线：海外号（aswitch_cloud_pool.json，默认 lane）
> 走 `autoglm-api.autoglm.ai` + 2.0.2 契约（harness 标记闸门 + 每请求现刷票）；
> 国内号（`~/.autoclaw-relay/auth-compat/auth.json`，由 `bridge/watch_auth.py` 从 2.x
> 客户端解密跟随轮换）走 `autoglm-api.zhipuai.cn` + 官方渠道契约（persona system 整体
> 替换 + X-Session-Id/签名三件套 + node:https 传输）。挑号日志带 `(cn)`/`(oversea)` 标识，
> healthz 池子混编。想加国内号：装 2.x 客户端登录 → `python bridge/watch_auth.py` 常驻，完事。

### 2.x 改了什么

AutoClaw 2.x 相比 1.17.8 有五处结构性变化，每一处都会让旧版反代直接失效：

1. **凭证换载体**：登录态从 `%APPDATA%\autoclaw\auth.json` 改为 `%APPDATA%\AutoClaw-official\accounts\<hash>\account-credentials.enc`（裸 v10 + AES-256-GCM，密钥在 Local State 的 os_crypt.encrypted_key 里，DPAPI 保护）。
2. **推理网关换域名**：模型推理走 `autoglm-acceleration-api.zhipuai.cn`（加速域名）；账号/积分等 identity 接口仍在 `autoglm-api.zhipuai.cn`。两者不互通：CN 账号的 token 打海外网关直接 401。
3. **请求头加签**：模型请求需携带 `X-Auth-Sign`（md5(appId&ts&appKey)，appId=100003）、`X-Channel: official`、`X-Session-Id`，且 token 走 `X-Authorization`（标准 `Authorization` 头会被 401）。
4. **请求体契约变化**：`body.model` 保留带前缀目录名（zaicoding_glm-5.3）；输出字段改用 `max_completion_tokens`（307200 满额）+ `store:false` + `reasoning_effort:"high"`；1.x 的 harness 标记机制已不存在。
5. **WAF 形状校验**：加速网关在鉴权前校验请求必须是"真机 OpenAI SDK"形状——需要 `user-agent: OpenAI/JS 6.26.0` + 全套 `x-stainless-*` + `x-agent-id: main` 头，且传输层不能是 undici fetch 的指纹。

### 本仓库的适配实现

| 组件 | 作用 |
|---|---|
| `../bridge/make_compat_auth.py` | 凭证桥接：DPAPI 解密 2.x 凭证 → 合成旧版 auth.json，让本仓库的账号链路直接可用 |
| `../bridge/watch_auth.py` | 凭证自动同步器（后台常驻）：监听凭证文件变化（应用轮换 token 即重写），自动解密并同步给反代。纯文件监听，零出站 |
| `../bridge/server_2x.mjs` | ★ 打好全部补丁的 2.x 反代（部署到 `~/.autoclaw-relay/server.mjs` 使用） |
| `../bridge/persona.txt` | 应用 persona system prompt（闸门要求 system 与之完全一致） |
| `../bridge/patch_relay_2x.py` | 签名头/渠道/会话头的增量补丁（权威版为 server_2x.mjs） |
| `../bridge/fetch_hook.cjs` | 应用请求抓包钩子（逆向辅助，注入 main.cjs 用完即还原） |
| `../app/` | Electron 桌面控制台：管理反代、同步器、积分、ZCode 注册与日志 |

### 2.x 网关 406 闸门的判定条件（逆向结论）

加速网关在**鉴权之前**校验请求形状，以下五要素缺一即 406 空响应体（全部经同分钟 A/B 对照实验证实）：

1. 传输层为干净的 HTTP/1.1 指纹——undici fetch（自动附加 `sec-fetch-mode`/`accept-language`/`accept-encoding`，TLS ClientHello 亦有差异）被拦，`node:https` 原生请求稳定通过；
2. 携带完整 OpenAI SDK 指纹头（`user-agent: OpenAI/JS 6.26.0` + `x-stainless-*` + `x-agent-id: main`）；
3. 携带 `X-Session-Id` 会话头；
4. system 消息与应用 persona **完全一致**（3099 字节 "You are AutoClaw. ..."，合并任何额外内容都会被拒；完全没有 system 同样被拒）；
5. 请求体参数：`body.model` 带前缀目录名、`max_completion_tokens` 模型满额、`reasoning_effort:"high"`、`store:false`。

曾被证伪的假说：时间窗 / IP 风控冷却 / 边缘节点轮换 / TLS 栈差异 / 头顺序 / temperature / 工具数量与名称 / 合成文本填充。完整实验记录见 [../TEST_REPORT.md](../TEST_REPORT.md)。

## 安装

两种方式。

**方式一：直接跑源码**

```
pip install pywebview cryptography
python a_switch_app.py
```

需要 Windows（DPAPI 解密 token 用了 Windows API）。Python 3.10+。

**方式二：打包 exe**

```
pip install pyinstaller
pyinstaller A-SWITCH.spec --noconfirm
```

产物在 `dist/A-SWITCH.exe`。

**2.x 用户额外一步**：部署适配版反代与凭证桥接（在仓库根目录执行）：

```
python bridge/make_compat_auth.py        # 解密 2.x 凭证 → auth-compat/
python bridge/watch_auth.py &            # 凭证自动同步器（常驻，跟随应用轮换 token）
cp bridge/server_2x.mjs ~/.autoclaw-relay/server.mjs
cp bridge/persona.txt   ~/.autoclaw-relay/persona.txt
```

## 使用

前提：本机装了 AutoClaw 并登录过至少一个号（工具靠读它的登录态拿凭证）。2.x 官方渠道用户的登录态在 `%APPDATA%\AutoClaw-official\`，由 make_compat_auth.py / watch_auth.py 自动桥接，无需额外操作。

**加号**：GUI 里「桌面端登录添加」会弹官方登录窗口，登录后自动入库。注意加号前先完全退出 AutoClaw 主程序（含托盘），否则登录态会被主实例截走。

**一键反代**：点「⚡ 一键反代」。它会依次：部署本地反代（`~/.autoclaw-relay/`）→ 把 AutoClaw 注册进 ZCode 的供应商列表 → 发一发验证请求。完成后**重启 ZCode**，模型列表里就有 AutoClaw 了。2.x 用户请改用桌面控制台（`app/`）完成同样的操作，它额外处理了新版契约。

**暖号**：新注册的号建议点一次「🔥 暖号」。它会用真实的技术问题跟模型聊 8 轮，把流水刷成正常人的形状。跳过这步的号用不了几天。

**验证反代**：

```
curl http://127.0.0.1:18766/health          # {"status":"ok","upstream":"cloud"}
curl -X POST http://127.0.0.1:18766/v1/messages \
  -H "Content-Type: application/json" -H "x-api-key: autoclaw-local" \
  -d '{"model":"GLM-5.3-Flash","max_tokens":50,"messages":[{"role":"user","content":"reply OK"}]}'
```

## 反代的工作方式

`relay/server.mjs` 是一个纯本地的 node 服务，监听 `127.0.0.1:18766`，把 ZCode 发来的 Anthropic/OpenAI 格式请求翻译成 AutoClaw 云端的格式。翻译中最关键的一点：请求的 system 提示词必须以官方 harness 标记开头，否则网关回 406 空响应。这个标记反代会自动补，你不用管。

多账号时反代按积分余额和空闲度选号，一个号的积分打空自动换下一个。所有请求都走本机，凭证不离开你的电脑。

反代的凭证有两个来源：多号用户由 A-SWITCH 的账号池导出（`~/.openclaw-autoclaw/aswitch_cloud_pool.json`）；只有单号的用户它会直接读当前登录态。

**2.x 官方渠道的差异**：加速网关的闸门不再校验 harness 标记，改为校验 system 消息必须与应用 persona 完全一致（见上文五要素）。反代会自动把 persona 整体替换为 system，并把调用方（ZCode）原有的 system 指令挪到首条 user 消息里作上下文——模型仍然看得到 ZCode 的全部指令。传输层从 undici fetch 换成 `node:https` 原生请求（保留流式、超时与中断语义），以通过 WAF 的客户端指纹校验。

## 桌面控制台（2.x 新增）

`app/` 目录是一个 Electron 管理面板，把上述所有状态可视化：

- **Relay 卡片**：运行状态 / 上游通道 / 运行时长 / 模型别名；启动、停止、连通性测试（真实推理）
- **账号卡片**：积分余额与即将过期（CN 网关按需查询）、token 剩余有效期、凭证同步器状态与启停
- **ZCode 卡片**：注册状态 / 接入地址 / 模型清单 / 一键重新注册（自动修正为 2.x 模型目录）
- **日志查看器**：反代 / 同步器 / 控制台三标签，自动刷新

关闭窗口不会停止后台服务（反代与同步器是 detached 常驻进程）。启动：`cd app && npx electron .`；内置自测：`ASWITCH_SELFTEST=1 npx electron .`（10 项功能自检）。

## 已知问题

- 上游对非浏览器 TLS 指纹有间歇性拦截。python/curl 的直连请求可能被掐断，node 基本能过。2.x 已把云通道传输层整体换成本地 node https 出站，正常使用无感；仍偶发 RST 时等待重试即可。
- **GLM-5.3-Flash 白天高峰限流**（810001「系统繁忙」）：应用内公告明确夜间 23:00-09:00 畅通；反代已把 810001 纳入自动退避重试，白天建议改用 GLM-5.3 或 Auto 路由。
- **402「积分不足」为终态错误**：按模型分账（GLM-5.3 与 Flash 的免费额度分开计算），耗尽后等每日赠送（每日登录 1000 分）或充值，反代不会重试。
- 模型的"视觉能力"是按路由实测配置的：GLM-5.3-Flash、DeepSeek-V4.1-Flash、Auto 系列可以看图；GLM-5.3（coding 版）和 DeepSeek-V4-Pro 不行，发图它会说看不见。
- `DeepSeek-V4.1-Flash` 这个名字是 AutoClaw 1.x 自己的叫法（上游实际回 `deepseek-v4-flash-202605`）。2.x 官方渠道的模型目录只有 4 个：GLM-5.3 / GLM-5.3-Flash / Auto / Auto-Fast，反代与 ZCode 注册已同步修正。
- 应用轮换 access token 后旧 token 即失效。凭证同步器会在应用重写凭证文件时自动跟进；若反代报 401，重新打开 AutoClaw 登录一次再同步凭证即可。

## 免责声明

本项目通过逆向 AutoClaw 客户端实现了对非官方接口的调用，仅供学习研究。使用本项目导致的账号封禁、积分损失由使用者自行承担。请勿用于商业用途。AutoClaw 是智谱/Z.ai 的产品，本项目与其无关。

## 目录

```
autoclaw-to-zcode/                 ← 工作区根目录
├── autoclaw-switch/               ← 本仓库（上游 A-SWITCH，账号管理与 1.x 反代核心）
│   ├── a_switch.py                后端：账号管理、签到、DPAPI 解密、一键反代、暖号
│   ├── a_switch_app.py            GUI（pywebview + 内嵌 HTML）
│   ├── relay/server.mjs           本地反代（上游 1.x 版；2.x 请用 ../bridge/server_2x.mjs 部署）
│   ├── relay/warm/                暖号脚本
│   ├── A-SWITCH.spec              PyInstaller 打包配置
│   └── PROMPT_FOR_ZCODE.md        不想手动操作的话，把这份提示词发给 ZCode 让它自己装
├── bridge/                        ← [2.x 新增] 适配层与工具
│   ├── make_compat_auth.py        凭证桥接（DPAPI 解密 → auth.json）
│   ├── watch_auth.py              凭证自动同步器（常驻）
│   ├── patch_relay_2x.py          relay 增量补丁（签名头/渠道/会话头）
│   ├── server_2x.mjs              ★ 2.x 权威反代（全部补丁就绪）
│   ├── persona.txt                ★ 应用 persona system prompt
│   ├── fetch_hook.cjs             应用请求抓包钩子（逆向辅助）
│   └── test_*.mjs / probe_*.mjs   实验、验证与二分脚本
├── app/                           ← [2.x 新增] Electron 管理控制台
│   ├── main.js / preload.js       生命周期管理 + IPC（含 ASWITCH_SELFTEST 自测模式）
│   └── renderer/                  状态面板 UI
└── TEST_REPORT.md                 完整测试报告（根因分析、实验记录、证据链）
```

运行时数据（自动生成）：`~/.autoclaw-relay/`（部署的反代、persona.txt、日志、dumps）、`~/.openclaw-autoclaw/`（凭证源）、`~/.zcode/v2/provider_config.json`（ZCode 供应商注册，备份为 .bak-autoclaw）。
