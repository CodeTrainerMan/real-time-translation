#!/usr/bin/env bash
# 启动 sherpa-onnx 流式识别 WebSocket 服务。
#
# 环境变量（全部可选）：
#   ASR_PORT              监听端口，默认 9901
#   ASR_MODEL             模型代号：en | zh | bilingual，默认 en
#   ASR_QUANT             int8 | fp32，默认 int8（找不到 int8 文件时自动回退 fp32）
#   ASR_TRAILING_SILENCE  端点判定的尾部静音秒数，默认 0.8（越小断句越积极）
#   ASR_NUM_THREADS       onnxruntime 线程数，默认 2
#   ASR_MODELS_DIR        模型根目录，默认 /models（compose 已挂载）
set -euo pipefail

PORT="${ASR_PORT:-9901}"
MODEL="${ASR_MODEL:-en}"
QUANT="${ASR_QUANT:-int8}"
TRAILING_SILENCE="${ASR_TRAILING_SILENCE:-0.8}"
NUM_THREADS="${ASR_NUM_THREADS:-2}"
MODELS_ROOT="${ASR_MODELS_DIR:-/models}"
NUM_IO_THREADS="${ASR_NUM_IO_THREADS:-4}"
# 端点检测：true 时服务端按"音频静音"自己切句。它在语音中途误判静音就会把
# 单词从中间劈开（"Intell" / "igence"），切成两个 is_final 段。
# 设 false 则由应用按"模型输出停顿"断句——模型吐词的时机本身就是词边界，
# 切点更靠谱，代价是服务端不再回 is_final，换行完全由应用兜底。
ENDPOINT="${ASR_ENDPOINT:-true}"

case "$MODEL" in
  en)        MODEL_NAME="sherpa-onnx-streaming-zipformer-en-2023-06-26" ;;
  en-kroko)  MODEL_NAME="sherpa-onnx-streaming-zipformer-en-kroko-2025-08-06" ;;
  zh)        MODEL_NAME="sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30" ;;
  bilingual) MODEL_NAME="sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20" ;;
  *) echo "[asr] 未知模型代号: $MODEL（可选 en / zh / bilingual）" >&2; exit 1 ;;
esac

MODEL_DIR="$MODELS_ROOT/$MODEL_NAME"
if [ ! -f "$MODEL_DIR/tokens.txt" ]; then
  echo "[asr] 首次运行，下载模型 $MODEL_NAME ..." >&2
  mkdir -p "$MODELS_ROOT"
  curl -fL --retry 3 --connect-timeout 20 \
       -o "/tmp/$MODEL_NAME.tar.bz2" \
       "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/$MODEL_NAME.tar.bz2" >&2
  tar -xjf "/tmp/$MODEL_NAME.tar.bz2" -C "$MODELS_ROOT"
  rm -f "/tmp/$MODEL_NAME.tar.bz2"
fi

# 挑模型文件：QUANT=int8 时优先 *.int8.onnx，否则用同名非量化版本。
pick() {
  local pattern="$1" hit=""
  if [ "$QUANT" = "int8" ]; then
    hit=$(ls "$MODEL_DIR"/$pattern 2>/dev/null | grep -i '\.int8\.onnx$' | head -n1 || true)
  fi
  if [ -z "$hit" ]; then
    hit=$(ls "$MODEL_DIR"/$pattern 2>/dev/null | grep -vi '\.int8\.onnx$' | head -n1 || true)
  fi
  [ -n "$hit" ] || { echo "[asr] 模型文件缺失: $pattern（目录 $MODEL_DIR）" >&2; exit 1; }
  echo "$hit"
}

ENCODER=$(pick "encoder*.onnx")
DECODER=$(pick "decoder*.onnx")
JOINER=$(pick "joiner*.onnx")

echo "[asr] model=$MODEL quant=$QUANT port=$PORT threads=$NUM_THREADS silence=${TRAILING_SILENCE}s" >&2
echo "[asr] encoder=$(basename "$ENCODER")" >&2

# 端点规则：rule2 = 尾部静音超阈值 + 句内确有语音 → 断句（主要生效规则）
exec sherpa-onnx-online-websocket-server \
  --port="$PORT" \
  --tokens="$MODEL_DIR/tokens.txt" \
  --encoder="$ENCODER" \
  --decoder="$DECODER" \
  --joiner="$JOINER" \
  --num-threads="$NUM_THREADS" \
  --num-io-threads="$NUM_IO_THREADS" \
  --decoding-method=greedy_search \
  --enable-endpoint="$ENDPOINT" \
  --rule1-min-trailing-silence=3.0 \
  --rule2-min-trailing-silence="$TRAILING_SILENCE" \
  --rule2-must-contain-nonsilence=true \
  --rule3-min-utterance-length=30 \
  --log-file=/dev/stdout
