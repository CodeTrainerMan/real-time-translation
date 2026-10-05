/**
 * ASR 输出的大小写恢复（truecasing）。
 *
 * sherpa-onnx 的英文流式模型（zipformer）词表里只有大写字母，
 * 识别结果天然是 "HELLO WORLD" 这种全大写形式，直接展示既难看、
 * 又会让下游翻译模型（对大小写敏感）质量下降。
 *
 * 这里做一层轻量恢复：
 *   - 整句全大写才处理，已经含小写的不动（避免破坏正常文本）
 *   - 句首、I / I'm 等第一人称，以及常见专名缩写按规则还原
 *   - 其余词统一小写
 */

/** 任何位置都要大写的词 */
const ALWAYS_UPPER = new Set([
  'i',
  "i'm",
  "i've",
  "i'd",
  "i'll",
  'ok',
  'okay'
])

/** 常见专有名词与缩写，遇到就还原（识别场景里最高频的一批） */
const PROPER_NOUNS = new Set([
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
  'america',
  'american',
  'english',
  'china',
  'chinese',
  'japan',
  'japanese',
  'europe',
  'european',
  'ai',
  'gpt',
  'api',
  'ui',
  'url',
  'cpu',
  'gpu',
  'usb',
  'tv',
  'us',
  'uk',
  'mr',
  'mrs',
  'ms',
  'dr'
])

function isMostlyUpper(text: string): boolean {
  const letters = text.replace(/[^A-Za-z]/g, '')
  if (letters.length < 2) return false
  const upper = letters.replace(/[^A-Z]/g, '').length
  return upper / letters.length >= 0.9
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

/**
 * 恢复单句大小写。句边界（. ? !）后的第一个词也大写。
 */
export function truecase(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return text
  if (!isMostlyUpper(trimmed)) return trimmed

  const lower = trimmed.toLowerCase()
  let sentenceStart = true

  return lower
    .split(/(\s+)/)
    .map((token) => {
      if (!token.trim()) return token
      // 拆出前后标点，只改字母部分
      const match = token.match(/^([^A-Za-z]*)([A-Za-z']*)([^A-Za-z]*)$/)
      if (!match) {
        sentenceStart = false
        return token
      }
      const [, head, core, tail] = match
      if (!core) {
        sentenceStart = /[.?!]$/.test(core + tail)
        return token
      }
      const key = core.replace(/'/g, "'")
      let word: string
      if (ALWAYS_UPPER.has(key)) {
        word = core.charAt(0).toUpperCase() + core.slice(1)
      } else if (PROPER_NOUNS.has(key)) {
        word = capitalize(core)
      } else if (sentenceStart) {
        word = capitalize(core)
      } else {
        word = core
      }
      sentenceStart = /[.?!]$/.test(tail)
      return head + word + tail
    })
    .join('')
}

export default truecase
