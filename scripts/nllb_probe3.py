"""最底层探测：极短句、不同 prefix / beam，看 NLLB int8 到底哪里不对。"""

import ctranslate2
from transformers import AutoTokenizer

MODEL_DIR = "/opt/mt-model"
tok = AutoTokenizer.from_pretrained("facebook/nllb-200-distilled-600M")
tok.src_lang = "eng_Latn"

translator = ctranslate2.Translator(MODEL_DIR, device="cpu", compute_type="int8")

text = "Hello world."
ids = tok(text).input_ids
tokens = [t for t in tok.convert_ids_to_tokens(ids) if t != tok.eos_token]
print("source tokens:", tokens)


def try_one(name, **kwargs):
    res = translator.translate_batch([tokens], **kwargs)[0]
    pieces = res.hypotheses[0] if res.hypotheses else []
    print(f"{name}: raw={pieces[:16]}")
    print(f"    → {tok.convert_tokens_to_string(pieces)!r}")
    print(f"    score={res.scores[0] if res.scores else None}")


try_one("无 prefix, beam1", beam_size=1, max_decoding_length=32)
try_one("prefix zho_Hans, beam1", target_prefix=[["zho_Hans"]], beam_size=1, max_decoding_length=32)
try_one("prefix zho_Hans, beam4", target_prefix=[["zho_Hans"]], beam_size=4, max_decoding_length=32)
try_one("prefix 反向(eng_Latn)", target_prefix=[["eng_Latn"]], beam_size=1, max_decoding_length=32)
