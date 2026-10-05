# 轻量本地翻译服务（英文 → 中文）
#
# 不装 torch/transformers：直接用现成的 CTranslate2 格式模型，启动即下载到挂载目录。
# 模型来自 OPUS-MT（Helsinki-NLP）的 Marian 系列，是专门的机器翻译模型，不是大模型。
#
# 想改用官方模型自行转换（质量更好，但构建要下 torch）：见 Dockerfile.buildmodel
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    MT_MODEL_DIR=/models/mt-en-zh

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl patchelf \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt \
 # ctranslate2 自带的 .so 带可执行栈标记，部分内核（含 WSL2 上的 Docker）会拒绝加载，
 # 报 "cannot enable executable stack"。用 patchelf 清掉该标记即可。
 && find /usr/local/lib/python3.11/site-packages -name '*.so*' \
      -exec sh -c 'patchelf --clear-execstack "$1" 2>/dev/null || true' _ {} \;

COPY app.py .

EXPOSE 9910
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=5 \
  CMD curl -fsS http://127.0.0.1:9910/health || exit 1

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "9910"]
