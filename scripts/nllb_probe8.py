"""用解码参数治"漏译后半句"：coverage_penalty / min_decoding_length。"""

import ctranslate2
from transformers import AutoTokenizer

MODEL_DIR = "/opt/mt-model"
tok = AutoTokenizer.from_pretrained("/opt/mt-model/tokenizer")
tok.src_lang = "eng_Latn"

tr = ctranslate2.Translator(MODEL_DIR, device="cpu", compute_type="int8")

SENTENCES = [
    "So basically I want to capture the system audio and show subtitles on screen.",
    "After early nightfall the yellow lamps would light up here and there, the squalid quarter of the brothels.",
    "We are going to walk through the architecture, then look at some benchmarks, and finally answer questions.",
    "Good morning everyone, thanks for joining the meeting today.",
]
batches = [tok.convert_ids_to_tokens(tok(s).input_ids) for s in SENTENCES]


def run(name, **kw):
    res = tr.translate_batch(batches, target_prefix=[["zho_Hans"]] * len(batches), **kw)
    print(f"\n=== {name} ===")
    for src, r in zip(SENTENCES, res):
        pieces = [p for p in r.hypotheses[0] if p not in ("zho_Hans", "</s>")]
        print("  →", tok.convert_tokens_to_string(pieces))
        print("     (原文词数 %d, 译文 token 数 %d)" % (len(src.split()), len(pieces)))


run("baseline beam4", beam_size=4)
run("coverage_penalty=0.2", beam_size=4, coverage_penalty=0.2)
run("coverage=0.2 + min_len=12", beam_size=4, coverage_penalty=0.2, min_decoding_length=12)
run("coverage=0.5", beam_size=4, coverage_penalty=0.5)
