import React, { useCallback, useEffect, useRef, useState } from 'react'
import { DEFAULT_SETTINGS, type Settings } from '@shared/config'
import { AudioCapture } from './lib/audioCapture'
import { AsrClient, type AsrResultMessage, type AsrState } from './lib/asrClient'
import { translate } from './lib/translator'
import { truecase } from './lib/truecase'
import { StreamSegmenter } from './lib/segmenter'

interface Line {
  id: number
  source: string
  translation: string
  loading: boolean
}

/** 正在识别中的那一行：原文持续增长，译文跟着刷新（流式翻译） */
interface Draft {
  id: number
  source: string
  translation: string
}

/** 临时结果送去翻译的节流间隔：太小会打爆翻译服务，太大就没了"边说边翻"的感觉 */
const DRAFT_TRANSLATE_INTERVAL_MS = 350

/** int16 下的有声门槛，约 -30dB */
const LOUD_THRESHOLD = 300
/** 连续这么久一点声音都没有，就认为采集哑掉了，重建一次采集管线 */
const SILENCE_RESTART_MS = 90000

/** 一块 PCM 的峰值 */
function peakOfPcm(pcm: ArrayBuffer): number {
  const view = new Int16Array(pcm)
  let peak = 0
  for (let i = 0; i < view.length; i += 1) {
    const value = view[i] < 0 ? -view[i] : view[i]
    if (value > peak) peak = value
  }
  return peak
}

/**
 * 判断这一段是不是"下一句的开头被留在了上一段末尾"的碎片。
 *
 * 端点打断时经常出现 "about" / "of" / "vi" 这种一两个词的尾巴，而下一段又会
 * 带着同样的开头重来一遍。单独成行的话字幕会碎成一两个字，所以先攒着不显示。
 * 带句末标点的一律不算碎片——那是真的一句（"of you."）。
 */
function isFragment(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  if (/[.?!]$/.test(t)) return false
  return t.split(/\s+/).length <= 2 && t.length <= 14
}

