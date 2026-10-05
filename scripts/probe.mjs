/**
 * 端到端自测：把一个 wav 文件送给本地识别服务，再把识别结果送给翻译服务。
 *
 * 用法：
 *   node scripts/probe.mjs <音频.wav> [--asr=ws://127.0.0.1:9901] [--mt=http://127.0.0.1:9910]
 *
 * 例（用英文模型自带的测试音频）：
 *   node scripts/probe.mjs asr-service/models/sherpa-onnx-streaming-zipformer-en-2023-06-26/test_wavs/0.wav
 */

import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const wavPath = args.find((a) => !a.startsWith('--'))
const asrUrl = argValue('--asr') ?? 'ws://127.0.0.1:9901'
const mtUrl = argValue('--mt') ?? 'http://127.0.0.1:9910'

function argValue(name) {
  const hit = args.find((a) => a.startsWith(`${name}=`))
  return hit ? hit.slice(name.length + 1) : undefined
}

/** 解析 wav（支持 16bit PCM），返回 16kHz 单声道的 Int16 采样点 */
function readWav(path) {
  const buf = readFileSync(path)
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('不是 wav 文件')

  let offset = 12
  let sampleRate = 16000
  let channels = 1
  let bitsPerSample = 16
  let data = null

  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      const audioFormat = buf.readUInt16LE(body)
      if (audioFormat !== 1) throw new Error(`仅支持 PCM wav，当前 format=${audioFormat}`)
      channels = buf.readUInt16LE(body + 2)
      sampleRate = buf.readUInt32LE(body + 4)
      bitsPerSample = buf.readUInt16LE(body + 14)
    } else if (id === 'data') {
      data = buf.subarray(body, body + size)
      break
    }
    offset = body + size + (size % 2)
  }
  if (!data) throw new Error('wav 缺少 data 块')
  if (bitsPerSample !== 16) throw new Error(`仅支持 16bit，当前 ${bitsPerSample}bit`)

  const total = data.length / 2
  const raw = new Int16Array(total)
  for (let i = 0; i < total; i += 1) raw[i] = data.readInt16LE(i * 2)

  // 混成单声道
  const frames = total / channels
  let mono = new Int16Array(frames)
  for (let f = 0; f < frames; f += 1) {
    let sum = 0
    for (let c = 0; c < channels; c += 1) sum += raw[f * channels + c]
    mono[f] = Math.max(-32768, Math.min(32767, Math.round(sum / channels)))
  }

  // 重采样到 16kHz（线性插值）
  if (sampleRate !== 16000) {
    const ratio = sampleRate / 16000
    const outLength = Math.floor(frames / ratio)
    const resampled = new Int16Array(outLength)
    for (let i = 0; i < outLength; i += 1) {
      const pos = i * ratio
      const left = Math.floor(pos)
      const frac = pos - left
      const a = mono[left] ?? 0
      const b = mono[left + 1] ?? a
      resampled[i] = Math.round(a * (1 - frac) + b * frac)
    }
    mono = resampled
    console.log(`[probe] 重采样 ${sampleRate}Hz → 16000Hz`)
  }
  return mono
}

async function recognize(pcm) {
  const ws = new WebSocket(asrUrl)
  const started = Date.now()
  const finals = []

  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = () => reject(new Error(`无法连接识别服务 ${asrUrl}`))
  })

  let pendingResolve
  const done = new Promise((resolve) => {
    pendingResolve = resolve
  })

  ws.onmessage = (event) => {
    if (typeof event.data !== 'string') return
    if (event.data === 'Done!') {
      pendingResolve()
      return
    }
    let msg
    try {
      msg = JSON.parse(event.data)
    } catch {
      return
    }
    const text = (msg.text || '').trim()
    if (!text) return
    if (msg.is_final) {
      finals.push(text)
      console.log(`[+${String(Date.now() - started).padStart(5)}ms] 定稿：${text}`)
    } else {
      process.stdout.write(`\r[+${String(Date.now() - started).padStart(5)}ms] 临时：${text}   `)
    }
  }

  // 按 100ms 一块发送 float32
  const chunk = 1600
  for (let i = 0; i < pcm.length; i += chunk) {
    const slice = pcm.subarray(i, Math.min(i + chunk, pcm.length))
    const float32 = new Float32Array(slice.length)
    for (let j = 0; j < slice.length; j += 1) float32[j] = slice[j] / 32768
    ws.send(float32.buffer)
  }
  ws.send('Done')

  await done
  ws.close()
  return finals.join(' ')
}

async function translate(text) {
  if (!text) return ''
  const response = await fetch(`${mtUrl.replace(/\/$/, '')}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: text, source: 'en', target: 'zh' })
  })
  if (!response.ok) throw new Error(`翻译服务返回 ${response.status}`)
  const data = await response.json()
  return data.translatedText ?? ''
}

if (!wavPath) {
  console.error('用法：node scripts/probe.mjs <音频.wav> [--asr=ws://127.0.0.1:9901] [--mt=http://127.0.0.1:9910]')
  process.exit(1)
}

const pcm = readWav(wavPath)
console.log(`[probe] 音频 ${wavPath}（${(pcm.length / 16000).toFixed(1)}s @16kHz）`)
const text = await recognize(pcm)
const translated = await translate(text)

// --json：给批量准确率脚本用，避免解析带中文的日志行
if (args.includes('--json')) {
  console.log(`__RESULT__${JSON.stringify({ text, translated })}`)
} else {
  console.log(`\n[probe] 识别结果：${text}`)
  console.log(`[probe] 翻译结果：${translated}`)
}
