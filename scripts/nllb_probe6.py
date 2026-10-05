"""定位截断：单条 vs 批量、int8 vs int8_float16。"""

import ctranslate2
from transformers import AutoTokenizer

MODEL_DIR = "/opt/mt-model"
tok = AutoTokenizer.from_pretrained("/opt/mt-model/tokenizer")
tok.src_lang = "eng_Latn"

LONG = "So basically I want to capture the system audio and show subtitles on screen."
SHORT = "Hello world."


def enc(text):
    return tok.convert_ids_to_tokens(tok(text).input_ids)


def show(tag, res):
    pieces = [p for p in res.hypotheses[0] if p not in ("zho_Hans", "</s>")]
    print(f"  {tag}: {tok.convert_tokens_to_string(pieces)}")


for compute in ("int8", "int8_float16"):
    tr = ctranslate2.Translator(MODEL_DIR, device="cpu", compute_type=compute)
    print(f"\n### compute_type={compute}")
    r = tr.translate_batch([enc(LONG)], target_prefix=[["zho_Hans"]], beam_size=4)[0]
    show("单条长句", r)
    r = tr.translate_batch([enc(SHORT)], target_prefix=[["zho_Hans"]], beam_size=4)[0]
    show("单条短句", r)
    batch = [enc(LONG), enc(SHORT)]
    res = tr.translate_batch(batch, target_prefix=[["zho_Hans"]] * 2, beam_size=4)
    show("批量-长句", res[0])
    show("批量-短句", res[1])
