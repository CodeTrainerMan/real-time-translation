"""构建期把 HuggingFace 上的 Marian/opus 模型转成 CTranslate2 格式。

只在镜像构建阶段执行（需要 torch/transformers），运行阶段不需要这些依赖。
"""

import os
import sys

from ctranslate2.converters import TransformersConverter

MODEL = os.getenv("MT_SRC_MODEL", "Helsinki-NLP/opus-mt-tc-big-en-zh")
OUT = os.getenv("MT_OUT_DIR", "/opt/mt-model")
QUANT = os.getenv("MT_QUANT", "float32")

print(f"[convert] 模型 {MODEL} → {OUT}（quantization={QUANT}）", flush=True)
try:
    converter = TransformersConverter(MODEL)
    converter.convert(OUT, quantization=QUANT, force=True)
except Exception as exc:  # noqa: BLE001
    print(f"[convert] 转换失败: {exc}", file=sys.stderr, flush=True)
    raise

print("[convert] 完成", flush=True)