const App: React.FC = () => {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [lines, setLines] = useState<Line[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState('准备中…')

  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const captureRef = useRef<AudioCapture | null>(null)
  const asrRef = useRef<AsrClient | null>(null)
  const seqRef = useRef(0)
  const draftTextRef = useRef('')
  const draftTimerRef = useRef<number | null>(null)
  /** 翻译请求序号，只认最后一次的结果，避免乱序覆盖 */
  const translateSeqRef = useRef(0)
  const lastTranslationRef = useRef<{ text: string; translated: string } | null>(null)
  /** 译文缓存：流式草稿里文本常常只差一两个词，同一段会被送去翻好几次，命中就直接用 */
  const translationCacheRef = useRef(new Map<string, string>())
  /** 是否有一个草稿翻译还在路上 */
  const draftTranslatingRef = useRef(false)
  /** 客户端自己断句：服务端只认静音，这句-scoped 的切片器负责及时换行 */
  const segmenterRef = useRef(new StreamSegmenter())
  /** 服务端给的整段累积原文（未加工），切片器靠它算已提交前缀 */
  const rawTextRef = useRef('')
  /** 草稿最后一次发生变化的时间，用来判断"说到这儿停了" */
  const lastChangeAtRef = useRef(0)
  /** 用户想要的状态：服务重启、网络抖动断开后据此自动重连 */
  const desiredRunningRef = useRef(false)
  const reconnectTimerRef = useRef<number | null>(null)
  const retryDelayRef = useRef(1000)
  /** 端点打断时攒下的尾巴：等下一段确认它是重复开头后丢掉 */
  const pendingTailRef = useRef('')
  /** 流假死看门狗：最近一次收到识别结果的时刻 / 当前重连退避间隔 */
  const lastResultAtRef = useRef(0)
  const watchdogBackoffRef = useRef(30000)
  /** 最后一次采到声音的时刻 / 当前静音自愈的门槛（触发后翻倍，避免反复重启） */
  const lastLoudAtRef = useRef(0)
  const silenceRestartRef = useRef(SILENCE_RESTART_MS)
  /** 最近一次收到采集数据块的时刻 / 是否正在重建采集 */
  const captureChunkAtRef = useRef(0)
  const captureRestartingRef = useRef(false)

  /** 本轮连接的起始时刻，用来判断"这条连接站稳过没有" */
  const readyAtRef = useRef(0)
  /** 只重建识别连接的函数，用 ref 持有以打破几个回调之间的循环依赖 */
  const reopenRef = useRef<() => Promise<void>>(async () => {})

  useEffect(() => {
    window.api.settings.get().then(setSettings)
    return window.api.settings.onChange(setSettings)
  }, [])

  // 断句参数随时可调，改了立刻对下一句生效
  useEffect(() => {
    segmenterRef.current.configure({
      pauseMs: settings.segmentPauseMs,
      maxWords: settings.segmentMaxWords,
      maxChars: settings.segmentMaxChars
    })
  }, [settings.segmentPauseMs, settings.segmentMaxWords, settings.segmentMaxChars])

  const rememberTranslation = useCallback((text: string, translated: string) => {
    if (!text || !translated) return
    const cache = translationCacheRef.current
    cache.set(text, translated)
    // 只留最近 50 条，免得长会话里无限涨
    if (cache.size > 50) cache.delete(cache.keys().next().value as string)
  }, [])

  /** 把临时结果翻一遍：节流触发，只认最新一次的结果 */
  const translateDraft = useCallback(async () => {
    const text = draftTextRef.current
    if (!text.trim()) return
    const cached = translationCacheRef.current.get(text)
    if (cached !== undefined) {
      lastTranslationRef.current = { text, translated: cached }
      setDraft((prev) => (prev ? { ...prev, translation: cached } : prev))
      return
    }
    // 上一次还没回来就别再发：NLLB 1.3B 单句约 1 秒，节流间隔比它短得多，
    // 放任并发只会排队翻译已经过期的半句，屏幕上的译文反而更滞后
    if (draftTranslatingRef.current) return
    draftTranslatingRef.current = true
    const seq = (translateSeqRef.current += 1)
    try {
      const translated = await translate(text, settingsRef.current)
      rememberTranslation(text, translated)
      if (seq !== translateSeqRef.current) return
      lastTranslationRef.current = { text, translated }
      setDraft((prev) => (prev ? { ...prev, translation: translated } : prev))
    } finally {
      draftTranslatingRef.current = false
    }
  }, [rememberTranslation])

  const scheduleDraftTranslate = useCallback(() => {
    if (!settingsRef.current.translateEnabled) return
    if (draftTimerRef.current !== null) return
    draftTimerRef.current = window.setTimeout(() => {
      draftTimerRef.current = null
      void translateDraft()
    }, DRAFT_TRANSLATE_INTERVAL_MS)
  }, [translateDraft])

  /** 流式结果：原文立刻更新，译文按节流跟着走，实现"说半句翻半句" */
  const updateDraft = useCallback(
    (text: string) => {
      draftTextRef.current = text
      if (!text.trim()) {
        setDraft(null)
        return
      }
      setDraft((prev) => ({
        id: prev?.id ?? (seqRef.current += 1),
        source: text,
        // 新译文回来之前先留着上一版译文，避免字幕闪空
        translation: prev?.translation ?? ''
      }))
      scheduleDraftTranslate()
    },
    [scheduleDraftTranslate]
  )

  /** 一句话说完了：定稿成正式行，译文能复用就复用，否则用完整句子再翻一次 */
  const finalize = useCallback((text: string) => {
    if (draftTimerRef.current !== null) {
      window.clearTimeout(draftTimerRef.current)
      draftTimerRef.current = null
    }
    draftTextRef.current = ''
    // 定稿才打日志：一句话只来一次，不像流式草稿那样每 100ms 一条，
    // 所以这里的 console.log 不会拖慢跑在主线程的音频回调。
    // 字幕真正显示的就是这些行，排障和测准确率都以它为准
    if (text.trim()) console.log('[caption] ' + text.trim())
    if (!text) {
      setDraft(null)
      return
    }
    const s = settingsRef.current
    const id = (seqRef.current += 1)
    const last = lastTranslationRef.current
    // 定稿文本和最后一次翻的草稿一致就直接复用，翻过的整句也能从缓存里捡回来，
    // 省掉一次 1 秒级的模型调用，字幕换行时译文不会空一下
    const reused =
      last && last.text === text ? last.translated : (translationCacheRef.current.get(text) ?? '')
    setDraft(null)
    setLines((prev) =>
      [...prev, { id, source: text, translation: reused, loading: s.translateEnabled && !reused }].slice(
        -s.keepLines
      )
    )
    if (!s.translateEnabled || reused) return

    const seq = (translateSeqRef.current += 1)
    void translate(text, s).then((translated) => {
      rememberTranslation(text, translated)
      if (seq !== translateSeqRef.current) return
      lastTranslationRef.current = { text, translated }
      setLines((prev) =>
        prev.map((line) => (line.id === id ? { ...line, translation: translated, loading: false } : line))
      )
    })
  }, [rememberTranslation])

  const handleResult = useCallback(
    (result: AsrResultMessage) => {
      const raw = result.text || ''
      // 只有带内容的消息才算"流是活的"。服务端流卡住后会一直推空文本，
      // 光看"有没有消息"会让看门狗永远不触发，界面上就一直空白
      // 这里刻意不打日志：流式结果每秒来十来条，而渲染进程的 console.log 要
      // 同步 IPC 到主进程再落盘，正好会卡住跑在主线程的音频回调，采集中段就
      // 会整块丢掉，表现为识别结果里随机的半句话消失
      if (raw.trim()) {
        lastResultAtRef.current = Date.now()
        watchdogBackoffRef.current = 30000
      }
      if (result.is_final) {
        // 服务端这一大段结束了：剩余部分定稿，然后清空切片器迎接下一大段
        const rest = segmenterRef.current.feed(raw).trim()
        segmenterRef.current.reset()
        rawTextRef.current = ''
        // 端点打断常把下一句的开头留在这一段末尾（"about" / "of"），先攒着：
        // 下一段通常会带着同样的开头重来，那时直接丢掉，字幕就不会碎成一两个词
        if (isFragment(rest)) {
          pendingTailRef.current = rest
          setDraft(null)
          return
        }
        pendingTailRef.current = ''
        finalize(truecase(rest))
        return
      }
      // 新的一段开始了：上一段攒下的尾巴没被带过来，说明它是独立内容，补成一行
      const pending = pendingTailRef.current
      if (pending) {
        pendingTailRef.current = ''
        if (!raw.trim().toLowerCase().startsWith(pending.toLowerCase())) finalize(truecase(pending))
      }
      rawTextRef.current = raw
      lastChangeAtRef.current = Date.now()
      // 英文流式模型输出是全大写，先恢复大小写再展示和翻译
      updateDraft(truecase(segmenterRef.current.feed(raw)))
    },
    [finalize, updateDraft]
  )

  /**
   * 断句轮询：停顿够久、或者草稿已经太长，就把当前草稿切成正式行。
   * 不等服务端的 is_final —— 它要 0.8 秒静音，最长 30 秒才强制断，句子会堆得看不到头。
   */
  useEffect(() => {
    const timer = window.setInterval(() => {
      // 流假死看门狗：连接和推流都在，但服务端长时间一个字不回（多见于
      // 应用启动时抢在识别服务就绪之前连上），主动重建连接自愈
      if (
        desiredRunningRef.current &&
        reconnectTimerRef.current === null &&
        // 关键：必须是"最近明明有声音、却迟迟不出字"才认定服务端假死。
        // 没有声音的时候（视频暂停、纯音乐、BGM 盖过人声）服务端本来就该沉默，
        // 这时候重连只会让状态栏在"识别中/断开重连"之间反复跳
        Date.now() - lastLoudAtRef.current < 15000 &&
        Date.now() - lastResultAtRef.current > watchdogBackoffRef.current
      ) {
        watchdogBackoffRef.current = Math.min(watchdogBackoffRef.current * 2, 120000)
        setStatus('识别服务无响应，正在重建连接…')
        scheduleReconnect(200)
        return
      }
      // 采集哑掉自愈：只重建"采集"这一环，不动识别连接、不切换运行状态，
      // 所以按钮不会跳，已经出来的字幕也不会被清掉。
      // Windows 的系统声音回环偶尔会哑：格式、码率都正常，唯独内容全是 0
      if (
        desiredRunningRef.current &&
        captureRef.current &&
        Date.now() - lastLoudAtRef.current > silenceRestartRef.current
      ) {
        silenceRestartRef.current = Math.min(silenceRestartRef.current * 2, 480000)
        void restartCapture()
      }
      // 采集彻底不出数据：连数据块都不来（哪怕内容是静音也该每 100ms 来一块）。
      // 这是链路故障，不是"用户没播放"，所以要尽快重建
      if (
        desiredRunningRef.current &&
        captureRef.current &&
        Date.now() - captureChunkAtRef.current > 5000
      ) {
        void restartCapture()
      }
      const raw = rawTextRef.current
      if (!raw) return
      const rest = segmenterRef.current.feed(raw)
      if (!rest.trim()) return
      const idleMs = Date.now() - lastChangeAtRef.current
      if (!segmenterRef.current.shouldCommit(rest, idleMs)) return
      // 长度到了才需要回退到词边界；停顿触发的切分按原文整段提交，
      // 否则最后一个词会被反复定稿，字幕上重复两三遍
      const text = segmenterRef.current.commit(raw, segmenterRef.current.isTooLong(rest))
      lastChangeAtRef.current = Date.now()
      finalize(truecase(text))
    }, 100)
    return () => window.clearInterval(timer)
  }, [finalize])

  /** 丢弃一条连接：先摘掉状态回调，否则自己 close 也会被当成"服务断开"而触发重连 */
  const discardAsr = (asr: AsrClient | null) => {
    if (!asr) return
    asr.onStateChange(() => {})
    asr.close()
  }

  /**
   * 重连只重建"识别连接"这一环：不动采集、不动运行状态。
   * 以前这里是 stop() + start()，而 stop() 会关掉旧连接、把按钮切回"开始"，
   * 于是"断开 → 重连 → 又断开"每 1 秒一轮，按钮就一直在开始/暂停之间抽。
   */
  const scheduleReconnect = useCallback((delay: number) => {
    if (reconnectTimerRef.current !== null) return
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null
      if (!desiredRunningRef.current) return
      void reopenRef.current()
    }, delay)
  }, [])

  /** 所有识别连接共用同一套状态处理 */
  const handleAsrState = useCallback(
    (state: AsrState, detail?: string) => {
      if (state === 'ready') {
        retryDelayRef.current = 1000
        setStatus('识别中')
        return
      }
      if (state === 'error') setStatus(`识别服务不可用：${detail ?? ''}`)
      if (state !== 'closed') return
      // 断开时：这条连接站稳过 10 秒才把退避从头算，否则继续退避，
      // 避免"刚握上手就被掐掉"演变成 1 秒一次的重连风暴
      if (Date.now() - readyAtRef.current > 10000) retryDelayRef.current = 1000
      if (!desiredRunningRef.current) return
      const delay = retryDelayRef.current
      retryDelayRef.current = Math.min(delay * 2, 15000)
      setStatus(`识别服务断开，${Math.round(delay / 1000)} 秒后重连…`)
      scheduleReconnect(delay)
    },
    [scheduleReconnect]
  )

  /**
   * 重建采集管线（不动识别连接、不动运行状态）。
   * 两种故障都靠它恢复：一直没数据块送来，或者有数据但内容长期全是静音。
   */
  const restartCapture = useCallback(async () => {
    if (captureRestartingRef.current) return
    const cap = captureRef.current
    if (!cap) return
    captureRestartingRef.current = true
    const s = settingsRef.current
    try {
      await cap.stop()
      await cap.start(s.audioSource, (pcm) => {
        captureChunkAtRef.current = Date.now()
        if (peakOfPcm(pcm) > LOUD_THRESHOLD) {
          lastLoudAtRef.current = Date.now()
          silenceRestartRef.current = SILENCE_RESTART_MS
        }
        asrRef.current?.sendPcm(pcm)
      })
      captureChunkAtRef.current = Date.now()
      lastLoudAtRef.current = Date.now()
    } catch {
      /* 重建失败就等下一轮 */
    } finally {
      captureRestartingRef.current = false
    }
  }, [])

  /** 只重建识别连接：采集管线和界面上的"运行中"状态都不受影响 */
  const reopenAsr = useCallback(async () => {
    const s = settingsRef.current
    const old = asrRef.current
    asrRef.current = null
    if (old) discardAsr(old)

    readyAtRef.current = Date.now()
    const asr = new AsrClient(s.asrUrl)
    asr.onResult(handleResult)
    asr.onStateChange(handleAsrState)
    try {
      await asr.connect()
    } catch {
      discardAsr(asr)
      const delay = retryDelayRef.current
      retryDelayRef.current = Math.min(delay * 2, 15000)
      scheduleReconnect(delay)
      return
    }
    asrRef.current = asr
    lastResultAtRef.current = Date.now()
    watchdogBackoffRef.current = 30000
  }, [handleResult, handleAsrState, scheduleReconnect])

  reopenRef.current = reopenAsr

  /** keepRunning：内部重建连接时用，保持界面上的"运行中"状态不被打断 */
  const stop = useCallback(async (keepRunning = false) => {
    desiredRunningRef.current = false
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    if (captureRef.current) {
      await captureRef.current.stop()
      captureRef.current = null
    }
    // 先摘引用再关，避免关闭过程中的异步事件打到已经作废的连接上
    const asr = asrRef.current
    asrRef.current = null
    if (asr) discardAsr(asr)
    if (draftTimerRef.current !== null) {
      window.clearTimeout(draftTimerRef.current)
      draftTimerRef.current = null
    }
    rawTextRef.current = ''
    draftTextRef.current = ''
    segmenterRef.current.reset()
    if (!keepRunning) {
      setRunning(false)
      setDraft(null)
      setStatus('已停止')
    }
  }, [])

  const start = useCallback(async () => {
    // 防重入：自动开始的 effect 在 start 引用变化时会重跑，别重复建连接
    if (desiredRunningRef.current) return
    const s = settingsRef.current
    desiredRunningRef.current = true
    // 本轮连接周期起点：断开时据此判断退避要不要从头算
    readyAtRef.current = Date.now()
    setStatus('正在连接识别服务…')

    const asr = new AsrClient(s.asrUrl)
    asr.onResult(handleResult)
    asr.onStateChange(handleAsrState)

    try {
      await asr.connect()
    } catch {
      // 服务重启期间会短暂连不上。这里也要按退避重连，不能就此彻底停摆，
      // 否则服务恢复后应用永远停在"已停止"，只能手动点开始
      setStatus(`无法连接识别服务 ${s.asrUrl}，稍后重试…`)
      setRunning(false)
      discardAsr(asr)
      const delay = retryDelayRef.current
      retryDelayRef.current = Math.min(delay * 2, 15000)
      scheduleReconnect(delay)
      return
    }
    asrRef.current = asr
    // 从连接成功这一刻起算"流是否还活着"
    lastResultAtRef.current = Date.now()

    const capture = new AudioCapture()
    lastLoudAtRef.current = Date.now()
    silenceRestartRef.current = SILENCE_RESTART_MS
    captureChunkAtRef.current = Date.now()
    try {
      await capture.start(s.audioSource, (pcm) => {
        captureChunkAtRef.current = Date.now()
        if (peakOfPcm(pcm) > LOUD_THRESHOLD) {
          lastLoudAtRef.current = Date.now()
          silenceRestartRef.current = SILENCE_RESTART_MS
        }
        // 必须走 asrRef：重连会换掉连接对象，若这里闭包捕获的是本次 start 的
        // asr，重连之后的音频就全发给了已废弃的旧连接，服务端一个字都收不到
        asrRef.current?.sendPcm(pcm)
      })
    } catch (error) {
      // 采集失败（没授权等）不是服务断开，不该反复重试
      setStatus((error as Error).message)
      discardAsr(asr)
      asrRef.current = null
      desiredRunningRef.current = false
      setRunning(false)
      return
    }
    captureRef.current = capture
    setRunning(true)
  }, [handleResult, handleAsrState, scheduleReconnect])

  // 音源或识别服务地址变了，运行中就重连一次
  useEffect(() => {
    if (!running) return
    let cancelled = false
    const restart = async () => {
      await stop()
      if (!cancelled) await start()
    }
    void restart()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.audioSource, settings.asrUrl])

  // 打开即开始。卸载时把标记复位，这样热更新重载后也能自动恢复，
  // 不用每次改完代码都手动点"开始"
  const autoStartedRef = useRef(false)
  useEffect(() => {
    if (autoStartedRef.current) return
    autoStartedRef.current = true
    void start()
    return () => {
      autoStartedRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start])

  // 卸载（含热更新重载）时收摊，避免残留一条识别连接重复推音频
  useEffect(() => () => void stop(), [stop])

  const clearLines = () => {
    setLines([])
    setDraft(null)
    rawTextRef.current = ''
    draftTextRef.current = ''
    pendingTailRef.current = ''
    segmenterRef.current.reset()
  }

  return (
    <div className="panel">
      <div className="toolbar">
        <span className="brand">Real-timeTranslation</span>
        <div className="toolbar-actions">
          <button className="icon-btn" title="设置" onClick={() => window.api.settings.open()}>
            <svg viewBox="0 0 24 24" width="14" height="14">
              <path
                d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 7a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 3a2 2 0 1 1 4 0v.1A1.7 1.7 0 0 0 17 4.6a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 .8 2.9H22a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button className="icon-btn" title={running ? '暂停' : '开始'} onClick={() => (running ? void stop() : void start())}>
            {running ? (
              <svg viewBox="0 0 24 24" width="14" height="14">
                <rect x="7" y="5" width="3.6" height="14" rx="1.2" fill="currentColor" />
                <rect x="13.4" y="5" width="3.6" height="14" rx="1.2" fill="currentColor" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="14" height="14">
                <path d="M8 5.5v13l11-6.5-11-6.5Z" fill="currentColor" />
              </svg>
            )}
          </button>
          <button
            className="icon-btn"
            title="清空字幕"
            onClick={() => {
              clearLines()
            }}
          >
            <svg viewBox="0 0 24 24" width="14" height="14">
              <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
            </svg>
          </button>
          <button className="icon-btn" title="最小化" onClick={() => window.api.window.minimize()}>
            <svg viewBox="0 0 24 24" width="14" height="14">
              <rect x="6" y="11" width="12" height="2" rx="1" fill="currentColor" />
            </svg>
          </button>
          <button className="icon-btn danger" title="退出" onClick={() => window.api.window.close()}>
            <svg viewBox="0 0 24 24" width="14" height="14">
              <path
                d="M6 6l12 12M18 6L6 18"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                fill="none"
              />
            </svg>
          </button>
        </div>
      </div>

      <div className="subtitle-area">
        {lines.map((line, index) => {
          // 有正在识别的草稿行时，它才是最新的，已定稿的行一律弱化
          const isLatest = index === lines.length - 1 && !draft
          return (
            <div className={`line ${isLatest ? 'latest' : 'faded'}`} key={line.id}>
              {settings.translateEnabled && settings.bilingual && (
                <div className="source-text" style={{ fontSize: settings.tempFontSize }}>
                  {line.source}
                </div>
              )}
              <div className="target-text" style={{ fontSize: settings.masterFontSize }}>
                {settings.translateEnabled ? line.translation || line.source : line.source}
              </div>
            </div>
          )
        })}

        {draft && (
          <div className="line partial">
            {settings.translateEnabled && settings.bilingual && (
              <div className="source-text" style={{ fontSize: settings.tempFontSize }}>
                {draft.source}
              </div>
            )}
            <div className="target-text" style={{ fontSize: settings.masterFontSize }}>
              {/* 译文还没回来时先顶上原文，避免字幕空着闪 */}
              {settings.translateEnabled ? draft.translation || draft.source : draft.source}
            </div>
          </div>
        )}
      </div>

      <div className="status-bar">
        <span className={`dot ${running ? 'on' : 'off'}`} />
        <span>{status}</span>
        <span className="spacer" />
        <span className="hint">{settings.audioSource === 'system' ? '系统声音' : '麦克风'}</span>
      </div>
    </div>
  )
}

export default App
