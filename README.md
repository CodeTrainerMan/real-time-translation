# Real-timeTranslation — 本地模型实时字幕

复刻 livecaption-windows（悬浮字幕 + 双语翻译），区别是：**语音识别只跑本地 Docker 里的模型，翻译走本地翻译服务，全程不出本机、不需要任何云的 Key**。

```
系统声音 / 麦克风  →  asr-service(Docker, sherpa-onnx)  →  mt-service(Docker, 翻译小模型)  →  悬浮字幕窗
```

## 目录

| 目录 | 作用 |
|---|---|
| `asr-service/` | 语音识别服务（sherpa-onnx 流式模型），默认英文，端口 **9901** |
| `mt-service/` | 翻译服务（CTranslate2，纯翻译小模型），端口 **9910** |
| `src/` | Electron 桌面应用（字幕悬浮窗 + 设置窗口） |
| `scripts/probe.mjs` | 端到端自测：把 wav 送进识别再翻译，不用开界面就能验证链路 |

## 一、启动两个服务

```bash
cd asr-service && docker compose up -d                        # 首次会下载英文模型（约 130MB）
cd mt-service  && docker compose -f docker-compose.nllb.yml up -d   # 翻译：NLLB-1.3B（用本机镜像，不联网）
```

> ⚠️ 翻译服务**不要**直接 `docker compose up -d`：那是 opus 兜底变体，译文质量明显差
> （数字和复合句都会翻错）。两个编排共用容器名 `realtime-translation-mt`，
> 谁后起谁生效 —— 起错了就会表现为"翻译突然变差"。

检查：

```bash
curl http://127.0.0.1:9910/health          # {"ready":true,...} 表示翻译模型已就绪
docker logs realtime-translation-asr-en | tail -5   # 看到 "Listening on: 9901" 即可
```

想识别中文音源时再起中文服务（端口 9902，模型更大）：

```bash
cd asr-service && docker compose --profile zh up -d
```

下载 HuggingFace 慢可换镜像站：`HF_ENDPOINT=https://hf-mirror.com docker compose up -d`。

## 二、跑端到端自测（不开界面）

```bash
node scripts/probe.mjs asr-service/models/sherpa-onnx-streaming-zipformer-en-2023-06-26/test_wavs/0.wav
```

正常会打印实时临时结果、定稿句子，以及对应的中文译文。

## 三、启动桌面应用

```bash
npm install
npm run dev
```

启动后字幕窗贴在屏幕底部居中：

- 工具条（鼠标移上去才显形）：设置 / 开始·暂停 / 清空 / 最小化 / 退出
- 默认采集**系统声音**（看英文视频、开会议都能出字幕），可在设置里切成麦克风
- 识别出的英文原文以小字显示，译文以大字显示（双语开关、字号、透明度都在设置里）

打包：`npm run dist`。

## 四、设置项

| 项 | 说明 |
|---|---|
| 音源 | 系统声音（回环采集，无需虚拟声卡）/ 麦克风 |
| 音源语言 / 目标语言 | 切换语言会自动切到对应的识别服务端口（英文 9901 / 中文 9902） |
| 开启翻译 / 双语字幕 | 关掉翻译就只显示识别原文 |
| 翻译后端 | 本地翻译小工具（Docker，默认）/ 本机 Ollama 大模型 / 不翻译 |
| 面板与字号 | 不透明度、高度、宽度占比、译文字号、原文字号、保留行数 |

设置保存在 `%APPDATA%/real-time-translation/settings.json`，窗口位置保存在同目录 `window.json`。

## 五、翻译后端怎么选

| 后端 | 体量 | 速度 | 质量 | 适合 |
|---|---|---|---|---|
| `local`（默认） | 3.4GB（NLLB-1.3B int8） | 0.6~1.1s/句 | 好 | 默认，不出本机、不需要显卡 |
| `ollama` | 1~5GB | 0.3~2s | 更高 | 追求译文自然，本机有显卡 |
| opus 变体 | 542MB | 几十 ms | 差（复读/漏译） | 仅无网兜底，别日常用 |

`local` 默认走 `docker-compose.nllb.yml`：NLLB-200-distilled-1.3B 转成的 CTranslate2 int8，
单句 0.6~1.1 秒。同一批句子的实测（5 句英文，字符级 BLEU）：

| 翻译服务 | BLEU | 单句耗时 | 长句 |
|---|---|---|---|
| opus（`docker-compose.yml`） | 16.1 | — | 后半句漏译、数字翻错 |
| NLLB-600M fp32 | 51.7 | 1.5~3.8s | 第 3 句漏了后半句 |
| **NLLB-1.3B int8（默认）** | **53.0** | **0.6~1.1s** | 完整 |

> `MT_SPLIT_THRESHOLD=60` 别调大：NLLB 对过长的输入会在中途吐结束符，
> 调到 120 时复合句会整从句丢掉。

用 Ollama：设置里后端选“本机 Ollama 大模型”，模型名填本机已有的模型（推荐
`hf.co/tencent/HY-MT1.5-1.8B-GGUF:Q4_K_M`，腾讯混元翻译模型，WMT25 冠军升级版；本机已有
`qwen2.5:7b` 也能直接用）。

## 六、协议备注（写客户端时用得上）

识别服务（WebSocket）：

| 方向 | 内容 |
|---|---|
| 客户端 → 服务端 | 二进制帧：**float32 小端、单声道、16kHz** 原始采样点（无 wav 头，任意分块） |
| 客户端 → 服务端 | 文本帧 `Done` = 音频结束 |
| 服务端 → 客户端 | JSON：`text` `segment` `is_final` `is_eof` … |
| 服务端 → 客户端 | 文本帧 `Done!`（带感叹号）= 本流结果推完 |

`is_final=false` 用于实时刷新半句，`is_final=true` 表示断句定稿（端点检测触发），此时才送去翻译。

翻译服务（HTTP）：`POST /translate {"q":"...","source":"en","target":"zh"}` → `{"translatedText":"..."}`，
字段名与 LibreTranslate 兼容。

## 七、常见问题

- **提示"无法连接识别服务"**：`docker ps` 看 `realtime-translation-asr-en` 是否在跑，日志是否出现 `Listening on: 9901`。
- **提示无法采集系统声音**：回环采集依赖 Chromium 的 `chromeMediaSource=desktop`，失败时会弹系统共享选择窗，选任意屏幕并勾上"共享系统音频"即可。
- **译文突然变差（复读、漏译）**：多半是翻译服务被 opus 变体顶掉了。
  `docker ps --filter name=realtime-translation-mt` 看镜像是不是 `realtime-translation-mt:nllb13b`，
  不是就重新 `cd mt-service && docker compose -f docker-compose.nllb.yml up -d`。
- **译文质量一般**：用 Ollama 后端（设置里选“本机 Ollama 大模型”）会更自然，代价是每句 0.3~2 秒。
- **字幕断句太碎/太长**：优先调设置里的"断句停顿"（`segmentPauseMs`，默认 1800ms，越小换行越快）。
  服务端那个 `ASR_TRAILING_SILENCE`（默认 2.0 秒）**别调小**：实测 1.2 / 1.6 秒会把句子从中间切断，
  句号还会单独成一行，1.6 秒甚至丢整句；它只管"服务端判说完一句"，日常换行靠应用侧兜底。
