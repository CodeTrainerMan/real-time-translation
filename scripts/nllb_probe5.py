"""排查译文截断：对比 beam / length_penalty / coverage_penalty。"""

import time

import ctranslate2
from transformers import AutoTokenizer

MODEL_DIR = "/opt/mt-model"
tok = AutoTokenizer.from_pretrained("/opt/mt-model/tokenizer")
tok.src_lang = "eng_Latn"

LONG = (
    "After early nightfall the yellow lamps would light up here and there, "
    "the squalid quarter of the brothels."
)
SENTENCES = [
    LONG,
    "So basically I want to capture the system audio and show subtitles on screen.",
    "We are going to walk through the architecture, then look at some benchmarks, and finally answer questions.",
]

translator = ctranslate2.Translator(MODEL_DIR, device="cpu", compute_type="int8")
batches = [tok.convert_ids_to_tokens(tok(s).input_ids) for s in SENTENCES]


def run(name, **kwargs):
    t0 = time.time()
    results = translator.translate_batch(
        batches, target_prefix=[["zho_Hans"]] * len(batches), **kwargs
    )
    cost = time.time() - t0
    print(f"\n=== {name} ({cost:.2f}s) ===")
    for src, res in zip(SENTENCES, results):
        pieces = [p for p in res.hypotheses[0] if p not in ("zho_Hans", "eng_Latn", "</s>")]
        print("  ZH:", tok.convert_tokens_to_string(pieces))
        print("     原文词数:", len(src.split()))


run("beam1 greedy", beam_size=1, max_decoding_length=200)
run("beam4 默认", beam_size=4, max_decoding_length=200)
run("beam4 length_penalty=0.6", beam_size=4, max_decoding_length=200, length_penalty=0.6)
run("beam4 coverage=0.2", beam_size=4, max_decoding_length=200, coverage_penalty=0.2)
