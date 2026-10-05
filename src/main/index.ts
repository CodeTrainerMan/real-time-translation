import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'node:path'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { DEFAULT_SETTINGS, type Settings } from '../shared/config'

/** 开发模式下 vite 产出 .mjs，打包后是 .js */
const preloadPath = (() => {
  const mjs = join(__dirname, '../preload/index.mjs')
  return existsSync(mjs) ? mjs : join(__dirname, '../preload/index.js')
})()

// 只允许一个实例：多个实例会各自抢占系统声音采集，互相把对方挤成哑音
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // 第二个实例启动时把已有窗口顶到前面
  app.on('second-instance', () => {
    const win = settingsWindow ?? subtitleWindow
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
}

let subtitleWindow: BrowserWindow | null = null
let settingsWindow: BrowserWindow | null = null
let settings: Settings = { ...DEFAULT_SETTINGS }
let windowBounds: { x: number; y: number } | null = null

function userFile(name: string): string {
  return join(app.getPath('userData'), name)
}

function loadSettings(): Settings {
  try {
    const file = userFile('settings.json')
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<Settings>
      const merged: Settings = { ...DEFAULT_SETTINGS, ...parsed }
      // 旧版本默认停顿换行偏小（500 / 1000ms），会把一句完整的话从中间切开。
      // 只迁移"用户没动过、还是旧默认值"的情况，用户自己调过的值一律保留。
      if (parsed.segmentPauseMs === 500 || parsed.segmentPauseMs === 1000) {
        merged.segmentPauseMs = DEFAULT_SETTINGS.segmentPauseMs
      }
      return merged
    }
  } catch (error) {
    console.error('[main] 读取设置失败，使用默认设置', error)
  }
  return { ...DEFAULT_SETTINGS }
}

function loadWindowBounds(): { x: number; y: number } | null {
  try {
    const file = userFile('window.json')
    if (existsSync(file)) {
      return JSON.parse(readFileSync(file, 'utf-8')) as { x: number; y: number }
    }
  } catch {
    // 忽略：位置丢失就用默认位置
  }
  return null
}

function saveSettings(): void {
  writeFileSync(userFile('settings.json'), JSON.stringify(settings, null, 2), 'utf-8')
}

function saveWindowBounds(): void {
  if (windowBounds) {
    writeFileSync(userFile('window.json'), JSON.stringify(windowBounds), 'utf-8')
  }
}

/** 按设置计算字幕窗口的位置尺寸（默认贴屏幕底部居中） */
function computeBounds(): { x: number; y: number; width: number; height: number } {
  const area = screen.getPrimaryDisplay().workArea
  const width = Math.max(320, Math.round((area.width * settings.panelWidthScale) / 100))
  const height = Math.max(120, settings.panelHeight)
  const x = Math.round(area.x + (area.width - width) / 2)
  const y = Math.round(area.y + area.height - height - 16)
  return { x, y, width, height }
}

function applyPanelAppearance(): void {
  if (!subtitleWindow) return
  const { width, height } = computeBounds()
  const current = subtitleWindow.getBounds()
  // 保留用户拖到过的位置，只同步尺寸
  const x = windowBounds ? windowBounds.x : current.x
  const y = windowBounds ? windowBounds.y : current.y
  subtitleWindow.setBounds({ x, y, width, height })
  subtitleWindow.setOpacity(Math.min(1, Math.max(0.15, settings.transparency / 100)))
}

/** 开发模式把渲染层的 console / 未捕获异常打到主进程日志里，便于排障 */
function pipeRendererLogs(win: BrowserWindow, tag: string): void {
  if (!process.env['ELECTRON_RENDERER_URL']) return
  win.webContents.on('console-message', (_event, level, message) => {
    console.log(`[render:${tag}:${level}] ${message}`)
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    console.log(`[render:${tag}] 渲染进程退出 reason=${details.reason} code=${details.exitCode}`)
  })
}

/** 开发模式加载 vite dev server 的 URL，打包后加载本地文件 */
function loadRendererPage(win: BrowserWindow, page: string): void {
  const base = process.env['ELECTRON_RENDERER_URL']
  if (base) {
    win.loadURL(`${base}/${page}`)
    return
  }
  win.loadFile(join(__dirname, `../renderer/${page}`))
}

function appIconPath(): string | undefined {
  if (process.env['ELECTRON_RENDERER_URL']) return undefined
  if (app.isPackaged) {
    return join(process.resourcesPath, 'app.asar.unpacked', 'build', 'icon.png')
  }
  return join(app.getAppPath(), 'build', 'icon.png')
}

function createSubtitleWindow(): void {
  const bounds = computeBounds()
  windowBounds = loadWindowBounds()

  subtitleWindow = new BrowserWindow({
    x: windowBounds ? windowBounds.x : bounds.x,
    y: windowBounds ? windowBounds.y : bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: false,
    hasShadow: false,
    title: 'Real-timeTranslation',
    icon: appIconPath(),
    webPreferences: {
      preload: preloadPath,
      // 系统声音回环采集需要用户授权，两个页面共用同一套权限策略
      sandbox: false
    }
  })

  subtitleWindow.setOpacity(settings.transparency / 100)
  pipeRendererLogs(subtitleWindow, 'subtitle')
  loadRendererPage(subtitleWindow, 'index.html')

  subtitleWindow.on('moved', () => {
    const { x, y } = subtitleWindow!.getBounds()
    windowBounds = { x, y }
  })
  subtitleWindow.on('closed', () => {
    saveWindowBounds()
    subtitleWindow = null
    if (process.platform !== 'darwin') app.quit()
  })
}

function createSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus()
    return
  }
  settingsWindow = new BrowserWindow({
    width: 520,
    height: 720,
    title: '设置',
    resizable: true,
    autoHideMenuBar: true,
    icon: appIconPath(),
    webPreferences: {
      preload: preloadPath,
      sandbox: false
    }
  })
  loadRendererPage(settingsWindow, 'settings.html')
  settingsWindow.on('closed', () => {
    settingsWindow = null
  })
}

function broadcastSettings(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('settings:changed', settings)
  }
}

function registerIpc(): void {
  ipcMain.handle('settings:get', () => settings)

  ipcMain.handle('settings:set', (_event, patch: Partial<Settings>) => {
    settings = { ...settings, ...patch }
    saveSettings()
    applyPanelAppearance()
    broadcastSettings()
    return settings
  })

  ipcMain.handle('settings:open', () => {
    createSettingsWindow()
  })

  ipcMain.handle('window:minimize', () => {
    subtitleWindow?.minimize()
  })

  ipcMain.handle('window:close', () => {
    saveWindowBounds()
    app.quit()
  })
}

app.whenReady().then(() => {
  settings = loadSettings()
  registerIpc()
  createSubtitleWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createSubtitleWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
