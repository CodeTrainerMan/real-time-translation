/**
 * 识别服务"僵尸流"压力测试。
 *
 * 用法：node scripts/soak-test.mjs --asr=ws://127.0.0.1:9904 --mode=abrupt --rounds=6
 *
 * 先反复「连接 → 推一小段音频 → 关闭」若干轮，再用一条新连接推完整音频，
 * 看服务还认不认得出东西。abrupt（发完 Done 立刻关）与 graceful（等服务端
 * 回 Done! 再关）两种关闭方式对比，用来判断僵尸流是不是服务端逐渐不响应的原因。
 */
import fs from 'node:fs'

const wavPath = process.argv[2] || '.build-logs/loopback.wav'
const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`))
  return hit ? hit.slice(k.length + 3) : d
}
const url = arg('asr', 'ws://127.0.0.1:9901')
const mode = arg('mode', 'abrupt')
const rounds = Number(arg('rounds', '6'))

function readWav(path) {
  const buf = fs.readFileSync(path)
  // 简单解析：找 data chunk
  let off = 12
  let fmt = null
  let data = null
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ' && !fmt) fmt = buf.subarray(off + 8, off + 8 + size)
    if (id === 'data' && !data) data = buf.subarray(off + 8, off + 8 + size)
    off += 8 + size + (size % 2)
  }
  const channels = fmt ? fmt.readUInt16LE(2) : 1
  const rate = fmt ? fmt.readUInt32LE(4) : 16000
  const int16 = new Int16Array(data.buffer, data.byteOffset, Math.floor(data.length / 2))
  const n = Math.floor(int16.length / channels)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i += 1) out[i] = int16[i * channels] / 32768
  return { pcm: out, rate }
}

const { pcm, rate } = readWav(wavPath)
const chunk = Math.round(rate * 0.1) // 100ms

function push(ws, from, to, stepMs = 100) {
  return new Promise((resolve) => {
    let i = from
    const timer = setInterval(() => {
      if (i >= to || ws.readyState !== WebSocket.OPEN) {
        clearInterval(timer)
        resolve()
        return
      }
      const slice = pcm.subarray(i, Math.min(i + chunk, to))
      ws.send(slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength))
      i += chunk
    }, stepMs)
  })
}

function collect(ws, ms) {
  const texts = []
  const onMsg = (e) => {
    if (typeof e.data !== 'string') return
    if (e.data === 'Done!') return
    try {
      const j = JSON.parse(e.data)
      if (j.text) texts.push(j.text)
    } catch {}
  }
  ws.addEventListener('message', onMsg)
  return new Promise((resolve) =>
    setTimeout(() => {
      ws.removeEventListener('message', onMsg)
      resolve(texts)
    }, ms)
  )
}

function closeGraceful(ws) {
  return new Promise((resolve) => {
    let closed = false
    const finish = () => {
      if (closed) return
      closed = true
      try {
        ws.close()
      } catch {}
      resolve()
    }
    const onMsg = (e) => {
      if (typeof e.data === 'string' && e.data === 'Done!') finish()
    }
    ws.addEventListener('message', onMsg)
    try {
      ws.send('Done')
    } catch {
      finish()
      return
    }
    setTimeout(finish, 1500)
  })
}

function open(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.onopen = () => resolve(ws)
    ws.onerror = () => reject(new Error('连接失败'))
  })
}

async function run() {
  console.log(`[soak] 目标 ${url} 模式 ${mode} 轮数 ${rounds} 音频 ${wavPath}`)
  const seconds = Math.min(2, pcm.length / rate)
  for (let r = 1; r <= rounds; r += 1) {
    const ws = await open(url)
    const to = Math.round(rate * seconds)
    await push(ws, 0, to)
    if (mode === 'graceful') {
      await closeGraceful(ws)
    } else {
      try {
        ws.send('Done')
      } catch {}
      try {
        ws.close()
      } catch {}
    }
    process.stdout.write(`[soak] 第 ${r} 轮关闭完成\r\n`)
  }

  // 验证轮：新连接推完整音频，看还有没有结果
  const ws = await open(url)
  const p = collect(ws, 6000)
  await push(ws, 0, pcm.length)
  const texts = await p
  if (mode === 'graceful') await closeGraceful(ws)
  else {
    try {
      ws.send('Done')
      ws.close()
    } catch {}
  }
  const last = texts[texts.length - 1] || '(空)'
  console.log(`[soak] 结果条数=${texts.length} 最后一条="${last}"`)
  console.log(texts.length ? '[soak] 判定：服务仍正常' : '[soak] 判定：服务已停止响应（僵尸流堆积）')
}

run().catch((e) => console.log('[soak] FAILED ' + e.message))
