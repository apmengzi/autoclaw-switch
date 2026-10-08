# A·SWITCH

> **📦 两个版本，按需取用**
>
> | 分支 | 适合谁 | 内容 |
> |---|---|---|
> | **[`lite`](../../tree/lite)**（轻量版） | 只想管理 AutoClaw 账号 + 反代到 ZCode | 多账号切换、活动领取、AutoClaw 反代（6 模型） |
> | **[`main`](../../tree/main)**（All-in-One） | 想一处管理多个平台的免费额度 | 七平台积分池：AutoClaw / WorkBuddy / 豆包 / Comate / Qoder / 千问办公 / Trae |
>
> 下载：到 [Releases](../../releases/latest) 取 exe，或切到对应分支自行打包。

# A-SWITCH · All-in-One 反代平台

[中文](README.md) · [English](README.en.md) · [1.x 单账号工具发布页](../../releases/latest)

**这个项目做一件事：把七个 AI 客户端/平台的内置额度，变成你本地 IDE 里可以直接选用的模型。**

| 平台 | 额度来源 | 接入方式 | 网关对外 | 上游协议形态† | 端口 | 模型数* | 工具调用 |
|---|---|---|---|---|---|---|---|
| **AutoClaw**（智谱 Z.ai） | 账号积分，支持多号池 | 桥接客户端登录态 → 自建 relay | anthropic + openai + responses | **原生 chat completions**（persona 闸门） | 18766 | 4 | ✅ 结构化 |
| **WorkBuddy**（腾讯 CodeBuddy） | Free 档每月 100 + 每日 30 积分 | 本地 Go 网关（wb2api） | openai | **原生 chat completions**（body 原样透传） | 7863 | 46 | ✅ 结构化 |
| **Trae SOLO CN**（字节） | 免费会话额度 | 离线解密客户端凭证 → 驱动其远端 agent 会话 | openai + anthropic | agent 会话协议（历史拍平成文本） | 18768 | 28 | ❌ 仅文本 |
| **豆包工作**（字节 DoubaoWork） | 客户端内置额度 | CDP 取登录 cookie → 直连 `/chat/completion` | openai + anthropic | 网页 IM 协议（历史拍平成文本） | 18770 | 2（合成） | ❌ 仅文本 |
| **Comate 文心快码**（百度） | Comate IDE 内置额度 | 读 settings.json 里的 license → 驱动其云端 agent 三步链 | openai + anthropic | agent 三步链（`/v2/execute` SSE 真流式；历史拍平、**工具走 `toolUseResults` 同会话续跑**） | 18774 | 15 | ✅ 会话续跑‡ |
| **Qoder CN**（阿里） | 客户端内置额度（Free 档 Qwen3.8 系可用） | vendored 社区网关（COSY 签名）+ 本机凭证入池 | openai + responses | COSY 信封 agent SSE（历史拍平、**工具真列表**） | 8791 | 14 | ✅ 透传 |
| **千问办公**（QoderWork CN） | 同 Qoder 平台，独立网关 | 同 COSY 体系，多一处形态声明（见千问办公一节） | openai + responses | 同上（qwork 场景 + 工作台形态声明） | 8791 | 3 | ✅ 透传 |

