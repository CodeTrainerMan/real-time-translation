/** 主进程 / 预加载 / 渲染进程共享的设置定义与默认值 */

export type AudioSource = 'system' | 'microphone'

/** 翻译后端：本地小工具（默认） | 本机 Ollama 大模型 | 不翻译 */
export type TranslateProvider = 'local' | 'ollama' | 'none'

export interface Settings {
  /** 是否翻译 */
  translateEnabled: boolean
  /** 双语字幕：原文与译文都显示（关闭则只显示译文） */
  bilingual: boolean
  /** 音源语言，决定用哪个识别服务 */
  inputLanguage: 'en' | 'zh'
  /** 目标语言 */
  outputLanguage: 'zh' | 'en'
  /** 面板不透明度 0-100（100 = 完全不透明） */
  transparency: number
  /** 面板高度 px */
  panelHeight: number
  /** 面板宽度（占屏幕宽度百分比） */
  panelWidthScale: number
  /** 主字幕字号（译文） */
  masterFontSize: number
  /** 临时字幕字号（原文） */
  tempFontSize: number
  /** 音源 */
  audioSource: AudioSource
  /** 识别服务 WebSocket 地址 */
  asrUrl: string
  /** 翻译后端 */
  mtProvider: TranslateProvider
  /** 本地翻译小工具地址 */
  mtUrl: string
  /** Ollama 地址（mtProvider=ollama 时用） */
  ollamaUrl: string
  /** Ollama 模型名 */
  ollamaModel: string
  /** 面板保留的历史行数 */
  keepLines: number
  /** 断句：停顿多少毫秒算说完一句（越小换行越快） */
  segmentPauseMs: number
  /** 断句：单行最多多少个词（防止长句一直堆） */
  segmentMaxWords: number
  /** 断句：单行最多多少个字符 */
  segmentMaxChars: number
}

export const DEFAULT_SETTINGS: Settings = {
  translateEnabled: true,
  bilingual: true,
  inputLanguage: 'en',
  outputLanguage: 'zh',
  transparency: 70,
  panelHeight: 260,
  panelWidthScale: 60,
  masterFontSize: 26,
  tempFontSize: 18,
  audioSource: 'system',
  asrUrl: 'ws://127.0.0.1:9901',
  mtProvider: 'local',
  mtUrl: 'http://127.0.0.1:9910',
  ollamaUrl: 'http://127.0.0.1:11434',
  ollamaModel: 'qwen2.5:7b',
  keepLines: 3,
  // 停顿换行阈值：应用侧的兜底。说话时的句内停顿、以及模型吐词本身的间隔
  // 都可能到 1 秒左右，取 1000 / 1200ms 会把一句完整的话从中间切开，甚至把
  // 单词劈成两半（"The train leave" / "s at seven…"）。
  // 服务端按 2 秒静音切句并回 is_final（再小会切断句子、还会丢整句），
  // 但两句之间的自然停顿常常只有 1.8 秒左右，服务端够不上、句子就粘成一行，
  // 所以这里取 1800ms 兜底：实测能正常换行，又不会切到半句。
  segmentPauseMs: 1800,
  // 长度兜底：长句堆到上限才强制换行。放宽一点，避免整句被硬切成两半。
  segmentMaxWords: 24,
  segmentMaxChars: 110
}

/** 切换识别语种时给出对应的默认服务地址（英文 9901 / 中文 9902） */
export function defaultAsrUrl(lang: 'en' | 'zh'): string {
  return lang === 'en' ? 'ws://127.0.0.1:9901' : 'ws://127.0.0.1:9902'
}

/** 语言下拉用的显示名 */
export const LANGUAGE_LABELS: Record<string, string> = {
  en: '英文',
  zh: '中文'
}
