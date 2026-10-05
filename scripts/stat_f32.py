"""统计 float32 原始音频的电平，并转成 16bit wav 以便离线识别。

用法：python scripts/stat_f32.py <input.f32> [output.wav]
"""
import math
import struct
import sys
import wave

path = sys.argv[1] if len(sys.argv) > 1 else r".build-logs\capture-raw.f32"
wav_out = sys.argv[2] if len(sys.argv) > 2 else r".build-logs\capture-from-app.wav"

raw = open(path, "rb").read()
n = len(raw) // 4
vals = struct.unpack("<%df" % n, raw[: n * 4]) if n else ()
secs = n / 16000
if n:
    rms = math.sqrt(sum(v * v for v in vals) / n)
    peak = max(abs(v) for v in vals)
    win = 1600
    tot = 0
    sil = 0
    for i in range(0, n - win, win):
        tot += 1
        m = max(abs(v) for v in vals[i : i + win])
        if m < 0.01:
            sil += 1
    silent_pct = 100 * sil // max(tot, 1)
else:
    rms = peak = 0.0
    silent_pct = -1

print(f"file={path} duration={secs:.2f}s rms={rms:.5f} peak={peak:.4f} silent={silent_pct}%")

if n:
    w = wave.open(wav_out, "wb")
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(16000)
    w.writeframes(struct.pack("<%dh" % n, *[max(-32768, min(32767, int(v * 32767))) for v in vals]))
    w.close()
    print("wrote " + wav_out)
