"""轻量本地翻译服务（英文 → 中文）。

定位：一个"只做翻译"的小工具，和 asr-service 同级：不跑大模型、不联网翻译、不要任何云的 Key。
  - 模型：OPUS-MT 的 Marian 系列（默认）或 NLLB-200-distilled-600M，都是**专用机器翻译模型**
  - 引擎：CTranslate2（OpenNMT 的推理引擎，GitHub 4.7k stars），CPU 单句几十~几百毫秒
  - 镜像里不含 torch；模型要么首次启动下载（默认），要么构建期转换好（见 Dockerfile.buildmodel）

两种分词方式（自动判断）：
  1. 模型目录里有 source.spm / target.spm → 用 SentencePiece 编解码（Marian 系列）
  2. 设置了 MT_HF_TOKENIZER → 用 HuggingFace 官方 tokenizer 编解码（NLLB 等）

对外接口（字段名兼容 LibreTranslate，方便互相替换）：
  GET  /health    → {"ok":true,"ready":true,"model":"..."}
  POST /translate → {"translatedText":"...","translations":["..."]}
       body: {"q":"hello","source":"en","target":"zh"}  或批量 {"texts":["a","b"]}
"""

import os
import re
import threading
from typing import List, Optional

import ctranslate2
import requests
import sentencepiece as spm
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# 现成的 CTranslate2 格式 en→zh 模型（源模型是 Helsinki-NLP/opus-mt-en-zh）
MODEL_REPO = os.getenv("MT_MODEL_REPO", "gaudi/opus-mt-en-zh-ctranslate2")
MODEL_DIR = os.getenv("MT_MODEL_DIR", "/models/mt-en-zh")
HF_ENDPOINT = os.getenv("HF_ENDPOINT", "https://huggingface.co").rstrip("/")
DEVICE = os.getenv("MT_DEVICE", "cpu")
# opus 对 int8 量化敏感（实测译文明显劣化），CPU 上默认 fp32
COMPUTE_TYPE = os.getenv("MT_COMPUTE_TYPE", "float32")
BEAM_SIZE = int(os.getenv("MT_BEAM_SIZE", "4"))
# NLLB 对过长的输入会在中途生成结束符，导致后半句漏译。
# 实测按逗号切开后逐段翻译是完整的，所以这里把切分阈值调小，并在必要时按逗号再切。
SPLIT_THRESHOLD = int(os.getenv("MT_SPLIT_THRESHOLD", "60"))

# NLLB 这类多语种模型要指定语言代码（Flores-200）
HF_TOKENIZER = os.getenv("MT_HF_TOKENIZER", "")
SOURCE_CODE = os.getenv("MT_SOURCE_CODE", "eng_Latn")
TARGET_CODE = os.getenv("MT_TARGET_CODE", "zho_Hans")

NEEDED_FILES = ["model.bin", "source.spm", "target.spm", "shared_vocabulary.json", "config.json"]

app = FastAPI(title="realtime-translation-mt", version="2.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_state = {
    "ready": False,
    "loading": False,
    "error": None,
    "model": MODEL_REPO,
    "translator": None,
    "sp_source": None,
    "sp_target": None,
    "tokenizer": None,
}


class TranslateRequest(BaseModel):
    q: Optional[str] = None
    texts: Optional[List[str]] = None
    source: str = "en"
    target: str = "zh"


def _download_model() -> None:
    os.makedirs(MODEL_DIR, exist_ok=True)
    for name in NEEDED_FILES:
        dest = os.path.join(MODEL_DIR, name)
        if os.path.exists(dest) and os.path.getsize(dest) > 0:
            continue
        url = f"{HF_ENDPOINT}/{MODEL_REPO}/resolve/main/{name}"
        print(f"[mt] 下载 {url}", flush=True)
        with requests.get(url, stream=True, timeout=120, allow_redirects=True) as resp:
            resp.raise_for_status()
            tmp = dest + ".part"
            with open(tmp, "wb") as f:
                for chunk in resp.iter_content(chunk_size=1 << 20):
                    if chunk:
                        f.write(chunk)
            os.replace(tmp, dest)


def _load_model() -> None:
    if not os.path.exists(os.path.join(MODEL_DIR, "model.bin")):
        _download_model()

    _state["translator"] = ctranslate2.Translator(MODEL_DIR, device=DEVICE, compute_type=COMPUTE_TYPE)

    if HF_TOKENIZER:
        from transformers import AutoTokenizer

        tokenizer = AutoTokenizer.from_pretrained(HF_TOKENIZER)
        # NLLB 的源语言标签由 tokenizer 的 src_lang 决定，编码时会放在句首
        if hasattr(tokenizer, "src_lang"):
            tokenizer.src_lang = SOURCE_CODE
        _state["tokenizer"] = tokenizer
    else:
        _state["sp_source"] = spm.SentencePieceProcessor(model_file=os.path.join(MODEL_DIR, "source.spm"))
        _state["sp_target"] = spm.SentencePieceProcessor(model_file=os.path.join(MODEL_DIR, "target.spm"))

    _state["ready"] = True
    print(f"[mt] 模型就绪: {MODEL_DIR} device={DEVICE} compute={COMPUTE_TYPE} beam={BEAM_SIZE}", flush=True)


