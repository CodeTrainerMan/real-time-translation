"""临时接管 9901 端口，把客户端（应用）推过来的音频原样录下来。

用法：python scripts/record_server.py 9901
"""
import asyncio
import sys
import time

import websockets

OUT = r"E:/SY/project/Real-timeTranslation/.build-logs/capture-raw.f32"
START = time.time()


async def handler(ws):
    print(f"{time.time() - START:7.2f} connected from {ws.remote_address}", flush=True)
    total = 0
    frames = 0
    try:
        with open(OUT, "wb") as f:
            async for msg in ws:
                if isinstance(msg, (bytes, bytearray)):
                    f.write(msg)
                    total += len(msg)
                    frames += 1
                else:
                    print(f"{time.time() - START:7.2f} text: {str(msg)[:40]}", flush=True)
    except Exception as exc:  # noqa: BLE001
        print(f"{time.time() - START:7.2f} recv error: {exc}", flush=True)
    print(f"{time.time() - START:7.2f} closed frames={frames} bytes={total}", flush=True)


async def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 9901
    async with websockets.serve(handler, "0.0.0.0", port, max_size=None, ping_interval=None):
        print("recording on", port, flush=True)
        await asyncio.sleep(120)


if __name__ == "__main__":
    asyncio.run(main())
