# A-SWITCH

[中文](README.md) | [English](README.en.md)

**下载exe**：[Releases · A-SWITCH.exe](../../releases/latest) （无需装 Python）

AutoClaw 的多账号管理工具，附带一个本地反代，能把 AutoClaw 账号的积分变成 ZCode 里可以直接选用的模型。

做了三件事：

1. **多账号**。一个窗口里加号、切号、看余额、批量签到领积分。AutoClaw 桌面端本身一次只能登一个号。
2. **防封**。上游风控看的是推理流水的形态：一个号如果全是 1-token 的探针调用、或者被并发打到每分钟几百次，就会封。所以这里有暖号（给新号跑真实对话建立用量基线）、限速（单号 12 次/分）、并发闸（整池同时在途 ≤4）、日预算（每号 6000 次/天，本地计数）。这些参数不是拍脑袋，是拿封掉的号的真实流水对出来的，别随便改大。
3. **反代**。点一下按钮，把 AutoClaw 注册成 ZCode 的一个模型供应商。之后 ZCode 里就能直接选 GLM-5.3 / DeepSeek-V4.1-Flash 这些模型，消耗的是 AutoClaw 账号的积分。

## 国际端注册

AutoClaw 的国际端支持邮箱注册（国内端只有手机号）。新号送 10000 积分，分 7 天到账。注册入口在 AutoClaw 官方客户端的登录页，或者网页端。多注册几个号轮着用，比单号扛得住。

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

## 使用

前提：本机装了 AutoClaw 并登录过至少一个号（工具靠读它的登录态拿凭证）。

**加号**：GUI 里「桌面端登录添加」会弹官方登录窗口，登录后自动入库。注意加号前先完全退出 AutoClaw 主程序（含托盘），否则登录态会被主实例截走。

**一键反代**：点「⚡ 一键反代」。它会依次：部署本地反代（`~/.autoclaw-relay/`）→ 把 AutoClaw 注册进 ZCode 的供应商列表 → 发一发验证请求。完成后**重启 ZCode**，模型列表里就有 AutoClaw 了。

**暖号**：新注册的号建议点一次「🔥 暖号」。它会用真实的技术问题跟模型聊 8 轮，把流水刷成正常人的形状。跳过这步的号用不了几天。

## 反代的工作方式

`relay/server.mjs` 是一个纯本地的 node 服务，监听 `127.0.0.1:18766`，把 ZCode 发来的 Anthropic/OpenAI 格式请求翻译成 AutoClaw 云端的格式。翻译中最关键的一点：请求的 system 提示词必须以官方 harness 标记开头，否则网关回 406 空响应。这个标记反代会自动补，你不用管。

多账号时反代按积分余额和空闲度选号，一个号的积分打空自动换下一个。所有请求都走本机，凭证不离开你的电脑。

反代的凭证有两个来源：多号用户由 A-SWITCH 的账号池导出（`~/.openclaw-autoclaw/aswitch_cloud_pool.json`）；只有单号的用户它会直接读当前登录态。

## 已知问题

- 上游对非浏览器 TLS 指纹有间歇性拦截。python/curl 的直连请求可能被掐断，node 基本能过。GUI 的业务请求已经内置了走 node 的回退，一般无感。如果频繁遇到，等一等再试，或重启 Clash 换个出口。
- 模型的"视觉能力"是按路由实测配置的：GLM-5.3-Flash、DeepSeek-V4.1-Flash、Auto 系列可以看图；GLM-5.3（coding 版）和 DeepSeek-V4-Pro 不行，发图它会说看不见。
- `DeepSeek-V4.1-Flash` 这个名字是 AutoClaw 自己的叫法，上游实际回的模型串是 `deepseek-v4-flash-202605`，有视觉，不是挂羊头卖狗肉。

## 免责声明

本项目通过逆向 AutoClaw 客户端实现了对非官方接口的调用，仅供学习研究。使用本项目导致的账号封禁、积分损失由使用者自行承担。请勿用于商业用途。AutoClaw 是智谱/Z.ai 的产品，本项目与其无关。

## 目录

```
a_switch.py          后端：账号管理、签到、DPAPI 解密、一键反代、暖号
a_switch_app.py      GUI（pywebview + 内嵌 HTML）
relay/server.mjs     本地反代（node，无第三方依赖）
relay/warm/          暖号脚本
A-SWITCH.spec        PyInstaller 打包配置
PROMPT_FOR_ZCODE.md  不想手动操作的话，把这份提示词发给 ZCode 让它自己装
```