\* 模型目录随账号动态拉取，表中为 2026-10 本机实测值；AutoClaw 的 4 个是本机账号当前目录（两条 `tdpsk_deepseek-*` 被上游移除，见[供应商注册一节](#zcode-供应商注册写入安全边界重要)）。豆包的目录在服务端且不可枚举，网关只能给出两个合成条目。Trae 上游同一模型的大小写两条（如 `DeepSeek-V4-Flash` 仅 solo_coder 组）已并入小写规范名条目，快照见 `models-catalog.json`。
† 这是**上游**真实说话的方式，与"网关对外暴露什么"是两回事——七条链路的入口全都是 chat completions，但只有前两家上游本身就是 chat completions。逐家证据与对使用体感的影响见[上游协议保真度](#上游协议保真度谁是真的-chat-completions)。
‡ Comate 的"会话续跑"是指工具循环：上游 agent 发起的调用（`Write`/`Read`/`Bash`…）翻译成调用方协议里的工具调用，执行结果经 `toolUseResults` 在**同一个 conversation+task** 上续跑交付。工具集是上游 agent 自己的，不是调用方声明的——调用方需要有同名（或 canonical 同名）的工具才能执行，详见 [Comate 一节](#comate-文心快码settingsjson-里的-license--云端-agent-三步链)。

所有组件都跑在 `127.0.0.1`，凭证不离开你的电脑；七个平台在 ZCode 里是并列供应商（`autoclaw-glm-provider` / `workbuddy-openai-provider` / `trae-openai-provider` / `doubao-openai-provider` / `comate-openai-provider` / `qoder-openai-provider` / `qwenwork-openai-provider`），模型名不冲突，同一个会话里可以自由切换。模型名已按[统一命名规范](#模型统一命名规范modelscatalogjson)规范化（全小写、无上游 hash 与路由前缀），各链路同时兼容旧名。

Qoder CN 与千问办公共用 `8791` 这**一个**网关进程（同一份账号池、同一套 COSY 签名），ZCode 侧靠**绑定出口的 API Key** 分成两个并列供应商（ZCode 的供应商配置没有自定义请求头字段，绑 Key 是官方设计的出口选择方式）：控制台注册时会自己生成两把 Key 写进网关并**保持入站鉴权开启**（`/v1` 全部路径要带 Key，`/health` 等探针豁免），Key 兼具"出口选择 + 入站钥匙"双重身份。

## 这是什么 / 不是什么

七个上游都是**消费级 agent 客户端**，不是模型厂商的公开 API。它们各自把自家积分/免费额度消耗在官方客户端里，本项目的反代让 ZCode 之类的标准 IDE 也能吃到这些额度。

- **是**：本地协议翻译层。ZCode 发标准 anthropic/openai 请求 → 网关翻译成各上游的真实协议 → 流式回填。
- **不是**：官方接口。七条链路全部来自对客户端的逆向（凭证存储格式、网关域名、请求头签名、WAF 闸门、会话协议）。上游一旦改版，接入层就要跟着逆向更新——2.x 适配、Trae 的 functions 目录参数、豆包的 SSE 事件语法、千问办公的场景声明都是这么来的。
- **代价**：非官方调用有封号风险（AutoClaw 尤其看推理流水的"形状"，见防封一节）；额度计费按各平台自己的规则走。

## 上游协议保真度：谁是真的 chat completions

判断一条链路"是不是 chat completions 通信"，看**网关入口**会得出"七家都是"的错误结论（七条链路的入口全都提供 `POST /v1/chat/completions`），必须看它**往上游发的是什么**。按保真度分三档：

**A 档 · 上游原生 chat completions（`messages`/`tools` 结构化保真，工具闭环成立）**

| 平台 | 上游端点 | 报文 |
|---|---|---|
| WorkBuddy | `POST copilot.tencent.com/v2/chat/completions` | 客户端 body **原样透传**，只重写 model 名（前缀是网关侧路由协议，上游只认裸名）。`messages`、`tools`、`tool_calls`、推理字段全部保真——这是它当主力 agent 池体感最好的根本原因 |
| AutoClaw | `POST autoglm-api.zhipuai.cn/autoclaw-proxy/proxy/autoclaw/chat/completions` | OpenAI 形状直接发（`messages` + `max_completion_tokens` + `stream_options.include_usage` + `store:false` + `reasoning_effort:high`）。Anthropic 入口先经 `anthropicToOpenai()` 转换，其中工具声明由 `anthropicToolsToOpenai()` 转成 OpenAI 格式挂到 `out.tools` 再转发；另有 Responses 入口，`responsesToolsToChat()` 同样转成 chat 形状。**协议上它与 WorkBuddy 同级，当前不可用是账号积分问题（402），不是协议问题** |

**B 档 · 自定义协议里带真工具语义（翻译得出工具调用，但历史要拍平）**

- **Qoder CN / 千问办公**：上行 body 是官方 `baseprompt.json` 的深拷贝，里面**确实有 `messages` 数组**——但那是 `[{role:"system"}, ...拍平后的历史]`，`flatten_messages()` 会把 assistant 历史里的 `tool_calls` 序列化成文本标记。唯一"真结构化"的是工具声明：客户端给的 `tools` 被原样塞进信封（`body["tools"] = tools`），上游按自己的工具语义解析并回 `finish_reason:tool_calls`。所以它是**"工具真透传、历史假 messages"的混合体**。
- **Comate**：调用方的 `tools` 不转发（`execute-sync` 只有一个文本 `query` 字段），但工具**下行**带真语义：`FUNCTION_CALL_START/_PARAMS_APPEND/_END` 帧里挂着 `toolUse:[{id,name,input}]`，参数按 key 逐片累加（`appendParamContent` 的字符串拼接语义）；执行结果回程走的是上游自己的 `toolUseResults` 字段，在**同一个 conversation+task** 上用 `query:""`、`isFirstQuery:false` 续跑（即 IDE 内核的做法）。所以它是"**工具闭环，但工具集是上游 agent 自己的**"——帧里的名字（`Write`/`Read`/`Bash`，Claude 词汇）按 `V10_TOOL_ALIASES` 映射回调用方声明的工具名，调用方没声明就执行不了。
- **Trae**：连工具都没有容身之处——`initial_message.query` 是 `JSON.stringify(prompt(text))`，协议里既没有接收 `tools` 的字段，也没有回传工具调用的通道。不是"我们没转"，是"没地方放"。

**C 档 · 网页/产品对话接口（只能模拟）**

- **豆包工作**：走网页端 `POST www.doubao.com/chat/completion` 的 SSE，消息体是编辑器块结构（`messages[0].content_block[0].content.text_block.text`），与 chat completions 的距离最远。

**这件事的实际影响**：按"能不能进 agent 工具循环"排，**WorkBuddy ≈ AutoClaw（结构保真、工具闭环）> Comate ≈ Qoder CN ≈ 千问办公（工具都能闭环，短板互补：Comate 的循环是原生续跑、但工具集是上游 agent 自己的；Qoder/千问办公的调用方工具是真透传、但历史每轮重拍，同一个工具反复触发的多轮往返保真度明显低于前两家）> Trae（自带 agent 替你干活，看不到调用方的工具）> 豆包（纯聊天额度）**。现象上，文本拍平的链路容易"第一轮很准、后面开始跑偏"，根因就在这里。

## 快速开始

```
git clone <本仓库> && cd <本仓库>/app     # 仓库根就是运行时资源根，别只拷 app/ 一个目录
npm install                              # 只装 electron 一个依赖（npmmirror 源即可）
npm start
```

打开控制台后**就三步**：

1. **环境体检**：顶栏按钮，只读探测，缺什么会逐项告诉你影响和补法；
2. **一键启动全部**：按依赖顺序拉起各家网关与凭证同步器（Qoder CN 与千问办公共用一个进程）。**启动哪个平台，ZCode 里就自动出现哪个供应商**（见[动态增删](#zcode-供应商的动态增删)）；
3. **一键注册**：手动全量刷新七家的模型目录（平时不需要——启停时已自动同步）。

然后**重启 ZCode**，模型列表里就能看到开启中的平台模型了。

冷启动加固已做：反代的运行时文件由控制台自动准备，不需要手工 cp——`server.mjs` 缺失或内容不同都从 `bridge/` 重新部署；**persona 不随仓库分发**（厂商文本，PR#4 审查意见），由 `bridge/extract_persona.py` 从已安装的 AutoClaw 客户端提取到 `~/.autoclaw-relay/persona.txt`，客户端升级后自动跟进，提取失败才退回随包种子。

### 前置条件

| 依赖 | 用途 | 缺了会怎样 |
|------|---|---|
| Node.js 18+ | 启动 AutoClaw 反代、Trae 网关、豆包网关、Comate 网关 | 对应「启动」按钮报「relay 需要 Node.js 在 PATH 中」；exe 版自带兜底运行时（PATH → AutoClaw 自带 node → 控制台自身） |
| Python 3.10+ 且 `pip install cryptography` | 一键注册 / 余额查询 / 凭证同步（加载 `a_switch.py`，仓库根或 `autoclaw-switch/` 下均可） | 按钮报「未找到可执行文件：python」；缺 cryptography 时同步器 spawn 成功但立刻崩，症状是「点了没反应」 |
| Python 3.9+（纯标准库，无需 cryptography） | 启动 Qoder CN / 千问办公网关（`qoder/qoder_proxy.py`） | Qoder 卡片报「未找到 qoder/qoder_proxy.py」或启动即崩；与上一行用的是同一个 `python` |
| AutoClaw 桌面端已登录 | 反代的凭证来源（2.x 走 `%APPDATA%\AutoClaw-official\`） | 反代能起但没有上游可用 |
| ZCode 已安装并运行过一次 | 「一键注册」的落点 `~/.zcode/v2/provider_config.json` | 提示先装 ZCode 再来注册 |
| Trae SOLO CN 已登录 | Trae 网关凭证（离线解密其登录态） | Trae 卡片显示未启动 |
| 豆包工作已登录 | 豆包网关凭证（CDP 取 cookie。首次需点一次「重启客户端并同步」，之后可只点「同步登录态」） | 卡片显示 cookie 缺失，启动后请求 401 |
| Comate（文心快码）IDE 已登录 | Comate 网关凭证（读 `%APPDATA%\Comate\User\settings.json` 里的 `baidu.comate.license`，重新登录后无需重启 relay） | Comate 卡片显示未启动 / 请求 401 |
| Qoder CN 桌面端已登录 | Qoder CN 出口的凭证来源（`%APPDATA%\com.qodercn.app.stable\auth.v1.dat`），控制台「同步账号」入池 | 该出口报 `no usable account for realm` |
| 千问办公（QwenWorkCN）已登录 | 千问办公出口的凭证来源（`%APPDATA%\QwenWorkCN\auth-v2.dat`），同一次「同步账号」一并导入 | 千问办公出口取不到模型、请求 503 `Model catalog unavailable` |
| `wb2api.exe` | WorkBuddy 网关本体 | 卡片报缺文件；exe 与源码都不入库，随本项目 **Release** 分发（解压到 `workbuddy/workbuddy-manager-v1.0.79/upstream/`，见目录结构一节） |

## 桌面控制台（`app/`）

Electron 管理面板，**七张平台卡片 + ZCode 注册卡片 + 日志 + 顶栏**：

- **AutoClaw 平台卡片**：运行状态 / 上游通道 / 运行时长 / 模型别名；启动、停止、连通性测试（真实推理）
- **账号卡片**（同一行的第二块）：积分余额与即将过期（CN 网关按需查询）、token 剩余有效期、凭证同步器状态与启停
- **WorkBuddy 网关卡片**：网关状态 / 积分 / 账号 / 模型目录；启动、停止、连通性测试
- **Trae 平台卡片**：网关状态 / 账号 / 凭证到期 / 运行模式（无状态）/ 模型目录；启动、停止、连通性测试
- **豆包工作卡片**：网关状态 / cookie 健康度 / 固定会话（仅作传输通道）/ 运行模式（无状态）/ 模型目录；启动、停止、连通性测试、**同步登录态**、**重启客户端并同步**
- **Comate 文心快码卡片**：网关状态 / 登录态（license）/ 运行模式（无状态 + 工具循环：会话续跑，含路由表条数）/ 模型目录；启动、停止、连通性测试
- **Qoder CN 卡片**：网关状态 / 账号池（可用数）/ 出口（`cn`）/ 监听 / 模型目录（只列账号可用的）；启动、停止、连通性测试、**同步账号**
- **千问办公卡片**：与 Qoder CN **同一个网关进程的另一个出口**（卡片上标 `出口 qworkcn (qwenwork.cn)` 与共用端口）；模型目录只显示 `qwork` 场景里那三个；同样的四个按钮（启停/连通性测试/同步账号）
- **ZCode 供应商注册卡片**：注册状态（含最近一次动态同步的增删结果）/ 七家接入地址与模型数 / 模型清单 / 一键注册（全量刷新模型目录）/ **配置体检**（只读检查 `provider_config.json` 的枚举与必需字段）
- **日志查看器**：`relay` / 同步器 / WorkBuddy / Trae / 豆包工作 / Comate / Qoder / 控制台**八个页签**，自动刷新
- **顶栏**：**一键启动全部**（按依赖顺序拉起各家网关与同步器，某项缺前置只影响它自己，失败时自动把体检结果摆出来）与**环境体检**

环境体检逐项探测：Node 运行时、Python、`cryptography`、七家的网关源码与运行时文件、A-SWITCH 后端（`a_switch.py`，一键注册/余额/凭证同步的加载对象）、七家的登录态（AutoClaw 凭证 / Trae storage.json / 豆包 cookie / Comate settings.json / Qoder `auth.v1.dat` / 千问 `auth-v2.dat`）、ZCode 配置，每项都带"缺了会怎样 + 怎么补"。

冷启动时如果服务都没起来，标题栏下方会直接提示点「一键启动全部」。关闭窗口不会停止后台服务（反代、网关与同步器是 detached 常驻进程）。

```
cd app && npm start                     # 启动（等价于 npx electron .）
ASWITCH_SELFTEST=1 npx electron .       # 27 项功能自检（七家连通性 + 七家注册 + Comate 工具循环能力 + 体检 + 闸门断言 + 日志 + relay 停复）
ASWITCH_SELFTEST=1 ASWITCH_SELFTEST_ONLY="zcode:register" npx electron .   # 只跑指定处理器
node app/test_zcode_config.js           # 配置写入闸门的沙箱回归测试（合成 fixture，19 条用例）
node test_model_catalog.mjs             # 模型命名一致性检查（离线 11 条；--live 连同在跑的网关一起验）
```

自测覆盖：`env:check` 体检、`status:query`、`points:refresh`、`credential:sync`、同步器启停、七家的 `*:smoke`（真实推理/真实响应，不是探活）、`comate:tool-loop`（读 `/health` 断言这版 relay 自报工具循环——不花额度就能认出"跑着旧代码的 relay"）、`all:start`、`zcode:register`（含逐家断言 `zcode:register:*`）、`zcode:realm-keys`（两把出口 Key 是否就位）、`zcode:register:未被闸门拦下`（写入真被接受）、`zcode:check`、`logs:tail`、`relay:stop/start`（失联与恢复）。结果落盘在 `~/.autoclaw-relay/selftest-result.txt`（含逐项通过与否），同目录的 `selftest-progress.txt` 是过程日志。**从 exe 跑全量自测时看不到 stdout**——Electron 是 GUI 子系统进程，重定向到文件也是空的，直接读那个 JSON 结果文件即可。

两个注意点：① 全量自测会重启 relay（`relay:stop/start` 两项就是在验这个），改单个按钮时用定向自测；定向自测必须同时给 `ASWITCH_SELFTEST=1` 和 `ASWITCH_SELFTEST_ONLY=...`，只给后者不触发。② 改完 `app/main.js` 或 `preload.js` 必须重启 electron 进程——运行中的窗口不会热更新，打包版还要重新打包重装。

## 各条链路各自的原理

**七条链路统一是「无状态」网关，语义对齐 AutoClaw 的 relay。** 网关不保存任何会话：每次请求都独立地去完成一次上游调用，历史由调用方（ZCode）在 `messages` 里全量带来，回答只取决于本次请求内容。AutoClaw 链路本来就长这样（`bridge/server_2x.mjs` 里没有任何会话/会话池代码）；Trae 链路每请求新建一个远端会话再把历史拍平进去，用完即弃；豆包链路没有"新建会话"这个接口，于是把固定会话当作**传输草稿纸**——每次请求都把完整历史拍平成一条消息发进去，不复用服务端上下文；Comate 链路复刻的是 IDE 内核到云端 agent 的三步链，新提问同样是每请求一次完整往返（唯一的例外是同一轮提问内的工具续跑，见下一节：它复用同一条 conversation+task，但跨提问不复用任何东西）；Qoder CN 与千问办公（同一个 COSY 网关的两个出口）把 `messages` 拍平成纯文本转录塞进信封的 `messages` 数组后走各自的 `agent_chat_generation` 流（工具声明相反，是真列表照发）。这样做的收益是行为可预测：同一份 `messages` 无论何时发、上一轮发生过什么，结果都一致，也不存在会话池串味/污染的可能；代价分两层——**协议层**的保真度损失（谁保真谁拍平见上一节），以及各自的**每轮固定开销**（Trae 每轮都要重付 agent system prompt、豆包每轮都要重发全量历史）。

### AutoClaw：凭证桥接 + 2.x 网关契约

AutoClaw 2.0.1 相比 1.17.8 有五处结构性变化，每一处都会让旧版反代直接失效，这也是本平台要维护一个 `bridge/` 适配层的原因：

1. **凭证换载体**：登录态从 `%APPDATA%\autoclaw\auth.json` 改为 `%APPDATA%\AutoClaw-official\accounts\<hash>\account-credentials.enc`（裸 v10 + AES-256-GCM，密钥在 Local State 的 os_crypt.encrypted_key 里，DPAPI 保护）。
2. **推理网关换域名**：模型推理走 `autoglm-acceleration-api.zhipuai.cn`（加速域名）；账号/积分等 identity 接口仍在 `autoglm-api.zhipuai.cn`，两者不互通。
3. **请求头加签**：模型请求需携带 `X-Auth-Sign`（md5(appId&ts&appKey)，appId=100003）、`X-Channel: official`、`X-Session-Id`，token 走 `X-Authorization`。
4. **请求体契约**：`body.model` 保留带前缀目录名（如 `zaicoding_glm-5.3`）；输出用 `max_completion_tokens`（307200 满额）+ `store:false` + `reasoning_effort:"high"`。
5. **WAF 形状校验**：加速网关在鉴权之前校验请求必须是"真机 OpenAI SDK"形状。

**406 闸门的判定条件（同分钟 A/B 对照实验证实的五要素，缺一即 406 空响应体）**：

1. 传输层为干净的 HTTP/1.1 指纹——undici fetch（自动附加 `sec-fetch-mode` 等头、TLS ClientHello 亦有差异）被拦，`node:https` 原生请求稳定通过；
2. 完整 OpenAI SDK 指纹头（`user-agent: OpenAI/JS 6.26.0` + `x-stainless-*` + `x-agent-id: main`）；
3. `X-Session-Id` 会话头；
4. system 消息与应用 persona **一致**（由 `extract_persona.py` 从客户端提取，随客户端版本走；实测闸门是标记指纹式校验——提取出的规范变体与历史捕获文本不同样可通过，但合并任何额外内容都会被拒，完全没有 system 同样被拒）；
5. 请求体参数同上第 4 条。

曾被证伪的假说：时间窗 / IP 风控冷却 / 边缘节点轮换 / TLS 栈差异 / 头顺序 / temperature / 工具数量与名称 / 合成文本填充。完整实验记录见 [../TEST_REPORT.md](../TEST_REPORT.md)。

反代自动把 persona 整体替换为 system，并把调用方（ZCode）原有的 system 指令挪到首条 user 消息里作上下文——模型仍然看得到全部指令。

> **★ 双线统一（2026-10）**：上游已把 2.x 适配并进 `relay/server.mjs`——**国内/国际通用**的单进程反代，同一端口（18766）、同一账号池按号选线：海外号（`aswitch_cloud_pool.json`，默认 lane）走 `autoglm-api.autoglm.ai` + 2.0.2 契约（harness 标记闸门 + 每请求现刷票）；国内号（`~/.autoclaw-relay/auth-compat/auth-cn.json`，由 `bridge/watch_auth.py` 从 2.x 客户端解密、跟随轮换自动刷新）走 `autoglm-api.zhipuai.cn` + 官方渠道契约（persona system 整体替换 + X-Session-Id/签名三件套 + `node:https` 传输）。挑号日志带 `(cn)`/`(oversea)` 标识，healthz 池子混编；想加国内号：装 2.x 客户端登录 → `python bridge/watch_auth.py` 常驻，完事。

**上游协议是原生 chat completions**（与 WorkBuddy 同级）：请求发到 `{CLOUD_BASE}/chat/completions`，body 就是 OpenAI 形状（`messages` + `max_completion_tokens` 307200 + `stream_options.include_usage` + `store:false` + `reasoning_effort:high`）。入口有三个协议都收：Anthropic `/v1/messages`（`anthropicToOpenai()` 转换，工具声明由 `anthropicToolsToOpenai()` 转成 OpenAI 格式一并转发）、OpenAI `/v1/chat/completions`（原样）、Responses `/v1/responses`（`responsesToolsToChat()` 转成 chat 形状再走同一条上游）。

| 组件 | 作用 |
|---|---|
| `relay/server.mjs` | ★ 上游主线的双线统一反代——`a_switch.py` 一键反代部署的就是它，双客户端凭证桥（auth-cn / auth-oversea）、410004 拉黑、2.0.2 网关修缮都落在它上面 |
| `bridge/server_2x.mjs` | PR#4 的 2.x 独立部署版反代（控制台「启动 AutoClaw」部署的是它），同样按账号 lane 走国内/国际两条线 |
| `bridge/make_compat_auth.py` | 凭证桥接：DPAPI 解密 2.x 凭证 → 合成旧版 auth.json |
| `bridge/watch_auth.py` | 凭证自动同步器（常驻，应用轮换 token 即自动跟进；按客户端安装源分写 `auth-compat/auth-cn.json` / `auth-oversea.json`） |
| `bridge/extract_persona.py` | 从已安装客户端提取应用 persona（闸门硬要求；厂商文本不入仓库，客户端升级自动跟进，离线测试 `test_extract_persona.py`） |

### WorkBuddy：本地 Go 网关

社区反代 workbuddy2api（Go，原仓库 github.com/Sliverkiss/workbuddy2api 已被作者删除），源码快照随本项目 Release 分发、**不入版本库**，解压后位于 `workbuddy/workbuddy-manager-v1.0.79/upstream/`（来源与打包说明见该目录的 `UPSTREAM-SRC.txt`）：

```
# 构建（Go 1.24，golang.google.cn 下载；GOPROXY 用 goproxy.cn）
cd workbuddy/workbuddy-manager-v1.0.79/upstream
go build -o wb2api.exe ./cmd/server
```

- 网关 `:7863`（api_key=wb-local-key，config.json），上游 copilot.tencent.com
- **上游是标准 chat completions，且几乎是零翻译**：出站路径是常量 `POST copilot.tencent.com/v2/chat/completions`，网关把客户端 body 整个读进来、只解析出 model 做裸名重写，其余原样转发——所以 `messages`、`tools`、`tool_calls`、推理字段全部结构化保真（这是七家里唯一一家"什么都不用拍平"的）
- 认证：CLI OAuth（`wb2api-login.exe url|poll --realm=cn`），浏览器 OAuth 1 分钟搞定；token 38 天
- **tools 透传已验证 ✓**（finish_reason:tool_calls）；自带账号池 / 熔断 / 签到保活调度，Redis 可选（默认 noop）
- **模型名必须小写或 `cn:` 前缀**（`GLM-5.3` 大写会失败）；共 46 个模型（glm / kimi / deepseek / minimax / hunyuan / cn:auto 等）
- 积分显示与免费额度是两套账（积分 0 也能出字）

### Trae SOLO CN：凭证离线解密 + 远端 agent 会话

Trae 与前两个平台结构不同：**客户端不直接调模型**，而是拿用户 token 在远端拉起 agent 沙箱会话，模型跑在字节的沙箱里（`agent-sandbox-bj-*.trae.cn`，`/workspace` 工作区）。所以网关不能翻译成"一次 chat completion"，要驱动它的一整套会话协议：

```
POST /api/remote/v1/chat_sessions               创建会话（env=local, mode=work, session_type=assistant_chat）
POST /api/remote/v1/chat_sessions/:id/messages  追加一轮
GET  /api/remote/v1/chat_sessions/:id/events    SSE：plan_item 增量 / token_usage / done
```

host 为 `https://trae-api-cn.mchost.guru`，鉴权头 `Authorization: Cloud-IDE-JWT <user token>`（外加 `X-Trae-Client-Type: lite` / `X-App-Id` / `X-User-Region: CN`），无需签名头。

**凭证是离线解出来的。** Trae 把登录态存在 `%APPDATA%\TRAE SOLO CN\User\globalStorage\storage.json` 的 `iCubeAuthInfo://icube.cloudide` 字段，加密模块是 `out/main.js` 里内嵌的 `byteCrypto`——纯 JS 实现、码表硬编码、没有原生绑定，因此可以**不改客户端、不重启 IDE** 直接把 token 解出来（`trae/decrypt_auth.py`，relay 内有等价实现）：

```
blob      = magic(6) + keymat(32) + AES-128-CBC(payload)
key/iv    = sha512( sha512(keymat) || (qoe XOR zoe) )[0:32] 拆成 16+16
plaintext = sha512(body)(64) || body        # PKCS7 填充，头部哈希用于完整性校验
```

只有这个 **user token** 能过鉴权；`GenerateTempToken` 签发的临时 JWT 打远程 API 一律 401。线上真实生效的 query 是 `[{"type":"text","data":{"content":...}}]`——服务端**回显/落库**时会规范化成 `text_content` 形态，照抄回显格式发出去，提示词会被静默丢弃。

**无状态转发（对齐 AutoClaw）。** 网关**不再维护会话池**：每个请求都 `POST /chat_sessions` 新建一个远端会话，把调用方带来的全部历史展开成带角色标注（`[System instructions]` / `[User]` / `[Assistant]`）的转录作为首条消息发出去，回答完即弃，响应里标 `mode:"stateless"`。代价如实说：每轮都要重付一次 Trae agent system prompt 的固定开销（实测约 17.6k–20.8k prompt token，无法靠复用摊薄），Trae 账号的会话列表增长也更快；换来的是没有跨请求隐藏状态，同一个 `messages` 任何时候发都是同一个结果，也不会出现"会话池命中错了导致上下文串味"。SSE 的 `plan_item` 增量翻译成 OpenAI 的 `delta` 与 Anthropic 的 `content_block_delta`，`token_usage` 翻译成 `usage`。

**模型目录要带参数问**：`GET /api/remote/v1/models` 不带参数只回默认的 `solo_coder` 一组（12 个模型），客户端实际发的是 `functions=solo_coder,solo_agent_lite,solo_agent_remote,solo_work_lite,solo_work_remote,solo_design_lite,solo_design_remote,builder&show_custom_model=true`，带上才会返回 7 个分组。网关现在两次都取、并集去重（同名模型会在多组出现），本账号当前共 **27 个**可选模型：除 solo_coder 的 12 个外，还有 glm-5.3、glm-5.2、deepseek-v4.1-flash、DeepSeek-V4-Flash/Pro 正式版、kimi-k3、kimi-k2.7-code、minimax-m3、qwen3.8-max、qwen-3.7-plus、step-5-preview、Doubao-Seed-Evolving、Doubao-Seed-2.1-Pro/Turbo。`show_custom_model=true` 带出的自定义条目里 `z-ai/glm-5.2` 实测返回 200 但 content 为空，已在网关里排除（能选但不出字比没有更糟）。目录随账号与客户端版本变化，控制台与注册流程每次都从网关动态拉取。

### 豆包工作：CDP 读登录态 + 直连完成接口

豆包工作（DoubaoWork，Electron/Chromium 147）的对话页是客户端内的本地页（`chrome://doubaowork-chat/chat`），页面背后真正打的是 `POST https://www.doubao.com/chat/completion`（SSE 流）。这一条链路比前三条都简单——**没有签名参数、没有本地网关**，`doubao/relay.mjs` 一个文件就是全部：

- **鉴权只有 cookie**：正式客户端还会带 `a_bogus` 签名参数，实测该参数可以缺省，`msToken` 直接从 cookie 里取即可，所以网关完全独立运行，**不需要豆包工作客户端开着**。
- **登录态通过 CDP 抓取**：客户端以 `--remote-debugging-port=9222` 启动后，用 `Network.getAllCookies` 可以直接拿到明文 cookie（省去 DPAPI 解密），落到 `~/.doubao-relay/cookies-cdp.json`。控制台的两种取法：「同步登录态」（客户端已带调试端口在跑）与「重启客户端并同步」（先 taskkill 再带端口重启，然后抓取）。
- **请求要在 query 上带足客户端指纹**：`aid/channel/client_platform/device_platform/pc_version=2.31.10/pkg_type/region=CN/runtime=web/runtime_version=3.39.0/samantha_web=1/use-olympus-account=1/web_tab_id=<uuid>` 等，UA 形如 `…SamanthaDoubaoWork/2.31.10`，body 里带着 `bot_id` 与 `client_meta`。（可工作的最小集合已经固化在 relay 里。）
- **SSE 事件语法**（完整枚举过）：`SSE_HEARTBEAT` / `SSE_ACK`（回执里的 `ack_client_meta.conversation_id` 才是权威会话 id）/ `FULL_MSG_NOTIFY`（用户消息回显）/ `STREAM_MSG_NOTIFY` / `STREAM_CHUNK`（`patch_op` 增量）/ **`CHUNK_DELTA`（正文增量，主要来源）** / `STREAM_TIMEOUT_CONTROL` / `SSE_REPLY_END`（`end_type` 1/2/3 表示不同阶段的结束）。正文按到达顺序拼接三个来源的增量即可得到完整回答；`end_type=1` 里的 `brief` 只是**截断摘要**，仅在没有增量时兜底。
- **会话只是个传输草稿纸（无状态）**：服务端默认把请求路由到本机「最近一个会话」，而接口层**创建不出新会话**（只能由客户端界面新建会话 + 发一句话），所以 relay 把客户端里已有的一个 `conversation_id` 固定下来（配置文件 `~/.doubao-relay/config.json`，也可 `POST /admin/conversation` 改）纯粹当作收发通道——**不复用服务端上下文**：每个请求都把调用方带来的完整历史拍平成一条消息（`[System instructions]` / `[User]` / `[Assistant]` + 只回答最后一条 `[User]` 的指令）发进去，回答完即弃，`/health` 里标 `mode:"stateless"`。上游那条固定会话仍会累积历史，但网关不读、不依赖它，所以换账号/换会话/被清了历史都不影响正确性。
- **模型目录不可枚举**：模型是服务端下发的（客户端 bundle 里没有目录，`model_item_key` 也没找到枚举接口），网关只暴露两个合成条目——`doubao`（标准）与 `doubao-think`（深思考，`conversation_init_ext` 用 `need_deep_think=9` + `reasoning_effort="5"`）。
- **注意**：反代的调用会真实出现在你本机的豆包工作会话列表里（就是那个固定会话）。不想要痕迹就在客户端里另建一个专用会话，再用 `POST /admin/conversation` 指过去。
- **工具调用不支持**（与 Trae 同为仅文本），`tools` 字段会被忽略而不是报错。

### Comate 文心快码：settings.json 里的 license + 云端 agent 三步链

Comate（`D:\Comate`，VS Code fork v1.108）是「扩展 → 本地内核（comate-engine）→ 云端 agent」三层架构，真正的对话发生在百度服务端的 agent 沙箱里。`comate/relay.mjs` 复刻的是内核到云端那一段：

- **凭证出乎意料地明文**：IDE 登录后把真正的 license（UUID 形）写进 `%APPDATA%\Comate\User\settings.json` 的 `baidu.comate.license`，用户名在 `baidu.comate.username`。注意 globalStorage 里那枚 32 位 hex 的 `comate_login_ID` **不是**有效 license（`GET /api/key/valid/{id}` 会明确拒绝），别走 DPAPI/AES-GCM 解密那条弯路（那是早期探路的死胡同，过程见 comate/decrypt_auth.py 的注释）。
- **三步链路**：`POST /api/aidevops/autocomate/rest/autowork/v2/conversation`（建会话，返回 `data.id`）→ `POST …/v2/task`（建任务，body 必须带 `agentInfo`，否则 400"conversationId and agentInfo can not null"，返回 `data.taskId`）→ 执行。**执行有两个端点，body 完全一样**：`…/v2/execute`（`text/event-stream`，逐帧推）与 `…/v2/execute-sync`（整包 `{"frames":[…]}`）。**execute 必须用真实 conversationId/taskId**：官方 CLI 用 `-1/-1` 占位会被 OpenRASP 以"无法操作其它账户创建的会话"403 拦下。
- **传输指纹有 WAF**：python-urllib 的 TLS 指纹会被 406 拒掉（与 AutoClaw 2.x 的 undici 拦截同款坑）；用 node:https + axios 同款头（`User-Agent: axios/1.16.1`、带 br 的 Accept-Encoding）即可通过。
- **两种取法，同一套帧**：帧是 JSON 字符串，`content.type` 为 `ANSWER` 的帧里 `detail.delta` 是正文增量、`reasoningDelta` 是思考增量、末帧 `end:true`，另有 `TOKEN_USAGE` 帧带用量，`NOTIFICATION` 帧是进度噪声（官方 CLI 也丢）。**relay 默认走 `execute`（SSE）**：帧一到就转给调用方，思维链和正文是"边想边出"的；只有流式建不起来（非 200 / 不是 `text/event-stream`）时才降级到 `execute-sync`，那时才需要在本地把整段答案拼好再回放（`/health` 的 `stream_fallbacks` 记这笔账）。两种协议的思维链都成型：OpenAI 走 `reasoning_content` 增量，Anthropic 是规范的 thinking 块（`content_block_start` → `thinking_delta` → `content_block_stop`）——此前只是一个孤立的 `thinking_delta`，且 OpenAI 路径**整段丢弃**，这就是"思维链不自然"的根因。
- **无状态**：每**个新提问**新建 conversation+task，调用方带来的完整历史拍平成 `[System instructions]/[User]/[Assistant]` 转录塞进 `query`；调用方的 `tools` 声明不透传（与 Trae 同类）。唯一的例外是下面的工具续跑——它复用"同一轮提问内的" conversation+task，跨用户提问不复用任何东西。
- **工具循环（2026-10-06 补齐，此前"任务跑到一半就断"的根因）**：云端 agent 的调用以 `FUNCTION_CALL_START/_PARAMS_APPEND/_END` 帧下发（`toolUse:[{id,name,input}]`，参数按 key 分片累加），relay 拼装成 OpenAI 的 `tool_calls`（`finish_reason:"tool_calls"`）或 Anthropic 的 `tool_use`（`stop_reason:"tool_use"`）；调用方执行完把结果发回来（`role:"tool"` / `tool_result` 块），relay 翻成上游自己的 `toolUseResults`（条目形如 `{id, name, success, params, message}`），在**同一个 conversation+task** 上以 `query:""`、`isFirstQuery:false`、`isUserQuery:false` 续跑——这就是 IDE 内核的做法。`compress_message`/`task_complete`/`memory_extract` 这类控制工具调用方没有处理器，由 relay 就地应答（每轮最多补 2 跳），不下发。工具循环整个建立在流式路径上，所以"想 → 调工具 → 再想 → 收尾"也是逐段出来的；客户端中途断开时 relay 会掐掉上游请求，不让一个僵尸任务继续烧额度。
- **工具名的两个词汇表 + 参数过滤**：帧里是 Claude 词汇（`Write`/`Read`/`Bash`），回报结果要 canonical 名（`write_file`/`read_file`/`run_command`，对应 bundle 里的 `V10_TOOL_ALIASES`）；回给调用方时按"调用方自己的拼写优先 → canonical 同名匹配 → 原样透传"三级映射，并按调用方声明的 schema 属性过滤参数（上游会多塞 `prefix_rule`/`description`）。
- **续跑靠一张有界路由表**：结果必须回到产出该调用的 conversation+task，所以 relay 存一张 `tool_call_id → {conversationId, taskId}` 的路由表（上限 256 条、TTL 30 分钟，条数见 `/health` 的 `tool_routing_cached`）。它是**路由表不是会话池**：新提问照旧每请求新建会话；未命中（relay 重启、过期）时降级成"把工具轮拍平进历史"的老路径，不报错、不 5xx。
- **工作区提示可配**：`sysInfo.workspacePath` 默认取 relay 的 cwd；用 `COMATE_RELAY_WORKSPACE=<路径>`（或 `--workspace <路径>`）指到真实工作区，云端 agent 才不会拿着错的根去探路径。
- **模型目录**：`POST /api/v2/api/models/available`（body 里 username/key 都填 license），15 个模型、id 带官方后缀（如 `glm-5.3_37c550fc…`），modelKey 直接用该 id（实测 `auto` 之外的真实模型 key 同样可用）。

### Qoder CN / 千问办公：COSY 签名（vendored 社区网关）

Qoder CN（`D:\Qoder CN`，`com.qodercn.app.stable`）与千问办公（QwenWork CN，`D:\QwenWorkCN`）同属阿里的 Qoder 平台，上游是 **COSY 签名体系**：RSA 包裹 AES 会话密钥 + MD5 请求签名 + 自定义 Base64 请求体编码（qoder_encode）。这一条我们没有自研——vendored 了社区的 [qoder2api-hub](https://github.com/shuishuipingan/qoder2api-hub)（MIT，纯标准库 Python，`qoder/` 目录；本地补丁：新增 qworkcn 区域、chat/models 前缀分离、目录场景与工作台形态按区域可配），以 `qoder/qoder_proxy.py --port 8791` 长驻运行：

- **凭证入池**：桌面 App 的 `%APPDATA%\com.qodercn.app.stable\auth.v1.dat`（v10+AES-GCM，密钥在 Local State）；千问办公是 `%APPDATA%\QwenWorkCN\auth-v2.dat`（schemaVersion=2，Ory JWT + `ory_rt_` 刷新令牌）。控制台「同步账号」= 面板登录（默认密码 admin，仅回环）+ `/accounts/import/desktop` 两步确认。
- **Qoder CN 全链路已通**：模型目录动态跟随官方（`/algo/api/v2/model/list`，GET 也要带同款签名 body 否则 403），对话走 `POST {gateway}/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`，**tools 透传已实测**（finish_reason:tool_calls）。Free 档只有 Qwen3.8-Max/Flash 计 0 credits，其余模型上游 403 code 112（要付费套餐），网关的 `/v1/models` 会带 `enabled` 标志，注册时过滤。
- **千问办公全链路已通**：网关独立（`gateway.qwenwork.cn`）、模型列表路径无 `/algo` 前缀而 chat 路径**带** `/algo`（CLI 日志 + 二进制字符串实证）；凭证解密、COSY 签名、模型目录（flash/pro/qwen3.8-max-preview 三档，1M 上下文）全部打通。**tools 透传已实测**（finish_reason:tool_calls，参数正确回填），流式 41 chunk + `[DONE]`。
- **千问办公的两个坑**（都会表现为 **SSE 内嵌 503 `Model catalog unavailable`**，HTTP 层面却是 200，看状态码会以为链路没问题）：一是**模型目录按场景分区**——`model/list` 返回 `chat/developer/assistant/inline/quest/nap/qwork/...` 一排格子，qworkcn 的 `chat` 是空数组，模型挂在 `qwork` 里，取错格子就拿到 0 个模型；二是**上行 body 必须声明工作台形态**（`session_type`/`business.product` = `qoder_work`，即客户端在 `QODER_WORK_INTEGRATION_MODE=1` 下的取值），不声明服务端就把请求归到默认场景、查不到该用户的目录。两处在 `qoder_accounts.py` 的 `REALM_CONFIGS["qworkcn"]` 里是 `model_scene` / `session_type` / `business_product` 三个配置项，由 `qoder_proxy.py` 按区域读取——cn/intl 不配这几项，行为与上游模板一致。
- **千问办公的模型名是封闭目录**：上游只认 `qwork` 场景里那几把 key。CN 全局别名表里同名条目指向的是另一套 key（"Qwen3.8-Flash" → `qfmodel`），一旦落到那张表上游就报 403 `Model is not available for this user`；所以 qworkcn 走 `CLOSED_REALMS` 分支，解析范围锁死在本区目录 + 本区别名表（`QWORK_ALIASES`），未命中就原样透传给上游报错，绝不跨表。
- **上游协议的保真度（用它之前先知道）**：网关入口是标准 chat completions（另收 `/v1/responses`，内部翻译成 chat 再走同一条上游），但**上行 body 是官方 `baseprompt.json` 的深拷贝**——里面的 `messages` 是"system + 拍平后的历史"，assistant 历史里的 `tool_calls` 会被序列化成文本标记，不是结构化消息；**只有 `tools` 是真列表**照发（客户端给了就用客户端的，没给就置空，避免把 Qoder 桌面端自带的 agent 工具泄漏给普通客户端）。结论：工具调用能闭环，但"同一个工具反复触发"的多轮保真度不如 WorkBuddy / AutoClaw（详见[上游协议保真度](#上游协议保真度谁是真的-chat-completions)）。
- **账号池与签到**：网关自带多账号轮询、设备指纹派生（同号固定同虚拟设备）、每日签到/活动领取（官方幂等）。账号池文件在 `~/.qoder-relay/accounts/`（控制台启动时以 `--accounts-dir` 指定），**不入库**。

## ZCode 供应商的动态增删

ZCode 里能看到哪个供应商 = 对应平台链路此刻开启。这是控制台自动维护的，不需要手动注册/清理：

- **启动**某个平台（单家「启动」按钮或「一键启动全部」）→ 该供应商自动注册进 ZCode（含模型目录实时拉取）；
- **停止**某个平台 → 该供应商自动从 ZCode 摘除（Qoder CN 与千问办公共用一个网关进程，同开同关）；
- **控制台启动时对账**：活着的链路补注册、已停的链路摘除（后台串行执行，不阻塞窗口；自测模式下跳过）。

实现与安全边界：同步逻辑与「一键注册」共用同一套注册素材构建器与写入路径（`app/main.js` 的 `platformCatalogs()` / `applyPlatformReg()`），永远走 `writeZcodeConfig` 的四道闸门；「删」的半边由 `zcode-config.js` 的 `removeProviders()` 完成——只摘除自己注册的供应商在 `providerRules` / `providerModelRules` / `providerOrder` 三处的条目，别的供应商一根毫毛不动；有意删除的结构路径必须用 `removedProviderAllowPaths()` 生成白名单放行，否则会被自己的"结构不得丢失"闸门整单拒绝（这条行为有 H2/H4 用例盯着）。同步是串行队列（一条 promise 链），任意时刻只有一个同步在跑；结果记录在 `lastZcodeSync`，ZCode 卡片上直接显示「同步 10-07 23:55（+comate -trae）」这样的增删摘要。

注意语义边界：**这里同步的是"开关"**，不是"健康"。你点了启动（哪怕该平台登录态过期、请求会 401），供应商就会出现在 ZCode 里；你点了停止，它就消失。网关崩溃不会自动摘除——那是故障，不是你的选择。

## 模型统一命名规范（models-catalog.json）

七个平台各自的模型名过去五花八门：Comate 带 `_<hash>` 后缀、AutoClaw 带内部路由前缀（`zaicoding_glm-5.3`）、Qoder/千问办公用官方显示名（`Qwen3.8-Max`、甚至中文「标准/高级」）、Trae 大小写混排还同一个模型两条。仓库根的 **`models-catalog.json`** 是对外模型名的**单一事实源**，规范七条：

1. 一律小写：`glm-5.3`、`deepseek-v4.1-flash`；
2. 形如 `<家族>-<版本>[-<变体>]`（家族：glm / deepseek / kimi / minimax / qwen / doubao-seed / step / hunyuan）；
3. 禁止上游内部痕迹：Comate 的 `_<hash>`、AutoClaw 的路由前缀（`zaicoding_`/`tdpsk_`/`zai_`）、Comate 的 `-fc`/`-oneapi` 工具标记；
4. 同一底层模型在所有平台同名（`glm-5.3` 在四家完全一致）；**无法核实同一性的不冒认同名**（Qoder 的 `DeepSeek-Flash` 保持 `deepseek-flash`，不冒认 `deepseek-v4-flash`；千问办公「高级」档底层版本未核实，按档位命名 `qwen-pro`）；
5. 平台自带命名空间保留前缀（WorkBuddy 的 `cn:`），前缀内同样小写；
6. 变体后缀语义固定（`-flash`/`-pro`/`-plus`/`-turbo`/`-think`/`-official`/`-preview`/`-code`/`-evolving`/`-max`）；
7. 兼容：各链路**同时接受旧名/原名**（别名解析），ZCode 侧重注册后统一切规范名——旧配置里的模型在重注册前也照常可用。

落地方式（不是一纸文档，是三层闭环）：

- **网关层**：`/v1/models` 只吐规范名（Comate 去 hash、Trae 统一小写并合并大小写重复条目、Qoder/千问办公缩写 key 换规范名、AutoClaw 去 `routes` 前缀），chat 请求里规范名/旧名/原名都能解析到同一个上游模型；
- **注册层**：ZCode 侧注册的 `modelId` 就是规范名（AutoClaw 的真源 `a_switch.py` 的 `ZCODE_MODELS` 第一列已改规范名）；
- **测试层**：`node test_model_catalog.mjs` 守门——离线校验目录自身合规 + 与 `a_switch.py` 逐条一致；`--live` 连上在跑的网关，校验对外 id 全部合规、静态目录平台的规范名全部在线（网关新增的上游模型只要合规就放行，打 INFO 提醒补目录）。

## ZCode 供应商注册：写入安全边界（重要）

`~/.zcode/v2/provider_config.json` 是 **ZCode 自己的配置文件**，控制台只被允许增量修改自己注册的七个供应商。历史上这里踩过两次同一个根因的坑：写入非法的 `api.type`（把内部 kind `openai-compatible` 当成合法值，导致整个供应商加载失败），以及"规范化成我认识的集合"把别人的条目删掉（丢掉必填的 `manualProviderModelRules`；又把 AutoClaw 目录削成 4 个模型）。现在的规则写死在 `app/zcode-config.js` 里：

- **api.type 只认三个值**：`anthropic-messages` / `openai-responses` / `openai-chat-completions`（取自 ZCode 自身代码的 switch 分支）
- **写入前后做结构键集断言**：丢了任何既有键/条目就整体拒绝落盘，白名单只有七家自己的模型目录（动态增删的"删"另用 `removedProviderAllowPaths()` 按被摘供应商生成放行前缀，见[动态增删一节](#zcode-供应商的动态增删)）
  - 白名单的写法有个坑：数组元素在结构路径里的身份是 `providerId/modelId`，**缺 `modelId` 的坏条目只有 `providerId`**，生成的是 `…providerModelRules[comate-openai-provider].providerId` 这种不以 `[comate-openai-provider/` 开头的路径。所以每家要同时放行 `…providerModelRules[<pid>]` 与 `…providerModelRules[<pid>/` 两个前缀，否则"修数据的那次写入"会被自己的闸门拒绝，坏条目永远改不掉（白名单存在的意义就是"模型目录由各家实时目录重写"）
- **注册结果里的 `ok` 只代表"目录取到了"**，写入是否被闸门拦下是另一个字段 `registerError`——历史上出现过"自检全绿、配置根本没变"的假绿，现在自测里有一条 `zcode:register:未被闸门拦下` 专门断言它为空
- **目录只做并集**：`personalModelIds` 只加不删，模型条目缺则补；已存在条目的能力声明（如 `supportsImage`）保留，只刷新 `contextWindow`
- **原子写 + 读回校验 + 回滚**：先写临时文件再 rename，写完重新解析，失败自动回滚到 `*.bak-<时间戳>`
- **AutoClaw 的目录真源是 `a_switch.py` 的 `ZCODE_MODELS`**（4 个模型，带逐路由实测的视觉矩阵），控制台不自带写死的列表；两条 `tdpsk_deepseek-*`（DeepSeek-V4.1-Flash / DeepSeek-V4-Pro）因上游 2026-09-29 把它们移出账号模型目录（请求回 400 非法模型）而暂不注册，名单里注释保留、权益恢复即补回
- **出口选择靠绑 Key，不靠请求头**：ZCode 的供应商条目没有自定义请求头字段，而 Qoder CN 与千问办公共用 `8791` 一个进程，于是注册前先调网关面板生成两把绑定到各自区域的 Key（`~/.autoclaw-relay/qoder-realm-keys.json`，0600 权限，明文只留本机），并顺带下发 `auth_disabled: true`——否则网关一旦存在 Key 就要求 `/v1` 全部带 Key，老注册会突然 401；写面板时用空 `key` 值占位保留别人建的条目，只增改自己那两条

沙箱回归测试 `node app/test_zcode_config.js`（**19 条用例**，纯合成 fixture，跑在临时目录里、不动你本机的配置）：A1/A2/A3 正好是上面两个历史错误（非法枚举、丢兄弟键），旧实现必失败、现实现必通过；A4 是"缺 `modelId` 的坏条目也能被本家目录重写覆盖"——只放行带斜杠的写法会被这条卡住；H1–H4 覆盖动态增删的"删"半边（摘除干净且别家无损、无白名单的注销被闸门拒绝、注销不存在的供应商零改动、白名单前缀不越界）；G1 是下面这条源码卫生回归。

**另一个非闸门的教训**：`app/main.js` 里**同一作用域重复声明同名函数，JS 会静默覆盖**（不报错，`node --check` 也过）——曾经因此把 `comateModels()` 覆盖成返回字符串数组的版本，15 条 Comate 目录的 `modelId` 全写成 `null`，而注册还报 ok。现在 `test_zcode_config.js` 的 G1 用例会扫描 `main.js` 里所有顶层 `function` 声明并要求唯一。

## 防封与额度经营（AutoClaw）

上游风控看的是**推理流水的形态**：一个号如果全是 1-token 的探针调用、或者被并发打到每分钟几百次，就会封。A-SWITCH 的防封参数是拿封掉的号的真实流水对出来的，别随便改大：

- **暖号**：新注册的号先点一次「🔥 暖号」，用真实技术问题跟模型聊 8 轮，把流水刷成正常人的形状。跳过这步的号用不了几天。
- **限速**：单号 12 次/分；**并发闸**：整池同时在途 ≤4；**日预算**：每号 6000 次/天（本地计数）。
- **多号**：反代按积分余额和空闲度选号，一个号的积分打空自动换下一个。加号用 GUI 的「桌面端登录添加」（加号前完全退出 AutoClaw 主程序，含托盘）。
- 国际端支持邮箱注册（国内端只有手机号），新号送 10000 积分分 7 天到账。

## 验证

```
# AutoClaw relay（:18766，anthropic）
curl http://127.0.0.1:18766/health
curl -X POST http://127.0.0.1:18766/v1/messages \
  -H "Content-Type: application/json" -H "x-api-key: autoclaw-local" \
  -d '{"model":"glm-5.3-flash","max_tokens":50,"messages":[{"role":"user","content":"reply OK"}]}'

# WorkBuddy 网关（:7863，openai；本体是 Go 二进制 wb2api.exe）
workbuddy/workbuddy-manager-v1.0.79/upstream/wb2api.exe -config ~/.workbuddy-gateway/config.json &
curl http://127.0.0.1:7863/v1/models -H 'Authorization: Bearer wb-local-key'
curl -X POST http://127.0.0.1:7863/v1/chat/completions \
  -H 'Content-Type: application/json' -H 'Authorization: Bearer wb-local-key' \
  --data-binary @req.json                  # {"model":"glm-5.3","messages":[...]}；模型名要小写或 cn: 前缀

# Trae 网关（:18768，openai）
node trae/relay.mjs &
curl http://127.0.0.1:18768/health        # 凭证账号/到期、模型目录、模式（stateless）
curl -X POST http://127.0.0.1:18768/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"glm-5.1","messages":[{"role":"user","content":"用一句话解释反向代理"}]}'

# 豆包工作网关（:18770，openai，另有 /v1/messages）
node doubao/relay.mjs &
curl http://127.0.0.1:18770/health        # cookie 健康度、固定会话、模式（stateless）、模型
curl -X POST http://127.0.0.1:18770/v1/chat/completions \
  -H 'Content-Type: application/json' -H 'Authorization: Bearer doubao-local-key' \
  --data-binary @req.json                  # {"model":"doubao","messages":[...]}，中文务必走文件

# Comate 网关（:18774，openai，另有 /v1/messages）
node comate/relay.mjs &
curl http://127.0.0.1:18774/health        # 登录态（settings.json 的 license）、模式（stateless）、工具循环与会话续跑路由表条数
curl -X POST http://127.0.0.1:18774/v1/chat/completions \
  -H 'Content-Type: application/json' -H 'x-api-key: comate-local' \
  -d '{"model":"auto","messages":[{"role":"user","content":"reply OK"}]}'

# Qoder CN / 千问办公网关（:8791，openai + responses；需 Python 3.9+，两条出口共用一个进程）
python qoder/qoder_proxy.py --port 8791 --accounts-dir ~/.qoder-relay/accounts &
curl http://127.0.0.1:8791/health         # 账号池数量、当前区域，以及按区域分列的 realms 明细（探针豁免，不用带 Key）
curl http://127.0.0.1:8791/v1/models -H "Authorization: Bearer $(python -c "import json;print(json.load(open(r'$HOME/.autoclaw-relay/qoder-realm-keys.json'))['cn'])")"
                                          # enabled=false 的项是付费墙模型，Free 账号调用会 403
# 千问办公出口：换 qworkcn 那把出口 Key（同一文件里），或退回 X-Realm 头
curl http://127.0.0.1:8791/v1/models -H "X-Realm: qworkcn"    # 三个模型：qwen3.8-flash(标准) / qwen-pro(高级) / qwen3.8-max
curl -X POST http://127.0.0.1:8791/v1/chat/completions \
  -H 'Content-Type: application/json' -H 'X-Realm: qworkcn' \
  -d '{"model":"qwen3.8-max","messages":[{"role":"user","content":"reply OK"}]}'
```

### 入站 api_key 闸门（2026-10-07 起，A/B 档默认开启）

模型服务路径（`/v1/messages`、`/v1/chat/completions`、`/v1/responses`、`/v1/models`、`/routes`；Comate 网关同理含无前缀变体）要求请求带 `x-api-key` 或 `Authorization: Bearer`，常数时间比对，**匿名推理一律 401**——注册进 ZCode 的 `access.apiKey` 从此是真实生效的钥匙，不再是摆设。豁免：`/health`、`/healthz`、`/`、`/fwd`（GUI 业务桥）、`/admin/*`、OPTIONS 预检，桌面端与控制台零改动。各网关钥匙：

| 网关 | 内置钥匙（与 ZCode 注册值一致） | 追加/轮换 | 关闭开关 |
|---|---|---|---|
| AutoClaw `:18766` | `autoclaw-local` ∪ `autoclaw-dsh`（dsh Bearer 兼容） | `AUTOCLAW_INBOUND_KEYS=k1,k2` | `AUTOCLAW_INBOUND_AUTH=0` |
| Comate `:18774` | `comate-local` | `COMATE_RELAY_KEY=新钥` 或 `COMATE_INBOUND_KEYS=k1,k2` | `COMATE_INBOUND_AUTH=0` |
| WorkBuddy `:7863` | wb2api 原生 `api_key`（config.json，`wb-local-key`） | — | config.json 置空 |
| Qoder/千问 `:8791` | 两把出口 Key（`~/.autoclaw-relay/qoder-realm-keys.json`，绑 Key 即选出口） | 面板 API Keys 页 | 面板 `auth_disabled` |

闸门回归：`node test_inbound_key.mjs`（零出站 32 条：401/放行判别式、双头形状、OPTIONS 204、`/health` 豁免、轮换钥、关闭开关、非环回监听下新旧两套鉴权并存）。
```

回归测试：`node trae/test_relay.mjs`（openai/anthropic × 流式/非流式 + 多轮，全部走"每请求新建会话 + 全量历史"路径）、`node trae/test_robust.mjs`（system/tools 兼容、不同会话的上游会话互相独立、多轮记忆靠全量重发历史实现）、`node doubao/test-relay.mjs`（豆包 openai/anthropic × 流式/非流式）、`node doubao/test-zcode-shape.mjs`（带 `tools`/`stream_options` 的 ZCode 形状请求 + 多轮）、`node comate/test_relay.mjs`（Comate 工具循环契约，34 条：帧→工具调用拼装、参数逐段累加、续跑路由表、两种协议的消息归一化、工具名映射与 schema 过滤，全部离线）、`node comate/test_stream.mjs`（**假上游集成测试，6 条**：本地冒充 comate.baidu.com 推真 SSE，验证"内容分片数 == 上游帧数"（真流式而非切片回放）、思维链在两种协议下成型、续跑回到同一 conversation+task、内部工具不下发、上游不支持流式时降级 —— 不联网不耗额度）、`node app/test_zcode_config.js`（配置写入闸门，19 条）、`node test_inbound_key.mjs`（入站 api_key 闸门，零出站 32 条）、`node test_model_catalog.mjs`（模型命名一致性：离线 11 条，`--live` 连网关一起验）、`python qoder/_test_qoder.py` / `python qoder/_test_leak_guard.py`（vendored 网关自带）、`python bridge/test_extract_persona.py`（persona 提取的沙箱回归：合成 bundle 上的依赖排序、自检拦截、过期三分支，不依赖真实客户端）。Comate 的真机多跳工具循环另有 `COMATE_E2E=1 node comate/e2e_tool_loop.mjs`（真跑工具、消耗额度，默认跳过），单条链路的流式打点见 `node comate/probe_stream.mjs`（同样耗额度、手动跑，输出每帧到达时间）；Qoder/千问的端到端验证走控制台的「连通性测试」按钮（真实推理，不是探活），也就是自测里的 `qoder:smoke` / `qwenwork:smoke`。

注意在 Git Bash 里用 `curl -d '中文'` 会因为控制台代码页是 GBK 而发出乱码字节，测试中文请用 Node 脚本或 `--data-binary @utf8文件`。

## 故障速查

| 症状 | 原因与处置 |
|---|---|
| 401 Invalid token | 应用轮换了 access token。凭证同步器正常时会自动跟进；若没在跑，重新打开 AutoClaw 登录一次，或重跑 `bridge/make_compat_auth.py` |
| 402 积分不足 | 终态错误，等每日赠送（每日登录 1000 分）或充值，反代不会重试 |
| 406 空响应 | 2.x 闸门五要素缺一（见上文）；最常见是 persona.txt 没部署——控制台点「启动」会自动从已安装客户端提取（日志里搜 `persona:`） |
| 810001 系统繁忙 | GLM-5.3-Flash 白天高峰限流，夜间 23:00-09:00 畅通；反代已自动退避重试，白天建议改用 GLM-5.3 或 Auto 路由 |
| Trae 401 | 凭证约 5 天过期，重新打开 Trae 登录一次；网关遇 401 自动重读 storage.json，无需重启 |
| Qoder/千问办公 401 或 `no usable account for realm` | 先分两种 401：`invalid api key` = 请求没带/带错出口 Key（入站鉴权 2026-10-07 起默认开启，Key 见 `~/.autoclaw-relay/qoder-realm-keys.json`）；`no usable account` = 该区域账号池为空或凭证过期，控制台「同步账号」重新入池；冷却中的账号要等冷却结束（或重启网关）才会重新可用 |
| 千问办公 SSE 里回 `503 Model catalog unavailable`（HTTP 却是 200） | 上游按场景分区目录、且要请求声明工作台形态：取错 `model_scene` 或没带 `session_type`/`business.product`。此提示只在 HTTP 200 的 SSE 正文里，看状态码发现不了——排查时直接看报文内容 |
| Qoder/千问网关起不来 | 需要 Python 3.9+（纯标准库）。手动跑 `python qoder/qoder_proxy.py --port 8791` 看真实报错；端口被占说明已有一个网关在跑 |
| 改完 `qoder/*.py` 或 `comate/relay.mjs` 没生效 | 长驻进程里还是旧代码——把它们停掉再启动（改 `app/main.js` 则要重启控制台进程），exe 版还要重新打包重装 |
| Comate 401 / 启动即失败 | `settings.json` 里的 license 失效（重新登录 Comate IDE 一次即可，relay 每次读文件、不用重启） |
| Comate 406 | 触发了百度的 WAF：请求指纹必须是 node:https + axios 头，python-urllib 会被直接拒 |
| ZCode 里看不到新模型 | 配置每 60 秒轮询一次；先确认「一键注册」的结果里 `registerError` 为空（写 `ok` 只代表目录取到了），再重启一次 ZCode |
| ZCode 里突然少了某个供应商 | 动态增删的"删"：该平台链路被停止（或控制台启动对账时它没在跑）。重新点「启动」即自动注册回来；若 `~/.zcode/v2/provider_config.json` 写入失败，ZCode 卡片与日志里有 `zcode sync failed` 详情 |
| 模型名怎么都变成小写了 / 旧模型名还能用吗 | 这是[统一命名规范](#模型统一命名规范modelscatalogjson)：`/v1/models` 只吐规范名，但各网关的 chat 入口**同时接受旧名**（Comate 旧 hash 名、AutoClaw 旧 TitleCase 名、Qoder 显示名、千问办公「标准/高级」都保留别名解析），重注册前旧配置照常工作 |
| 注册后模型数对不上 / 某个条目名字是空的 | 先比 `providerModelRules` 的条目数与 `personalModelIds` 长度；历史上这里出过"同名函数静默覆盖 → 15 条 Comate 目录 modelId 全 null"的回归，现已由 G1 用例守住 |
| 豆包 401 / cookie 缺失 | 客户端登录态过期。控制台点「同步登录态」（需客户端已带调试端口运行）或「重启客户端并同步」重新抓 cookie |
| 豆包回复乱码 / 空 | 先确认请求正文本身是 UTF-8（Git Bash 的 `curl -d '中文'` 会发 GBK 乱码，见「验证」一节）；固定会话被删时用 `POST /admin/conversation` 换一个 |
| 点按钮没反应 | 大概率是 Python 缺 cryptography——spawn 成功但同步器立刻崩。点「环境体检」确认 |
| 控制台整个冻住 | 罕见：老版本 spawn 找不到命令时未捕获异常会阻塞事件循环；现版本已统一走 trySpawn。若复现，先体检 PATH |
| WB 模型报错 | 模型名要小写或 `cn:` 前缀；确认 wb2api.exe 在 `workbuddy/.../upstream/` 且已 OAuth |

**全部七家的共同限制（先说清楚）**：入口虽然都是标准 chat completions，但只有 WorkBuddy 与 AutoClaw 的上游本身是 chat completions（`messages`/`tools` 结构化保真）；其余五家要把历史"拍平成文本"再喂给上游的 agent 协议，因此**多轮里的工具往返、结构化角色、附件引用都可能失真**，长会话尤其明显。五家里 Qoder CN 与千问办公是特例（工具声明是真列表，只有历史是文本），所以工具闭环仍然成立。逐家证据见[上游协议保真度](#上游协议保真度谁是真的-chat-completions)。

**模型的视觉能力按路由实测配置**：GLM-5.3-Flash、Auto 系列可以看图；GLM-5.3（coding 版）不行，发图它会说看不见。（实测矩阵里 DeepSeek-V4.1-Flash 可看图、DeepSeek-V4-Pro 不行，但这两条路由 2026-09-29 起被上游移出账号目录、暂未注册，权益恢复后按原矩阵补回。）

**Trae 的固有限制**：工具调用不透传（agent 自行决定，OpenAI 的 `tools` 字段被忽略，模型只回文本）；每轮固定开销约 17.6k prompt token（Trae 自己的 agent system prompt），短问答不划算，更适合长任务、长上下文场景。

**豆包的固有限制**：同样不支持工具调用；模型目录只有两个合成条目（服务端不可枚举）；请求内容会留在本机豆包工作的固定会话里。

**Comate 的固有限制**：工具集不由调用方决定（云端 agent 用自己的工具集，调用方只有声明了同名/canonical 同名的工具才执行得了；没声明就没有工具可调）；上游 agent 的自我认知是它自己的系统提示词（自称 Cursor 系助手），不是 ZCode；`execute-sync` 兜底路径下每轮 8-40 秒（整段返回），走 SSE 时首字通常 1-2 秒。

**Qoder 的固有限制**：Free 账号多数模型在付费墙后（`/v1/models` 里 `enabled:false`，注册时已过滤）；能用的模型也都受"历史拍平成文本"影响——工具调用能闭环，但同一个工具反复触发的多轮往返保真度低于 WorkBuddy / AutoClaw。千问办公的模型目录只有三档且**不通用**——它只认自己那套 key，所以在 qworkcn 出口下 CN 的模型名一个也用不了（反之亦然），这是上游的封闭目录决定的，不是网关的过滤。

## 目录结构

```
（仓库根，同时就是运行时的资源根）
├── app/                           ← Electron 管理控制台（七平台统一面板 + ZCode 注册）
│   ├── main.js / preload.js       生命周期管理 + IPC（含 ASWITCH_SELFTEST 自测模式）
│   ├── zcode-config.js            ★ ZCode 配置写入闸门（纯 Node：枚举/结构/原子/回滚 + 动态注销）
│   ├── test_zcode_config.js       配置闸门与主进程源码卫生的沙箱回归测试（19 条用例）
│   ├── test_client.mjs            CDP 端的 GUI 自测脚本（需控制台带 --remote-debugging-port=9222）
│   └── renderer/                  状态面板 UI（index.html / ui.js / style.css）
├── bridge/                        ← AutoClaw 2.x 适配层
│   ├── make_compat_auth.py        凭证桥接（DPAPI 解密 → auth.json）
│   ├── watch_auth.py              凭证自动同步器（常驻）
│   ├── server_2x.mjs              PR#4 的 2.x 独立部署版反代（控制台「启动 AutoClaw」部署它；上游主线已并入 relay/server.mjs）
│   ├── extract_persona.py         ★ 从已装客户端提取应用 persona（厂商文本不入库；随包种子仅兜底）
│   └── test_*.mjs / probe_*.mjs   406 闸门的实验、验证与二分脚本（30 个）
├── trae/                          ← Trae SOLO CN 反代
│   ├── relay.mjs                  ★ 网关本体（openai + anthropic，凭证解密 + 无状态转发）
│   ├── decrypt_auth.py            离线解密 storage.json 的参考实现
│   ├── remote_api_spec.json       枚举出的 198 个远程端点（逆向记录）
│   ├── dump_events.mjs            原始 SSE 事件转储（协议分析用）
│   └── test_relay.mjs / test_robust.mjs  回归测试
├── doubao/                        ← 豆包工作反代
│   ├── relay.mjs                  ★ 网关本体（openai + anthropic，cookie 鉴权 + SSE 解析 + 无状态全量铺平）
│   ├── cdp.js / cdp-key.mjs       CDP 工具（cookies 抓取 / 请求头与网络转储 / 调试端口 Key）
│   ├── probe.mjs / im.mjs / raw.mjs        协议探针（SSE 事件、IM cmd 协议、任意端点）
│   ├── test-relay.mjs / test-zcode-shape.mjs  回归测试
│   └── t-*.mjs                    协议实验脚本（会话、ACK、多轮、深思考对照）
├── comate/                        ← Comate（文心快码）反代
│   ├── relay.mjs                  ★ 网关本体（openai + anthropic，license 凭证 + 云端 agent 三步链（SSE 真流式）+ 工具循环续跑）
│   ├── test_relay.mjs             工具循环契约的离线回归（34 条，不花额度）
│   ├── test_stream.mjs            假上游流式/工具循环集成测试（6 条，不联网不花额度）
│   ├── e2e_tool_loop.mjs          真机多跳工具循环 E2E（COMATE_E2E=1 才跑，消耗额度）
│   ├── probe_stream.mjs           真机流式打点探针（每帧到达时间；消耗额度，手动跑）
│   └── decrypt_auth.py            凭证读取（settings.json 的 license；附早期 DPAPI 弯路记录）
├── qoder/                         ← Qoder CN / 千问办公网关（vendored qoder2api-hub + 本地补丁）
│   ├── qoder_proxy.py             ★ 网关本体（纯标准库 Python；COSY 签名、账号池、看板、两条出口）
│   ├── qoder_sign.py              COSY 签名/加解密（RSA+AES+MD5+qoder_encode，纯 Python）
│   ├── qoder_accounts.py          账号池 / 桌面凭证入池 / OAuth 设备流
│   ├── qoder_settings.py          区域与模型目录设置（REALMS / CLOSED_REALMS / 别名）
│   ├── qoder_catalog*.json        三个模型目录快照（cn / intl / qworkcn）
│   ├── baseprompt.json            ★ 上游 COSY 信封模板（历史拍平成文本的落点）
│   ├── dashboard.html             网关自带看板
│   ├── _test_qoder.py / _test_leak_guard.py   回归测试（含"令牌不外泄"断言）
│   ├── _refresh_catalog.py / _verify_models.py / _diag_*.py   目录刷新与在线诊断
│   └── start-qoder-proxy*.bat / Dockerfile / docker-compose.yml   启动脚本与容器化
├── a_switch.py                    ← A-SWITCH 1.x 后端（账号管理、签到、DPAPI 解密、一键反代、暖号）
│                                    控制台的「一键注册 / 余额查询 / 凭证同步」也加载它
├── models-catalog.json            ★ 模型统一命名规范 + 七平台规范名对照（单一事实源）
├── test_model_catalog.mjs           命名一致性守门（离线 11 条；--live 连网关一起验）
├── a_switch_app.py                ← A-SWITCH 1.x GUI（pywebview）
├── relay/server.mjs               ← 上游主线的双线统一反代（国内/国际通用；a_switch.py 一键反代部署的就是它）
├── A-SWITCH.spec / tools/ / assets/   PyInstaller 打包配置、邮件辅助脚本、图标
├── workbuddy/                     ← WorkBuddy 网关（**不入库**：exe 与 Go 源码需自备，见下）
│   └── workbuddy-manager-v1.0.79/upstream/{wb2api.exe, wb2api-login.exe, config.json}
└── README.md / README.en.md / TEST_REPORT.md / PROMPT_FOR_ZCODE.md / LICENSE
```

**资源根的约定**：控制台按 `<资源根>/app`、`<资源根>/bridge`、`<资源根>/trae` 等固定层级定位各家网关与注册器，`<资源根>/a_switch.py` 则是「一键注册 / 余额查询 / 凭证同步」要加载的 1.x 后端——所以**整个仓库就是运行时目录树，只拷 `app/` 一个目录跑不起来**。打包成 exe 时这些目录原样进 `resources/`，层级不变（Python 片段里用的是 `../autoclaw-switch/a_switch.py`，找不到时会退到 `../a_switch.py`，两种树形都成立）。

**`workbuddy/` 需要自备**：该目录不进版本库（`*.exe` 与上游 Go 源码都不提交），但属于本项目的 Release 资产——把 Release 里的 `workbuddy-manager-v1.0.79/upstream/`（含源码快照、MIT 许可、`UPSTREAM-SRC.txt` 的构建与打包说明）解压到仓库根，或只把 `wb2api.exe`、`wb2api-login.exe` 放进 `workbuddy/workbuddy-manager-v1.0.79/upstream/` 即可。该目录同时是开发态的 wb2api 工作目录（`config.json` 就在它旁边）；打包版改用 `~/.workbuddy-gateway/` 当工作目录并自动播种配置。

运行时数据（自动生成，均带敏感信息，不入库）：`~/.autoclaw-relay/`（部署的反代、persona、日志、Qoder/千问办公的出口 Key `qoder-realm-keys.json`）、`~/.openclaw-autoclaw/`（凭证源）、`~/.trae-relay/`（Trae 日志与会话转储）、`~/.doubao-relay/`（豆包 cookie、固定会话、日志）、`~/.comate-relay/`（Comate 日志与设备指纹）、`~/.qoder-relay/`（Qoder/千问办公账号池与网关日志，含真实令牌，绝不外传）、`~/.zcode/v2/provider_config.json`（ZCode 注册，备份为 `.bak-autoclaw`）。

## 免责声明

本项目通过逆向 AutoClaw / WorkBuddy / Trae / 豆包工作 / Comate 文心快码 / Qoder CN / 千问办公 客户端实现了对非官方接口的调用，仅供学习研究。使用本项目导致的账号封禁、积分损失由使用者自行承担。请勿用于商业用途。AutoClaw 是智谱/Z.ai 的产品，WorkBuddy 相关服务来自腾讯云，Trae 与豆包工作是字节跳动的产品，Comate 文心快码是百度的产品，Qoder 与千问办公是阿里的产品，本项目与上述公司均无关。
