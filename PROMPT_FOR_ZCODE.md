# 把下面整段发给 ZCode，让它替你完成 AutoClaw 反代的部署

> 用法：克隆本仓库到本地后，打开 ZCode，工作目录切到仓库目录，把下面分割线以内的全部内容原样发给 ZCode。
> 适用前提：Windows、本机装好并登录过 AutoClaw、装好 ZCode（跑过至少一次）。

---

你是运行在 Windows 上的编码代理。请在本仓库（当前工作目录）里完成"AutoClaw → ZCode 反代"的部署。仓库里的代码都是现成的，你的任务是把它正确跑起来并接进 ZCode，**不要自己重写反代逻辑，不要改 relay/server.mjs 的风控参数**。

## 背景（30 秒读完）

AutoClaw 桌面端的积分只能在官方客户端里用。本仓库的 `relay/server.mjs` 是一个本地反代（纯 node、零依赖），监听 `127.0.0.1:18766`，把 Anthropic/OpenAI 格式的请求翻译成 AutoClaw 云端格式，ZCode 以 anthropic-messages 供应商的方式接入它。多账号时反代按积分余额轮换选号。

三个一定要知道的坑（已经全部在代码里处理好了，但你要明白为什么）：

1. **请求的 system 提示词必须以 `OpenClaw plugin-injected system context.` 开头**，否则网关回 406 空响应。反代会自动补，别去掉。
2. **绝不做固定节奏的出站请求**（定时探针、定期 model-config 轮询都算）。历史教训：一个每 30 秒一次的 401 轮询，两天就把一个新号打成了机器指纹被 410004 终态封禁。relay 里这类轮询已默认关闭（环境变量 `AUTOCLAW_FETCH_MODELS=1` 才开），保持关闭。
3. **新号必须先暖号**：上游看推理流水形态，全是 1-token 探针的号会被判机器号。`relay/warm/warm_account.mjs` 用真实技术话题跑 8 轮对话建立"真人形"基线。

## 部署步骤

### 第 0 步：前置检查

逐项确认，缺什么先补什么：

- `python --version` ≥ 3.10，且 `pip install cryptography pywebview` 成功（cryptography 解密 token 用，pywebview 只有跑 GUI 才需要）。
- node：优先找 `D:\AutoClaw\resources\node\node.exe`（AutoClaw 自带），其次 `where node.exe`。
- AutoClaw 登录态存在：`%APPDATA%\autoclaw\auth.json` 或 `%LOCALAPPDATA%\AutoClaw\...` 下的 auth.json（Chromium os_crypt 加密，DPAPI + AES-256-GCM）。仓库 `a_switch.py` 里有现成的 `discover_accounts()` / `load_account()` 能解密它，直接用，不要自己写解密。
- ZCode 配置存在：`%USERPROFILE%\.zcode\v2\provider_config.json`。

### 第 1 步：验证能拿到 token

```python
python -c "
import sys; sys.argv=['x']
import importlib.util
spec=importlib.util.spec_from_file_location('a','a_switch.py')
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
for a in m.discover_accounts():
    print(a.nickname, str(a.user_id)[:8], 'is_live=', a.is_live, 'token_len=', len(a.token or ''))
"
```

能打印出账号和 token 长度就继续。如果报错，先修环境（缺 cryptography 之类），不要绕过。

### 第 2 步：一键部署（仓库已内置，直接调）

```python
python -c "
import sys, json; sys.argv=['x']
import importlib.util
spec=importlib.util.spec_from_file_location('a','a_switch.py')
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
r=m.relay_oneclick_setup()
print(json.dumps(r, ensure_ascii=False, indent=1))
"
```

这个函数会依次：启动 relay（若未在跑）→ 把 AutoClaw 注册进 ZCode 供应商列表（三处配置同写，幂等）→ 把账号池导出给 relay → 发一发真实推理验证。`ok: true` 且 steps 里有"验证推理通过"才算成功。

### 第 3 步：验收

- `curl http://127.0.0.1:18766/health` → `"status":"ok"`。
- 发一发真实请求（注意 `x-api-key: autoclaw-local` 这个固定值）：

```bash
curl -X POST http://127.0.0.1:18766/v1/messages -H "Content-Type: application/json" -H "x-api-key: autoclaw-local" -H "anthropic-version: 2023-06-01" -d "{\"model\":\"GLM-5.3-Flash\",\"max_tokens\":32,\"messages\":[{\"role\":\"user\",\"content\":\"reply READY\"}]}"
```

返回 200 且 content 里有内容即完成。告诉用户：**重启 ZCode**，模型列表里会出现 AutoClaw 供应商（GLM-5.3 / DeepSeek-V4.1-Flash / GLM-5.3-Flash / DeepSeek-V4-Pro / Auto / Auto-Fast）。

### 第 4 步（可选但强烈建议）：新号暖号

如果账号是新注册的（推理流水基本为空），跑：

```bash
python -c "
import sys; sys.argv=['x']
import importlib.util
spec=importlib.util.spec_from_file_location('a','a_switch.py')
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
print(m.warm_unwarmed_accounts(8))
"
```

跑完看输出的 RATIO，≥50% 即达标（10 分钟左右，别中断）。

## 故障对照表

| 现象 | 原因 | 处理 |
|---|---|---|
| 推理回 406 空 body | system 缺 harness 标记，或请求带了 `X-Harness-Type` 头 | 检查是否绕过了 relay 直连上游；relay 会自动补标记 |
| 401 Invalid token | 登录态过期/被轮换 | 让用户重新打开 AutoClaw 登录一次，重跑第 2 步 |
| 429 | 触发了限速闸（12 次/分/号）或并发闸（4 路） | 正常保护，稍后重试；**不要调大参数** |
| 403 code=810002 pay-view | 瞬时限流，等 20-60 秒自愈；持续出现说明该号积分耗尽 | 换号或等每日刷新 |
| 400 code=810000 free quota used up | 该号该模型的免费额度用完（按模型分账） | 换模型或等明天 |
| 403 code=410004 | 账号终态封禁，无解封 | 从池子里去掉该号，别再撞 |
| python 请求 SSL EOF / WinError 10054 | 上游对非 node TLS 指纹间歇性 RST | 走 node（relay/桥）出站；GUI 已内置回退 |
| ZCode 里"显示但不可用" | ZCode 的 providerOrder 没写 | 重跑第 2 步（三处配置是幂等全写的） |

## 红线（做了会封号，ZCode 你也不要做）

1. 不写任何定时器去周期性请求 AutoClaw 的任何端点（包括看似无害的查询）。
2. 不把 relay 的限速/并发/日预算参数调大。
3. 不对同一账号并发开多路长请求。
4. 不绕过 relay 直连云端发裸请求（缺 harness 标记必 406，还留下异常指纹）。
5. 新号不暖号就高频使用。

完成后汇报：部署路径、ZCode 供应商注册结果、验证推理的返回、以及是否需要用户重启 ZCode。
