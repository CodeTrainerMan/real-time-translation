"""在翻译容器里实测 NLLB 的正确调用方式（源语言标签怎么加）。

用法：Get-Content scripts/nllb_probe.py | docker exec -i realtime-translation-mt python -
"""

import time

import ctranslate2
import sentencepiece as spm

MODEL_DIR = "/models/nllb-600m-ct2-int8"
SRC = "eng_Latn"
TGT = "zho_Hans"

SENTENCES = [
    "After early nightfall the yellow lamps would light up here and there.",
    "Good morning everyone, thanks for joining the meeting today.",
    "The model runs entirely on your own machine, no internet required.",
]

sp = spm.SentencePieceProcessor(model_file=f"{MODEL_DIR}/sentencepiece.bpe.model")
print("spm 词表大小:", sp.get_piece_size())
print("PieceToId(eng_Latn) =", sp.PieceToId(SRC))
print("PieceToId(zho_Hans) =", sp.PieceToId(TGT))
print("encode('eng_Latn') =", sp.encode("eng_Latn", out_type=str))

t0 = time.time()
translator = ctranslate2.Translator(MODEL_DIR, device="cpu", compute_type="int8")
print(f"加载耗时 {time.time() - t0:.1f}s")


def run(name, encode_fn, prefix, strip_first=False):
    t0 = time.time()
    batches = [encode_fn(s) for s in SENTENCES]
    results = translator.translate_batch(
        batches,
        target_prefix=[prefix] * len(batches),
        beam_size=4,
        max_batch_size=8,
        max_decoding_length=96,
    )
    cost = time.time() - t0
    outs = []
    for res in results:
        pieces = res.hypotheses[0] if res.hypotheses else []
        if strip_first and pieces and pieces[0] in (SRC, TGT):
            pieces = pieces[1:]
        pieces = [p for p in pieces if p not in (SRC, TGT)]
        outs.append(sp.decode(pieces))
    print(f"\n--- {name}  ({cost:.2f}s / {len(SENTENCES)}句) ---")
    for src, out in zip(SENTENCES, outs):
        print(f"  EN: {src}\n  ZH: {out}")


run("A 纯文本 + target_prefix", lambda s: sp.encode(s, out_type=str), [TGT])
run("B 源语言 token 前缀 + target_prefix", lambda s: [SRC] + sp.encode(s, out_type=str), [TGT])
run("C 源语言当普通词拼进文本", lambda s: sp.encode(f"{SRC} {s}", out_type=str), [TGT])
run("D 纯文本 + target_prefix + 去首 token", lambda s: sp.encode(s, out_type=str), [TGT], strip_first=True)
