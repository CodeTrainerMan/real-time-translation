/** 每秒记录音轨 muted/readyState/enabled 与实测电平：electron scripts/track-state-probe.cjs */
const { app, BrowserWindow } = require('electron')
const path = require('path')

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } })
  await win.loadFile(path.join(__dirname, 'track-state-probe.html'))
  try {
    const res = await win.webContents.executeJavaScript('window.runProbe(12)', true)
    for (const r of res.rows) {
      console.log(`[track] t=${r.t}s muted=${r.muted} state=${r.readyState} enabled=${r.enabled} rms=${r.rms} samples=${r.samples}`)
    }
    console.log('[track] events=' + JSON.stringify(res.log))
    console.log('[track] settings=' + JSON.stringify(res.settings))
  } catch (e) {
    console.log('[track] FAILED ' + e.message)
  }
  app.quit()
})
