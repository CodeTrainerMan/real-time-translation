# 本地流式语音识别服务（sherpa-onnx）
#
# 二进制直接取官方 release（linux-x64-shared），不自行编译；模型在容器首次启动时
# 按需下载到挂载目录（默认 ./models），因此重建镜像不会重复下载模型。
FROM debian:bookworm-slim

ARG SHERPA_VERSION=1.13.8
ARG SHERPA_TARBALL=sherpa-onnx-v${SHERPA_VERSION}-linux-x64-shared.tar.bz2

RUN apt-get update \
 && apt-get install -y --no-install-recommends libgomp1 bzip2 curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/sherpa
RUN curl -fsSL -o /tmp/sherpa.tar.bz2 \
        "https://github.com/k2-fsa/sherpa-onnx/releases/download/v${SHERPA_VERSION}/${SHERPA_TARBALL}" \
 && tar -xjf /tmp/sherpa.tar.bz2 -C /opt/sherpa --strip-components=1 \
 && rm -f /tmp/sherpa.tar.bz2 \
 && ln -sf /opt/sherpa/bin/sherpa-onnx-online-websocket-server /usr/local/bin/sherpa-onnx-online-websocket-server \
 && sherpa-onnx-online-websocket-server --help >/dev/null 2>&1 || true

ENV LD_LIBRARY_PATH=/opt/sherpa/lib

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# Windows 下写文件易带 CRLF，entrypoint 必须去掉，否则容器里报 "bad interpreter"
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
 && chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 9901
ENTRYPOINT ["docker-entrypoint.sh"]
