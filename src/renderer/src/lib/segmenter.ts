/**
 * 流式字幕的"提交 / 断句"控制。
 *
 * 思路来自 Whisper-Streaming 的 LocalAgreement 策略（目前流式转写的主流做法）：
 * 服务端每次给的是"当前这一大段的累积全文"，并不会帮我们断句，单纯等它的
 * is_final（默认要 0.8 秒静音，最长 30 秒才强制断）会出现一句话越堆越长、
 * 半天不换行的情况。
 *
 * 这里在客户端自己切：
 *   1. 维护 committed（已经切成行、不再重复显示的前缀）
 *   2. 每次来的新文本剥掉 committed，剩下的作为"草稿行"实时显示
 *   3. 满足任一条件就把草稿行定稿换行：
 *        - 说话停顿了（草稿超过 pauseMs 没有新增内容）
 *        - 长度到了上限（maxChars / maxWords），防止长句无限堆
 *        - 服务端 is_final（兜底）
 *
 * 关于"服务端回溯修正"：流式识别偶尔会改写前面已输出的部分，因此 committed
 * 每次都和当前文本算最长公共前缀，被改写时自动回退，不会把同一句话显示两遍。
 */

export interface SegmenterConfig {
  /** 草稿行达到多少字符就换行 */
  maxChars: number
  /** 草稿行达到多少个词就换行 */
  maxWords: number
  /** 停顿多久（毫秒）算说完一句 */
  pauseMs: number
  /** 已经有句末标点时，再停这么久就断句（比 pauseMs 短得多） */
  sentenceEndPauseMs: number
}

/** 句末标点：识别结果自带句号/问号/感叹号（kroko 模型会带标点） */
function endsSentence(text: string): boolean {
  return /[.!?]["')\]]?$/.test(text.trim())
}

export const DEFAULT_SEGMENTER_CONFIG: SegmenterConfig = {
  maxChars: 110,
  maxWords: 24,
  // 停顿判定要大于"句内停顿 + 模型吐词本身的间隔"，这两者都可能到 1 秒左右。
  // 取小了（500 / 1000ms）会把一句完整的话从中间切开，字幕上就成了
  // "Hello everyone" / "Welcome to today's meeting" 这样两行。
  // 服务端按 2 秒静音切句并回 is_final，但两句之间的自然停顿常常只有 1.8 秒
  // 左右，服务端够不上，两句话就粘成一行、只能等 110 字符硬切。
  // 实测：1200ms 会把单词劈开（"The train leave" / "s at seven…"），
  // 1800ms 能正常换行又不切半句，故取 1800ms。
  //
  // 注意：真正生效的是设置里的 segmentPauseMs（见 shared/config.ts），
  // 应用启动后会用设置值覆盖这里。此处仅作为没读到设置时的兜底，两者保持一致。
  pauseMs: 1800,
  // 连续讲话时两句之间的停顿常常只有 1~2 秒，够不上 pauseMs，结果两句粘成一行、
  // 只能等 110 字符硬切，读起来很累。所以只要已经说了完整一句（有句末标点），
  // 停这么短就断 —— 实测 700ms 不会切到半句，也不会把单词劈开。
  sentenceEndPauseMs: 700
}

function commonPrefix(a: string, b: string): string {
  const max = Math.min(a.length, b.length)
  let i = 0
  while (i < max && a[i] === b[i]) i += 1
  return a.slice(0, i)
}

/** 把切点回退到最近的词边界，避免把单词切成两半（"can bu" / "Ild interactive"） */
function cutAtWordBoundary(text: string): string {
  const idx = text.lastIndexOf(' ')
  return idx > 0 ? text.slice(0, idx + 1) : text
}

export function countWords(text: string): number {
  const trimmed = text.trim()
  return trimmed ? trimmed.split(/\s+/).length : 0
}

export class StreamSegmenter {
  private committed = ''
  private config: SegmenterConfig

  constructor(config: Partial<SegmenterConfig> = {}) {
    this.config = { ...DEFAULT_SEGMENTER_CONFIG, ...config }
  }

  configure(config: Partial<SegmenterConfig>): void {
    this.config = { ...this.config, ...config }
  }

  get configValue(): SegmenterConfig {
    return this.config
  }

  /**
   * 喂入服务端给的整段累积文本，返回还不属于任何已定稿行的部分（草稿）。
   */
  feed(raw: string): string {
    if (this.committed) {
      const common = commonPrefix(this.committed, raw)
      if (common.length < this.committed.length) {
        // 服务端改写了已提交的内容：把提交位置回退到公共前缀，避免重复显示
        this.committed = common
      }
    }
    return raw.slice(this.committed.length).replace(/^\s+/, '')
  }

  /** 当前草稿是否达到长度上限 */
  isTooLong(rest: string): boolean {
    if (!rest.trim()) return false
    return rest.length >= this.config.maxChars || countWords(rest) >= this.config.maxWords
  }

  /** 是否应该这一句换行：长度超限、停顿够久、或者已经说完一句（由调用方判断停顿） */
  shouldCommit(rest: string, idleMs: number): boolean {
    if (!rest.trim()) return false
    if (this.isTooLong(rest) || idleMs >= this.config.pauseMs) return true
    // 已经有句末标点 + 停了一下：不用等满 pauseMs，直接断
    return endsSentence(rest) && idleMs >= this.config.sentenceEndPauseMs
  }

  /**
   * 把草稿切走，返回本次应该定稿成行的文本（参数是喂进来的整段文本）。
   *
   * trimToWordBoundary 只在"长度到了硬切"时才用：那种切点常常落在单词中间，
   * 回退到词边界后下一行才会从完整单词开始。
   * 停顿触发的切分绝不能回退——否则最后一个词没被算进 committed，却已经被
   * 定稿出去了，下一轮轮询会把它再定稿一遍，字幕上就成了
   * "intelligence intelligence intelligence"。
   */
  commit(raw: string, trimToWordBoundary = false): string {
    const candidate = commonPrefix(this.committed, raw) === this.committed ? raw : this.committed
    const target = trimToWordBoundary ? cutAtWordBoundary(candidate) : candidate
    const text = raw.slice(this.committed.length, target.length)
    this.committed = target
    return text.replace(/^\s+/, '').trim()
  }

  /** 服务端 is_final：这一大段结束了，committed 作废，准备下一大段 */
  reset(): void {
    this.committed = ''
  }
}
