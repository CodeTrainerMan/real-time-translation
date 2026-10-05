/**
 * 逐环节验证系统声音采集链路。
 * 同一时间窗口里跑 5 条路线对比电平，定位 WebAudio 链路在哪一步变静音。
 *
 * 用法：electron scripts/audio-chain-probe.cjs
 */
const { app, BrowserWindow } = require('electron')
const path = require('path')

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false, offscreen: false }
  })
  await win.loadFile(path.join(__dirname, 'audio-chain-probe.html'))
  try {
    const res = await win.webContents.executeJavaScript('window.runProbe()', true)
    for (const r of res) {
      console.log(
        `[chain] ${r.name} rate=${r.rate} rms=${Number(r.rms).toFixed(5)} peak=${Number(r.peak).toFixed(4)} silent=${r.silentPct}% samples=${r.samples} ${r.error ? 'err=' + r.error : ''}`
      )
      console.log(`[chain]   track=${r.trackInfo}`)
    }
  } catch (e) {
    console.log('[chain] FAILED ' + e.message)
  }
  app.quit()
})
