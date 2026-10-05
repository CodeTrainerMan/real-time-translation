"""把 16bit PCM wav 按峰值归一化，用来验证"音量偏低"对识别的影响（标准库实现）。"""
import sys
import wave
import array

src, dst, target = sys.argv[1], sys.argv[2], float(sys.argv[3])

with wave.open(src, "rb") as w:
    params = w.getparams()
    data = array.array("h")
    data.frombytes(w.readframes(w.getnframes()))

peak = max(abs(v) for v in data) or 1
gain = (target * 32767) / peak

out = array.array("h", (int(max(-32768, min(32767, v * gain))) for v in data))

with wave.open(dst, "wb") as w:
    w.setnchannels(params.nchannels)
    w.setsampwidth(params.sampwidth)
    w.setframerate(params.framerate)
    w.writeframes(out.tobytes())

print(f"peak={peak} gain={gain:.2f} -> {dst}")