@app.on_event("startup")
def _on_startup() -> None:
    def worker() -> None:
        _state["loading"] = True
        try:
            _load_model()
        except Exception as exc:  # noqa: BLE001
            _state["error"] = f"模型加载失败: {exc}"
            print(f"[mt] {_state['error']}", flush=True)
        finally:
            _state["loading"] = False

    threading.Thread(target=worker, daemon=True).start()


def _split(text: str) -> List[str]:
    text = text.strip()
    if len(text) <= SPLIT_THRESHOLD:
        return [text]

    # 依次尝试：句末标点 → 逗号 → 并列连词，直到每段都足够短
    parts = [p.strip() for p in re.split(r"(?<=[.!?;。！？；])\s*", text) if p.strip()]
    out: List[str] = []
    for part in parts:
        chunks = [part]
        if len(part) > SPLIT_THRESHOLD:
            chunks = [s.strip() for s in re.split(r"(?<=[,，])\s*", part) if s.strip()]
        for chunk in chunks:
            if len(chunk) <= SPLIT_THRESHOLD:
                out.append(chunk)
            else:
                out.extend(
                    s.strip()
                    for s in re.split(
                        r"\s+(?=(?:and|but|or|so|because|which|that|if|when|while)\s)",
                        chunk,
                        flags=re.IGNORECASE,
                    )
                    if s.strip()
                )
    return out or [text]


def _encode(texts: List[str]) -> List[List[str]]:
    # 关键点：源序列必须带句尾 </s>。
    # 少了它，编码器拿不到"句子结束"的信号，解码器会退化成复读输入（实测输出全是
    # "Hello Hello Hello…" 或 "( ( ( (…"）。
    tokenizer = _state["tokenizer"]
    if tokenizer is not None:
        return [tokenizer.convert_ids_to_tokens(tokenizer(text).input_ids) for text in texts]

    sp_src = _state["sp_source"]
    return [sp_src.encode(t, out_type=str) + ["</s>"] for t in texts]


def _decode(hypotheses: List[List[str]]) -> List[str]:
    tokenizer = _state["tokenizer"]
    if tokenizer is not None:
        outs = []
        for pieces in hypotheses:
            # 去掉语言标记、句尾符，以及没翻出来的 <unk>
            pieces = [
                p for p in pieces
                if p not in (SOURCE_CODE, TARGET_CODE, tokenizer.eos_token, "<unk>")
            ]
            outs.append(tokenizer.convert_tokens_to_string(pieces))
        return outs

    sp_tgt = _state["sp_target"]
    return [sp_tgt.decode(pieces) for pieces in hypotheses]


@app.get("/health")
def health():
    return {
        "ok": _state["error"] is None,
        "ready": _state["ready"],
        "loading": _state["loading"],
        "model": MODEL_REPO if not HF_TOKENIZER else HF_TOKENIZER,
        "device": DEVICE,
        "error": _state["error"],
    }


@app.post("/translate")
def translate(req: TranslateRequest):
    if not _state["ready"]:
        raise HTTPException(status_code=503, detail=_state["error"] or "模型尚未就绪")

    if req.texts:
        inputs = [t for t in req.texts if t and t.strip()]
    elif req.q:
        inputs = [req.q]
    else:
        raise HTTPException(status_code=400, detail="缺少 q 或 texts")

    # 逐条切句 → 拼成一个 batch，减少往返
    flat: List[str] = []
    spans: List[int] = []
    for text in inputs:
        pieces = _split(text)
        flat.extend(pieces)
        spans.append(len(pieces))

    if not flat:
        return {"translatedText": "", "translations": [], "model": MODEL_REPO}

    # 诊断用：打印实际进来的原文，便于确认识别链路是否正常工作
    if os.getenv("MT_LOG", "1") == "1":
        print(f"[mt] IN  {inputs}", flush=True)

    tokenized = _encode(flat)
    kwargs = {"max_batch_size": 16, "beam_size": BEAM_SIZE}
    if TARGET_CODE:
        kwargs["target_prefix"] = [[TARGET_CODE]] * len(tokenized)
    results = _state["translator"].translate_batch(tokenized, **kwargs)
    translated_flat = _decode([res.hypotheses[0] if res.hypotheses else [] for res in results])

    translations: List[str] = []
    cursor = 0
    for count in spans:
        translations.append("".join(translated_flat[cursor : cursor + count]))
        cursor += count

    if os.getenv("MT_LOG", "1") == "1":
        print(f"[mt] OUT {translations}", flush=True)

    return {
        "translatedText": translations[0] if translations else "",
        "translations": translations,
        "model": MODEL_REPO,
        "source": req.source,
        "target": req.target,
    }
