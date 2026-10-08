# Qoder Multi-Account Reverse Proxy Gateway (CN + Intl)

# ---------------------------------------------------------------------------
# 构建期：提取 UMID 原生组件（@qoder-ai/qodercli 内嵌的 runtime-info）
# 纯标准库 python 实现（不需要 node）；npm 包只在 builder 阶段存在——31MB 的
# tarball 与下载过程都不会进入最终镜像。提取失败不阻断构建：那种情况下网关
# 退化为 derived 身份（活动列表可能被服务端过滤，见 issue #10），功能仍可用。
# ---------------------------------------------------------------------------
FROM python:3.11-alpine AS umid-builder
ARG TARGETARCH
WORKDIR /build
COPY _install_umid.py ./
RUN apk add --no-cache ca-certificates && \
    arch="x64"; [ "$TARGETARCH" = "arm64" ] && arch="arm64"; \
    python _install_umid.py --platform linux --arch "$arch" --dest /build/umid || \
    echo "WARN: UMID extraction failed (gateway will fall back to derived identity)"; \
    mkdir -p /build/umid

FROM python:3.11-alpine

# Set environment
# 注：API_KEY 默认为空，只作为 compose / docker run -e 的覆盖入口，不承载任何密钥。
# （docker build 的 SecretsUsedInArgOrEnv lint 提示来自变量名，而非真实密钥内容。）
ENV PYTHONUNBUFFERED=1 \
    HOST=0.0.0.0 \
    PORT=8790 \
    API_KEY= \
    TZ=Asia/Shanghai

WORKDIR /app

# Alpine timezone & certs + UMID 组件的 glibc 兼容层（issue #12）：
#   提取出的 runtime-info 是 glibc 动态链接的 ELF（依赖 libstdc++），alpine 是
#   musl——缺 /lib64/ld-linux-x86-64.so.2 与 libstdc++.so.6 时 exec 会直接失败
#   （exit 127，观感像「文件不存在」，实为组件在但跑不起来）。
#   gcompat 提供 glibc ABI 兼容层，libstdc++/libgcc 补齐 C++ 运行时（约 +3.1MB）。
RUN apk add --no-cache tzdata ca-certificates gcompat libstdc++ libgcc && \
    cp /usr/share/zoneinfo/${TZ} /etc/localtime && \
    echo "${TZ}" > /etc/timezone

# Copy application files (Zero external pip dependencies needed -
# AES/RSA/COSY signing are pure-stdlib implementations)
COPY qoder_proxy.py qoder_accounts.py qoder_catalog.py qoder_fingerprint.py \
     qoder_scheduler.py qoder_settings.py qoder_sign.py qoder_tasks.py \
     dashboard.html baseprompt.json ./

# 官方模型目录快照（运行时优先读取；缺失会回退 qoder_catalog.py 内嵌冻结副本）
COPY qoder_catalog_intl.json qoder_catalog_cn.json ./

# UMID 原生组件（构建期提取；运行时 qoder_accounts.runtime_info_exe() 在
# POSIX 下按 <repo>/umid/runtime-info 查找）。builder 提取失败时这里是空目录。
COPY --from=umid-builder /build/umid /app/umid

# 验证 / 诊断脚本一并入镜像（容器内自检用；纯标准库，零 pip 依赖）：
#   docker run --rm qoder-proxy:latest python _test_qoder.py
#   docker run --rm qoder-proxy:latest python _diag_gateway.py --chat
# 注：官方 fixture 不在镜像内，_test_qoder.py 的 [4.5] 组会打印 [SKIP]（不计失败）。
COPY _test_qoder.py _diag_gateway.py _diag_campaign.py _verify_models.py \
     _refresh_catalog.py _install_umid.py ./

# Create data directories
RUN mkdir -p /app/accounts /app/usage

# Volume persistence for credentials and usage logs
VOLUME ["/app/accounts", "/app/usage"]

EXPOSE 8790

# 监听参数由上面的 ENV HOST/PORT 提供（qoder_proxy.py 的 argparse 默认值直接
# 读环境变量），所以 docker run -e PORT=9000 与 compose 的 environment 真的生效；
# 需要附带其它命令行参数时用 compose 的 command: 覆盖本 CMD。
CMD ["python", "qoder_proxy.py"]
