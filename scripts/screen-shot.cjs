/** 截一张主屏快照，用来查看字幕窗当前状态（诊断用）。 */
const { app, desktopCapturer } = require('electron')
const fs = require('fs')

const OUT = process.argv[2] || 'E:/SY/project/Real-timeTranslation/.build-logs/screen.png'

app.whenReady().then(async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 }
    })
    if (!sources.length) {
      console.log('[shot] 没有拿到屏幕源')
      app.quit()
      return
    }
    sources.forEach((s, i) => {
      const p = OUT.replace(/\.png$/, `-${i}.png`)
      fs.writeFileSync(p, s.thumbnail.toPNG())
      console.log('[shot] 已保存 ' + p + ' name=' + s.name)
    })
  } catch (e) {
    console.log('[shot] FAILED ' + e.message)
  }
  app.quit()
})
