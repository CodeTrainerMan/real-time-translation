import { contextBridge, ipcRenderer } from 'electron'
import type { Settings } from '../shared/config'

const api = {
  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
    set: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke('settings:set', patch),
    /** 设置被本窗口或设置窗口改动后回调 */
    onChange: (callback: (settings: Settings) => void): (() => void) => {
      const listener = (_event: unknown, next: Settings) => callback(next)
      ipcRenderer.on('settings:changed', listener)
      return () => ipcRenderer.removeListener('settings:changed', listener)
    },
    open: (): Promise<void> => ipcRenderer.invoke('settings:open')
  },
  window: {
    minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
    close: (): Promise<void> => ipcRenderer.invoke('window:close')
  }
}

export type RealtimeTranslationApi = typeof api

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('api', api)
} else {
  // 未隔离上下文时直接挂到 window（开发调试用）
  ;(window as unknown as { api: RealtimeTranslationApi }).api = api
}
