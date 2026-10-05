/**
 * sherpa-onnx 流式识别的 WebSocket 客户端。
 *
 * 协议（与 asr-service 一致）：
 *   客户端 → 服务端  二进制帧：float32 小端、单声道、16kHz 原始采样点
 *   客户端 → 服务端  文本帧 "Done"：音频结束
 *   服务端 → 客户端  文本帧 JSON：text / segment / is_final / is_eof ...
 *   服务端 → 客户端  文本帧 "Done!"：本流结果推完
 */

export interface AsrResultMessage {
  text: string
  segment: number
  is_final: boolean
  is_eof?: boolean
}

export type AsrState = 'idle' | 'connecting' | 'ready' | 'error' | 'closed'

export class AsrClient {
  private ws: WebSocket | null = null
  private resultHandler: ((result: AsrResultMessage) => void) | null = null
  private stateHandler: ((state: AsrState, detail?: string) => void) | null = null
  /**
   * 本端主动关闭标记。
   * 自己 close() 产生的 onclose 必须被忽略：上层把它当成"服务断开"就会排重连，
   * 重连又要先 close 旧连接 → 又一次 onclose → 1 秒一轮的永动循环，
   * 界面上的"开始/暂停"按钮就是这么每分钟抽六十次的。
   */
  private closingByUs = false

  private static seq = 0
  private readonly id: number

  constructor(private url: string) {
    this.id = ++AsrClient.seq
  }

  /** 连接编号，排障时用来区分"到底是哪条连接被关了" */
  get connectionId(): number {
    return this.id
  }

  onResult(handler: (result: AsrResultMessage) => void): void {
    this.resultHandler = handler
  }

  onStateChange(handler: (state: AsrState, detail?: string) => void): void {
    this.stateHandler = handler
  }

  private setState(state: AsrState, detail?: string): void {
    this.stateHandler?.(state, detail)
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.setState('connecting')
      let ws: WebSocket
      try {
        ws = new WebSocket(this.url)
      } catch (error) {
        this.setState('error', (error as Error).message)
        reject(error)
        return
      }
      this.ws = ws

      ws.onopen = () => {
        this.setState('ready')
        resolve()
      }
      ws.onerror = () => {
        const detail = `无法连接识别服务 ${this.url}`
        this.setState('error', detail)
        reject(new Error(detail))
      }
      ws.onclose = (event: CloseEvent) => {
        void event
        if (this.closingByUs) return
        this.setState('closed')
      }
      ws.onmessage = (event: MessageEvent) => {
        if (typeof event.data !== 'string') return
        const payload = event.data
        if (payload === 'Done!') return
        try {
          const parsed = JSON.parse(payload) as AsrResultMessage
          this.resultHandler?.(parsed)
        } catch {
          // 非 JSON 文本帧忽略
        }
      }
    })
  }

  /** 发送一块 16bit PCM，内部转成 float32 再发 */
  sendPcm(pcm: ArrayBuffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    const int16 = new Int16Array(pcm)
    const float32 = new Float32Array(int16.length)
    for (let i = 0; i < int16.length; i += 1) {
      float32[i] = int16[i] / 32768
    }
    this.ws.send(float32.buffer)
  }

  /** 通知服务端音频结束（不关闭连接） */
  finish(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send('Done')
    }
  }

  close(): void {
    const ws = this.ws
    this.ws = null
    this.closingByUs = true
    if (!ws) return
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send('Done')
        ws.close()
      } else {
        ws.close()
      }
    } catch {
      // 连接已断开
    }
  }
}
