/** 用与 audioCapture.ts 相同的 AudioWorklet 路径采集系统声音，检查是否真的有数据产出。 */
const { app, BrowserWindow } = require('electron')
const path = require('path')

const OUT = 'E:/SY/project/Real-timeTranslation/.build-logs/worklet.wav'
const SECONDS = 8

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  })
  await win.loadFile(path.join(__dirname, 'worklet-probe.html'))
  try {
    const res = await win.webContents.executeJavaScript(`window.runProbe(${JSON.stringify(OUT)}, ${SECONDS})`, true)
    console.log('[worklet] ' + JSON.stringify(res))
  } catch (e) {
    console.log('[worklet] FAILED ' + e.message)
  }
  app.quit()
})
