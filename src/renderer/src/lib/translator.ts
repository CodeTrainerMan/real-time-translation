import type { Settings } from '@shared/config'

const TRANSLATE_TIMEOUT_MS = 15000

/** 本地翻译小工具（自建 Docker 服务，字段名兼容 LibreTranslate） */
async function translateLocal(text: string, settings: Settings): Promise<string> {
  const response = await fetch(`${settings.mtUrl.replace(/\/$/, '')}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      q: text,
      source: settings.inputLanguage,
      target: settings.outputLanguage
    }),
    signal: AbortSignal.timeout(TRANSLATE_TIMEOUT_MS)
  })
  if (!response.ok) {
    throw new Error(`翻译服务返回 ${response.status}`)
  }
  const data = (await response.json()) as { translatedText?: string }
  return (data.translatedText ?? '').trim()
}

/** 本机 Ollama（OpenAI 兼容接口），质量更好但更慢 */
async function translateOllama(text: string, settings: Settings): Promise<string> {
  const base = settings.ollamaUrl.replace(/\/$/, '')
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: settings.ollamaModel,
      stream: false,
      messages: [
        {
          role: 'system',
          content: `You are a professional subtitle translator. Translate from ${settings.inputLanguage} to ${settings.outputLanguage}. Output only the translated text, no explanation, no quotes.`
        },
        { role: 'user', content: text }
      ]
    }),
    signal: AbortSignal.timeout(TRANSLATE_TIMEOUT_MS)
  })
  if (!response.ok) {
    throw new Error(`Ollama 返回 ${response.status}`)
  }
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
  return (data.choices?.[0]?.message?.content ?? '').trim()
}

/** 按设置选择翻译后端；出错时返回空串，由调用方决定是否提示 */
export async function translate(text: string, settings: Settings): Promise<string> {
  if (!text.trim() || settings.mtProvider === 'none') return ''
  try {
    return settings.mtProvider === 'ollama' ? await translateOllama(text, settings) : await translateLocal(text, settings)
  } catch (error) {
    console.warn('[translate] 翻译失败', error)
    return ''
  }
}

/** 健康检查：设置页用来显示服务状态 */
export async function checkMtHealth(settings: Settings): Promise<{ ok: boolean; message: string }> {
  if (settings.mtProvider === 'none') return { ok: true, message: '未启用翻译' }
  if (settings.mtProvider === 'ollama') {
    try {
      const response = await fetch(`${settings.ollamaUrl.replace(/\/$/, '')}/api/tags`, {
        signal: AbortSignal.timeout(5000)
      })
      return response.ok ? { ok: true, message: 'Ollama 已连接' } : { ok: false, message: `Ollama ${response.status}` }
    } catch {
      return { ok: false, message: 'Ollama 未连接' }
    }
  }
  try {
    const response = await fetch(`${settings.mtUrl.replace(/\/$/, '')}/health`, {
      signal: AbortSignal.timeout(5000)
    })
    const data = (await response.json()) as { ready?: boolean; error?: string | null }
    if (!response.ok) return { ok: false, message: '翻译服务不可用' }
    return data.ready
      ? { ok: true, message: '翻译模型已就绪' }
      : { ok: false, message: data.error || '翻译模型加载中…' }
  } catch {
    return { ok: false, message: '翻译服务未启动' }
  }
}
