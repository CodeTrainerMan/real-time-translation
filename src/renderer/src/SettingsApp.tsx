import React, { useEffect, useState } from 'react'
import { DEFAULT_SETTINGS, LANGUAGE_LABELS, defaultAsrUrl, type Settings } from '@shared/config'
import { checkMtHealth } from './lib/translator'

const SettingsApp: React.FC = () => {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [health, setHealth] = useState<{ ok: boolean; message: string } | null>(null)

  useEffect(() => {
    window.api.settings.get().then(setSettings)
    return window.api.settings.onChange(setSettings)
  }, [])

  const patch = (next: Partial<Settings>) => {
    setSettings((prev) => ({ ...prev, ...next }))
    void window.api.settings.set(next)
  }

  const onLanguageChange = (lang: 'en' | 'zh') => {
    // 语种决定用哪个识别服务（英文 9901 / 中文 9902）
    patch({ inputLanguage: lang, asrUrl: defaultAsrUrl(lang) })
  }

  useEffect(() => {
    setHealth(null)
  }, [settings.mtProvider, settings.mtUrl, settings.ollamaUrl])

  return (
    <div className="settings">
      <h1>设置</h1>

      <section>
        <h2>识别与翻译</h2>

        <label className="row">
          <span>音源</span>
          <select value={settings.audioSource} onChange={(e) => patch({ audioSource: e.target.value as Settings['audioSource'] })}>
            <option value="system">系统声音（视频 / 会议）</option>
            <option value="microphone">麦克风</option>
          </select>
        </label>

        <label className="row">
          <span>音源语言</span>
          <select value={settings.inputLanguage} onChange={(e) => onLanguageChange(e.target.value as 'en' | 'zh')}>
            <option value="en">{LANGUAGE_LABELS.en}</option>
            <option value="zh">{LANGUAGE_LABELS.zh}</option>
          </select>
        </label>

        <label className="row">
          <span>目标语言</span>
          <select value={settings.outputLanguage} onChange={(e) => patch({ outputLanguage: e.target.value as 'zh' | 'en' })}>
            <option value="zh">{LANGUAGE_LABELS.zh}</option>
            <option value="en">{LANGUAGE_LABELS.en}</option>
          </select>
        </label>

        <label className="row switch">
          <span>开启翻译</span>
          <input type="checkbox" checked={settings.translateEnabled} onChange={(e) => patch({ translateEnabled: e.target.checked })} />
        </label>

        <label className="row switch">
          <span>双语字幕（原文 + 译文）</span>
          <input type="checkbox" checked={settings.bilingual} onChange={(e) => patch({ bilingual: e.target.checked })} />
        </label>

        <label className="row">
          <span>翻译后端</span>
          <select value={settings.mtProvider} onChange={(e) => patch({ mtProvider: e.target.value as Settings['mtProvider'] })}>
            <option value="local">本地翻译小工具（Docker）</option>
            <option value="ollama">本机 Ollama 大模型</option>
            <option value="none">不翻译</option>
          </select>
        </label>

        {settings.mtProvider === 'local' && (
          <label className="row">
            <span>翻译服务地址</span>
            <input value={settings.mtUrl} onChange={(e) => patch({ mtUrl: e.target.value })} placeholder="http://127.0.0.1:9910" />
          </label>
        )}

        {settings.mtProvider === 'ollama' && (
          <>
            <label className="row">
              <span>Ollama 地址</span>
              <input value={settings.ollamaUrl} onChange={(e) => patch({ ollamaUrl: e.target.value })} placeholder="http://127.0.0.1:11434" />
            </label>
            <label className="row">
              <span>模型名</span>
              <input value={settings.ollamaModel} onChange={(e) => patch({ ollamaModel: e.target.value })} placeholder="qwen2.5:7b" />
            </label>
          </>
        )}

        <div className="row action">
          <button
            onClick={async () => {
              setHealth({ ok: false, message: '检查中…' })
              setHealth(await checkMtHealth(settings))
            }}
          >
            检查翻译服务
          </button>
          {health && <span className={health.ok ? 'ok' : 'bad'}>{health.message}</span>}
        </div>
      </section>

      <section>
        <h2>断句节奏</h2>

        <label className="row slider">
          <span>停顿换行 {settings.segmentPauseMs}ms</span>
          <input
            type="range"
            min={200}
            max={5000}
            step={100}
            value={settings.segmentPauseMs}
            onChange={(e) => patch({ segmentPauseMs: Number(e.target.value) })}
          />
        </label>

        <label className="row slider">
          <span>每行最多 {settings.segmentMaxWords} 词</span>
          <input
            type="range"
            min={6}
            max={40}
            step={2}
            value={settings.segmentMaxWords}
            onChange={(e) => patch({ segmentMaxWords: Number(e.target.value) })}
          />
        </label>

        <label className="row slider">
          <span>每行最多 {settings.segmentMaxChars} 字符</span>
          <input
            type="range"
            min={40}
            max={200}
            step={10}
            value={settings.segmentMaxChars}
            onChange={(e) => patch({ segmentMaxChars: Number(e.target.value) })}
          />
        </label>

        <p className="tip">
          识别服务本身只按静音断句（0.8 秒静音，最长 30 秒才强制断），句子容易堆得很长。
          这里在客户端自己切：<b>停顿够久</b>或<b>超过长度上限</b>就换行，命中其一即生效。
        </p>
      </section>

      <section>
        <h2>服务地址</h2>
        <label className="row">
          <span>识别服务（WebSocket）</span>
          <input value={settings.asrUrl} onChange={(e) => patch({ asrUrl: e.target.value })} placeholder="ws://127.0.0.1:9901" />
        </label>
        <p className="tip">
          英文识别用 9901、中文用 9902。服务由 <code>asr-service/docker-compose.yml</code> 启动（sherpa-onnx，模型跑在 Docker 内）。
        </p>
      </section>

      <section>
        <h2>字幕面板</h2>

        <label className="row slider">
          <span>不透明度 {settings.transparency}%</span>
          <input type="range" min={15} max={100} value={settings.transparency} onChange={(e) => patch({ transparency: Number(e.target.value) })} />
        </label>

        <label className="row slider">
          <span>面板高度 {settings.panelHeight}px</span>
          <input type="range" min={120} max={600} step={10} value={settings.panelHeight} onChange={(e) => patch({ panelHeight: Number(e.target.value) })} />
        </label>

        <label className="row slider">
          <span>面板宽度 {settings.panelWidthScale}%</span>
          <input type="range" min={20} max={100} step={5} value={settings.panelWidthScale} onChange={(e) => patch({ panelWidthScale: Number(e.target.value) })} />
        </label>

        <label className="row slider">
          <span>译文字号 {settings.masterFontSize}px</span>
          <input type="range" min={14} max={48} value={settings.masterFontSize} onChange={(e) => patch({ masterFontSize: Number(e.target.value) })} />
        </label>

        <label className="row slider">
          <span>原文字号 {settings.tempFontSize}px</span>
          <input type="range" min={10} max={36} value={settings.tempFontSize} onChange={(e) => patch({ tempFontSize: Number(e.target.value) })} />
        </label>

        <label className="row slider">
          <span>保留行数 {settings.keepLines}</span>
          <input type="range" min={1} max={8} value={settings.keepLines} onChange={(e) => patch({ keepLines: Number(e.target.value) })} />
        </label>
      </section>

      <p className="tip">设置即时生效并保存在本机（%APPDATA%/real-time-translation/settings.json）。</p>
    </div>
  )
}

export default SettingsApp
