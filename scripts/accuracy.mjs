/**
 * 准确率测试：识别用词错误率（WER），翻译用 BLEU（中文按字）。
 *
 * 用法：
 *   node scripts/accuracy.mjs offline   # 离线送音频给识别服务（引擎理论上限）
 *   node scripts/accuracy.mjs e2e       # 播放音频走系统声音 → 开发态应用 → 抓 dev.out（端到端）
 *   node scripts/accuracy.mjs logs      # 播放音频 → 任意应用（含打包版）→ 抓翻译容器日志（端到端）
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'

const DIR = '.build-logs/acctest'
const IDS = ['01', '02', '03', '04', '05']
const MODE = process.argv[2] ?? 'offline'

/** 测试集的标准答案译文，用来算 BLEU */
const REF_ZH = {
  '01': '大家好，欢迎参加今天的会议。',
  '02': '火车七点四十五分发车，九点三十分到达。',
  '03': '微软上个月在西雅图发布了 Windows 的新版本。',
  '04': '人工智能正在改变我们的工作和沟通方式。',
  '05': '尽管天气很糟糕，我们还是决定继续我们的旅程。'
}

// ---------- 指标 ----------

/** 归一化：转小写，标点换空格，压掉多余空格 */
function normalize(s) {
  return s.toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').replace(/\s+/g, ' ').trim()
}
function words(s) {
  return normalize(s).split(' ').filter(Boolean)
}
/** 词级编辑距离 / 参考答案词数 */
function wer(ref, hyp) {
  const r = words(ref)
  const h = words(hyp)
  if (!r.length) return 0
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...new Array(h.length).fill(0)])
  for (let j = 0; j <= h.length; j += 1) d[0][j] = j
  for (let i = 1; i <= r.length; i += 1) {
    for (let j = 1; j <= h.length; j += 1) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1))
    }
  }
  return d[r.length][h.length] / r.length
}

function ngrams(list, n) {
  const out = []
  for (let i = 0; i + n <= list.length; i += 1) out.push(list.slice(i, i + n).join(''))
  return out
}
/** 中文按字的 BLEU，n 取到 4，带长度惩罚 */
function bleu(ref, hyp) {
  const r = ref.replace(/[\s\p{P}]/gu, '').split('')
  const h = hyp.replace(/[\s\p{P}]/gu, '').split('')
  if (!h.length || !r.length) return 0
  let sum = 0
  for (let n = 1; n <= 4; n += 1) {
    const hc = ngrams(h, n)
    if (!hc.length) return 0
    const pool = new Map()
    for (const g of ngrams(r, n)) pool.set(g, (pool.get(g) ?? 0) + 1)
    let match = 0
    for (const g of hc) {
      const left = pool.get(g) ?? 0
      if (left > 0) {
        pool.set(g, left - 1)
        match += 1
      }
    }
    sum += Math.log(match / hc.length || 1e-10)
  }
  const bp = h.length >= r.length ? 1 : Math.exp(1 - r.length / h.length)
  return bp * Math.exp(sum / 4)
}

// ---------- 两种取数方式 ----------

function offline(id) {
  const r = spawnSync(process.execPath, ['scripts/probe.mjs', `${DIR}/${id}.wav`, '--json'], {
    encoding: 'utf8',
    maxBuffer: 1 << 24
  })
  const line = (r.stdout ?? '').split('\n').reverse().find((l) => l.startsWith('__RESULT__'))
  if (!line) return { asr: '', mt: '' }
  const { text, translated } = JSON.parse(line.slice('__RESULT__'.length))
  return { asr: text ?? '', mt: translated ?? '' }
}

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 24 })
}

const DEV_OUT = '.build-logs/dev.out'

/** 应用定稿一行字幕就会打一条 [caption]，字幕面板显示的就是这些行 */
function readCaptions() {
  const txt = readFileSync(DEV_OUT, 'utf8')
  return txt
    .split('\n')
    .filter((l) => l.includes('[caption]'))
    .map((l) => l.slice(l.indexOf('[caption]') + '[caption]'.length).replace(/\u001b\[\d+m/g, '').trim())
}

async function translateText(text) {
  if (!text) return ''
  const r = await fetch('http://127.0.0.1:9910/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: text, source: 'en', target: 'zh' })
  })
  const d = await r.json()
  return d.translatedText ?? ''
}

/** 播放音频，取这段时间应用真正定稿到字幕面板上的行 */
async function e2e(id) {
  const before = readCaptions().length
  run('powershell', [
    '-NoProfile',
    '-Command',
    `$p=New-Object System.Media.SoundPlayer; $p.SoundLocation=(Resolve-Path "${DIR}/${id}.wav").Path; $p.Load(); $p.PlaySync()`
  ])
  // 播放结束后再等一会儿，识别是流式的，尾巴要时间收口
  execFileSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 7'])
  const asr = readCaptions().slice(before).join(' ').trim()
  return { asr, mt: await translateText(asr) }
}

