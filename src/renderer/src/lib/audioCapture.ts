import type { AudioSource } from '@shared/config'

const TARGET_SAMPLE_RATE = 16000
const CHUNK_SAMPLES = 1600 // 100ms @ 16kHz

// 系统声音回环采到的电平常常远低于音源本身（同一时刻和 MediaRecorder 路线
// 对比能差 20dB），语音几乎埋在地板噪声里，识别会大面积漏识。这里加一档
// 自动增益：跟踪近期峰值把语音拉到目标电平，静音段不动增益以免把底噪放大。
const AGC_TARGET_PEAK = 0.6
const AGC_MAX_GAIN = 50
/** 低于这个电平就当是静音，保持现有增益不动 */
const AGC_NOISE_GATE = 0.002

// 这里刻意不用 AudioWorklet：实测在 Windows 上用 AudioWorklet 接桌面回环音轨
// 拿到的是全零数据（数据块大小、速率都正常，内容全是 0），换成
// ScriptProcessorNode 后采样稳定。重采样在主线程完成，比例按 context 的
// 实际采样率计算，44100 这类非整数倍也能保持精确速率。

/**
 * 音频采集：系统声音回环（看视频/会议）或麦克风。
 * 输出 16kHz / 单声道 / 16bit PCM，每约 100ms 一块。
 */
export class AudioCapture {
  private stream: MediaStream | null = null
  private audioContext: AudioContext | null = null
  private sourceNode: MediaStreamAudioSourceNode | null = null
  private scriptNode: ScriptProcessorNode | null = null
  private gainNode: GainNode | null = null
  private onChunk: ((pcm: ArrayBuffer) => void) | null = null
  private capturing = false

  get isCapturing(): boolean {
    return this.capturing
  }

