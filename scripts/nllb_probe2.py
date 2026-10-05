"""诊断 NLLB + CTranslate2 的正确调用方式（在翻译容器内执行）。"""

import json
import time

import ctranslate2
from transformers import AutoTokenizer

MODEL_DIR = "/opt/mt-model"
SRC = "eng_Latn"
TGT = "zho_Hans"
SENTENCES = [
    "After early nightfall the yellow lamps would light up here and there.",
    "Good morning everyone, thanks for joining the meeting today.",
    "The model runs entirely on your own machine, no internet required.",
]

vocab = json.load(open(f"{MODEL_DIR}/shared_vocabulary.json"))
print("ct2 词表大小:", len(vocab))
print("含 eng_Latn:", SRC in vocab, " 含 zho_Hans:", TGT in vocab)
print("zho_Hans 的 id:", vocab.index(TGT) if TGT in vocab else None)

tok = AutoTokenizer.from_pretrained("facebook/nllb-200-distilled-600M")
print("\n--- 未设 src_lang ---")
print(tok.convert_ids_to_tokens(tok(SENTENCES[0]).input_ids)[:12])
tok.src_lang = SRC
print("--- 设置 src_lang=eng_Latn ---")
print(tok.convert_ids_to_tokens(tok(SENTENCES[0]).input_ids)[:12])

translator = ctranslate2.Translator(MODEL_DIR, device="cpu", compute_type="int8")


def run(name, encode_fn, prefix):
    t0 = time.time()
    batches = [encode_fn(s) for s in SENTENCES]
    results = translator.translate_batch(
        batches,
        target_prefix=[prefix] * len(batches),
        beam_size=4,
        max_batch_size=8,
        max_decoding_length=128,
    )
    cost = time.time() - t0
    print(f"\n--- {name} ({cost:.2f}s / {len(SENTENCES)}句) ---")
    for res in results:
        pieces = res.hypotheses[0] if res.hypotheses else []
        pieces = [p for p in pieces if p not in (SRC, TGT)]
        print("  ZH:", tok.convert_tokens_to_string(pieces))


def enc_plain(text):
    ids = tok(text).input_ids
    return [t for t in tok.convert_ids_to_tokens(ids) if t != tok.eos_token]


def enc_with_lang(text):
    ids = tok(text).input_ids  # src_lang 已设置，开头自带源语言 token
    return [t for t in tok.convert_ids_to_tokens(ids) if t != tok.eos_token]


run("A 未设 src_lang + prefix zho_Hans", enc_plain, [TGT])
run("B 设 src_lang + prefix zho_Hans", enc_with_lang, [TGT])