/** 旧办法：从翻译服务日志还原（含应用中间草稿，会低估准确率），保留备查 */
async function e2eViaMtLogs(id) {
  const startIso = new Date(Date.now() - 1000).toISOString()
  run('powershell', [
    '-NoProfile',
    '-Command',
    `$p=New-Object System.Media.SoundPlayer; $p.SoundLocation=(Resolve-Path "${DIR}/${id}.wav").Path; $p.Load(); $p.PlaySync()`
  ])
  execFileSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 7'])
  // MT_LOG_FILE 指向本地中转探针的日志时（量打包版用），从文件读；否则从容器日志读
  const raw = process.env.MT_LOG_FILE
    ? readFileSync(process.env.MT_LOG_FILE, 'utf8')
    : run('docker', ['logs', '-t', '--since', startIso, 'realtime-translation-mt'])
  const since = Date.parse(startIso)
  const events = []
  for (const line of raw.split('\n')) {
    const m = /^(\d{4}-\d{2}-\d{2}T\S+)\s+\[mt\]\s+(IN|OUT)\s+\['(.*)'\]/.exec(line.trim())
    if (!m) continue
    if (process.env.MT_LOG_FILE && Date.parse(m[1]) < since) continue
    events.push({ t: Date.parse(m[1]), kind: m[2], text: m[3] })
  }
  // 流式结果是一串互相重叠的快照，例如：
  //   "Hello everyone" → "everyone" → "everyone, welcome to today's meeting" → "meeting" → "."
  // 直接拼接会重复堆叠，按时间分组取最长又会丢掉前面的整段。
  // 正确做法：沿序列跟踪"当前这句"，新文本是当前句的增长就延长它，
  // 已经被当前句包含的碎片（端点打断留下的尾巴）直接丢掉，
  // 都不满足就说明换了新的一句。
  const collapse = (kind) => {
    const texts = events.filter((e) => e.kind === kind).map((e) => e.text)
    const kept = []
    let current = ''
    for (const t of texts) {
      if (!current) {
        current = t
        continue
      }
      if (t.startsWith(current)) {
        current = t // 同一句还在变长
        continue
      }
      if (current.includes(t)) continue // 已包含在内的碎片，丢弃
      kept.push(current)
      current = t
    }
    if (current) kept.push(current)
    return kept.join(' ').trim()
  }
  const asr = collapse('IN')
  const appMt = collapse('OUT')
  // 与 e2e 口径一致：把定稿整句单独送一次翻译。
  // 应用在运行中会把流式草稿也送去翻译，那些重叠请求会把 BLEU 压得很低，
  // 但它们不是屏幕上最终显示的那一句，不能拿来和开发态口径比
  const mt = await translateText(asr)
  return { asr, mt, appMt }
}

void e2eViaMtLogs

// ---------- 主流程 ----------

const MODES = {
  offline,
  e2e,
  logs: e2eViaMtLogs
}
const MODE_LABEL = {
  offline: '离线（音频直送服务）',
  e2e: '端到端（播放 → 开发态应用）',
  logs: '端到端（播放 → 应用，抓容器日志）'
}
const pick = MODES[MODE] ?? offline

const rows = []
for (const id of IDS) {
  const ref = readFileSync(`${DIR}/${id}.txt`, 'utf8').trim()
  const { asr, mt, appMt } = await pick(id)
  rows.push({
    id,
    ref,
    asr,
    mt,
    appMt: appMt ?? '',
    wer: wer(ref, asr),
    bleu: bleu(REF_ZH[id], mt)
  })
}

console.log(`\n===== ${MODE_LABEL[MODE] ?? MODE} =====`)
for (const r of rows) {
  console.log(`\n[${r.id}] WER ${(r.wer * 100).toFixed(1)}%   BLEU ${(r.bleu * 100).toFixed(1)}`)
  console.log(`  标准答案 : ${r.ref}`)
  console.log(`  识别结果 : ${r.asr}`)
  console.log(`  标准译文 : ${REF_ZH[r.id]}`)
  console.log(`  翻译结果 : ${r.mt}`)
  if (r.appMt) console.log(`  应用译文 : ${r.appMt}`)
}
const avgWer = rows.reduce((s, r) => s + r.wer, 0) / rows.length
const avgBleu = rows.reduce((s, r) => s + r.bleu, 0) / rows.length
console.log(`\n平均：WER ${(avgWer * 100).toFixed(1)}%（准确率 ${((1 - avgWer) * 100).toFixed(1)}%）  BLEU ${(avgBleu * 100).toFixed(1)}`)

writeFileSync(`${DIR}/${MODE}.json`, JSON.stringify(rows, null, 2), 'utf8')
