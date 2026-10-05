"""看解码器原始输出：到底生成了哪些 token、在哪一步停的。"""

import ctranslate2
from transformers import AutoTokenizer

MODEL_DIR = "/opt/mt-model"
tok = AutoTokenizer.from_pretrained("/opt/mt-model/tokenizer")
tok.src_lang = "eng_Latn"

tr = ctranslate2.Translator(MODEL_DIR, device="cpu", compute_type="int8")

for text in (
    "So basically I want to capture the system audio and show subtitles on screen.",
    "After early nightfall the yellow lamps would light up here and there, the squalid quarter of the brothels.",
):
    ids = tok(text).input_ids
    tokens = tok.convert_ids_to_tokens(ids)
    print("\n原文:", text)
    print("源 tokens:", tokens)
    res = tr.translate_batch([tokens], target_prefix=[["zho_Hans"]], beam_size=4)[0]
    print("输出 token 数:", len(res.hypotheses[0]))
    print("原始 pieces:", res.hypotheses[0])
    # 用 greedy 多解码一步看看后面本来要说什么
    greedy = tr.translate_batch(
        [tokens], target_prefix=[["zho_Hans"]], beam_size=1, max_decoding_length=200,
        return_alternatives=False,
    )[0]
    print("greedy 原始:", greedy.hypotheses[0])
    print("greedy 文本:", tok.convert_tokens_to_string(greedy.hypotheses[0]))
