"""验证：NLLB 的源序列必须带 </s>，目标序列开头用语言标签。"""

import time

import ctranslate2
from transformers import AutoTokenizer

MODEL_DIR = "/opt/mt-model"
tok = AutoTokenizer.from_pretrained("facebook/nllb-200-distilled-600M")
tok.src_lang = "eng_Latn"

SENTENCES = [
    "Hello world.",
    "After early nightfall the yellow lamps would light up here and there.",
    "Good morning everyone, thanks for joining the meeting today.",
    "The model runs entirely on your own machine, no internet required.",
    "So basically I want to capture the system audio and show subtitles.",
]

translator = ctranslate2.Translator(MODEL_DIR, device="cpu", compute_type="int8")


def enc(text, keep_eos):
    ids = tok(text).input_ids
    tokens = tok.convert_ids_to_tokens(ids)
    if not keep_eos:
        tokens = [t for t in tokens if t != tok.eos_token]
    return tokens


for keep_eos in (True, False):
    batches = [enc(s, keep_eos) for s in SENTENCES]
    if keep_eos:
        print("示例 source tokens:", batches[0])
    t0 = time.time()
    results = translator.translate_batch(
        batches,
        target_prefix=[["zho_Hans"]] * len(batches),
        beam_size=4,
        max_batch_size=8,
        max_decoding_length=128,
    )
    cost = time.time() - t0
    print(f"\n=== keep_eos={keep_eos}  ({cost:.2f}s / {len(SENTENCES)}句) ===")
    for src, res in zip(SENTENCES, results):
        pieces = res.hypotheses[0] if res.hypotheses else []
        pieces = [p for p in pieces if p not in ("zho_Hans", "eng_Latn")]
        print(f"  EN: {src}")
        print(f"  ZH: {tok.convert_tokens_to_string(pieces)}")