  private async getStream(source: AudioSource): Promise<MediaStream> {
    const errors: string[] = []

    if (source === 'system') {
      // 路径 1：Electron 的 chromeMediaSource=desktop（不弹窗，直接拿系统声音）
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { mandatory: { chromeMediaSource: 'desktop' } } as unknown as MediaTrackConstraints,
          video: { mandatory: { chromeMediaSource: 'desktop' } } as unknown as MediaTrackConstraints
        })
        stream.getVideoTracks().forEach((track) => track.stop())
        if (stream.getAudioTracks().length > 0) return stream
        stream.getTracks().forEach((track) => track.stop())
        errors.push('getUserMedia 未返回音频轨')
      } catch (error) {
        errors.push('getUserMedia: ' + (error as Error).message)
      }

      // 路径 2：标准 getDisplayMedia（会弹选择共享内容的窗口）
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
        stream.getVideoTracks().forEach((track) => track.stop())
        if (stream.getAudioTracks().length > 0) return stream
        stream.getTracks().forEach((track) => track.stop())
        errors.push('getDisplayMedia 未返回音频轨')
      } catch (error) {
        errors.push('getDisplayMedia: ' + (error as Error).message)
      }
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        })
        if (stream.getAudioTracks().length > 0) return stream
        errors.push('麦克风未返回音频轨')
      } catch (error) {
        errors.push('麦克风: ' + (error as Error).message)
      }
    }

    throw new Error((source === 'system' ? '无法采集系统声音' : '无法采集麦克风') + ' → ' + errors.join(' | '))
  }

  async start(source: AudioSource, onChunk: (pcm: ArrayBuffer) => void): Promise<void> {
    if (this.capturing) return
    this.onChunk = onChunk
    this.stream = await this.getStream(source)

    // 必须按音轨的实际采样率建 AudioContext：Windows 上用 16k 硬接 48k 的桌面
    // 音轨会拿到全零数据（格式、码率都正常，就是没内容）。
    // 重采样交给 worklet / ScriptProcessor，它们按 context 的 sampleRate 算比例
    const trackRate = this.stream.getAudioTracks()[0]?.getSettings().sampleRate
    let audioContext: AudioContext
    try {
      audioContext = new AudioContext(trackRate ? { sampleRate: trackRate } : {})
    } catch {
      audioContext = new AudioContext()
    }
    this.audioContext = audioContext
    if (audioContext.state === 'suspended') await audioContext.resume()

    this.sourceNode = audioContext.createMediaStreamSource(this.stream)

    // 静音输出：音频图必须连到 destination 才会被驱动，但不能真的播出来（否则回声）
    this.gainNode = audioContext.createGain()
    this.gainNode.gain.value = 0
    this.gainNode.connect(audioContext.destination)

    this.attachScriptProcessor()

    this.capturing = true
  }

  private attachScriptProcessor(): void {
    if (!this.audioContext || !this.sourceNode || !this.gainNode) return
    // ScriptProcessor 跑在主线程，块越小回调越频繁，主线程一忙（渲染字幕、
    // 发翻译请求）就会整块丢掉，表现为识别结果里随机的半句话缺失。
    // 这里用允许的最大块（16384），把回调频率压到最低
    const node = this.audioContext.createScriptProcessor(4096, 1, 1)
    const ratio = this.audioContext.sampleRate / TARGET_SAMPLE_RATE
    let pos = 0
    let prev = 0
    let out = new Int16Array(CHUNK_SAMPLES)
    let outLen = 0

    const emit = (value: number) => {
      const s = Math.max(-1, Math.min(1, value))
      out[outLen++] = s < 0 ? s * 0x8000 : s * 0x7fff
      if (outLen >= out.length) {
        if (this.onChunk) this.onChunk(out.buffer.slice(0))
        out = new Int16Array(CHUNK_SAMPLES)
        outLen = 0
      }
    }

    // 自动增益状态：envelope 是近期峰值包络，gain 平滑趋近目标倍数
    let envelope = 0
    let gain = 1
    // 静音门单独用一个"落得快"的包络：增益最高能到几十倍，如果门一直开着，
    // 说话间隙的底噪会被放大成实打实的噪声送进识别，模型就凭空认出
    // "to care on" "Ah" 这类词。用快包络让门在话说完约 0.7 秒内关掉
    let gateEnv = 0

    node.onaudioprocess = (event) => {
      const channel = event.inputBuffer.getChannelData(0)
      const len = channel.length

      let peak = 0
      for (let i = 0; i < len; i += 1) {
        const v = channel[i] < 0 ? -channel[i] : channel[i]
        if (v > peak) peak = v
      }
      // 快起慢落：突然来大声立刻压住，声音停了再慢慢放开
      envelope = Math.max(peak, envelope * 0.92)
      gateEnv = Math.max(peak, gateEnv * 0.5)
      if (envelope > AGC_NOISE_GATE) {
        const want = Math.min(AGC_TARGET_PEAK / envelope, AGC_MAX_GAIN)
        // 升得快、落得慢：声音一进来就要立刻补上增益（否则开头几秒全废在
        // 爬升上），声音走了再慢慢降回来，免得一句话里音量忽大忽小
        gain += (want - gain) * (want > gain ? 0.5 : 0.02)
      }
      // 门关着就按原始电平原样输出（增益取 1）：底噪不会被放大成"话"，
      // 语音刚起头那几毫秒的低电平也不会被当成静音切掉（否则 "Hello" 会变成 "O"）
      const appliedGain = gateEnv > AGC_NOISE_GATE ? gain : 1

      while (pos < len) {
        const i = Math.floor(pos)
        const frac = pos - i
        const a = i === 0 ? prev : channel[i - 1]
        const b = channel[i]
        emit((a * (1 - frac) + b * frac) * appliedGain)
        pos += ratio
      }
      pos -= len
      prev = channel[len - 1]
    }

    this.sourceNode.connect(node)
    node.connect(this.gainNode)
    this.scriptNode = node
  }

  async stop(): Promise<void> {
    this.capturing = false
    this.onChunk = null

    if (this.scriptNode) {
      this.scriptNode.onaudioprocess = null
      try {
        this.scriptNode.disconnect()
      } catch {
        /* 已断开 */
      }
      this.scriptNode = null
    }
    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect()
      } catch {
        /* 已断开 */
      }
      this.sourceNode = null
    }
    if (this.gainNode) {
      try {
        this.gainNode.disconnect()
      } catch {
        /* 已断开 */
      }
      this.gainNode = null
    }
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop())
      this.stream = null
    }
    if (this.audioContext) {
      try {
        await this.audioContext.close()
      } catch {
        /* 已关闭 */
      }
      this.audioContext = null
    }
  }
}
