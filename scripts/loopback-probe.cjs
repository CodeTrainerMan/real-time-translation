/**
 * 诊断脚本：用和应用完全相同的路径采集系统声音，录 8 秒存成 16k wav，
 * 并报告电平（RMS / 峰值 / 静音比例），用来判断识别差到底是音频链路还是模型。
 */
const { app, BrowserWindow } = require('electron')
const path = require('path')

const OUT = 'E:/SY/project/Real-timeTranslation/.build-logs/loopback.wav'
const SECONDS = 8

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  })
  await win.loadFile(path.join(__dirname, 'loopback-probe.html'))
  try {
    const res = await win.webContents.executeJavaScript(`window.runProbe(${JSON.stringify(OUT)}, ${SECONDS})`, true)
    console.log('[loopback] ' + JSON.stringify(res))
  } catch (e) {
    console.log('[loopback] FAILED ' + e.message)
  }
  app.quit()
})
