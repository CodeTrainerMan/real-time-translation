import type { RealtimeTranslationApi } from '../../preload/index'

declare global {
  interface Window {
    api: RealtimeTranslationApi
  }
}

export {}
