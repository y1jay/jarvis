// 앱 아이콘 / 트레이 아이콘 생성 (SVG → PNG, Electron 오프스크린 렌더링)
// 실행: node scripts/run-electron.mjs scripts/make-icon.mjs
import { app, BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'build')
mkdirSync(out, { recursive: true })

const ring = (r, w, color, dash = '') => `<circle cx="512" cy="512" r="${r}" fill="none" stroke="${color}" stroke-width="${w}" ${dash ? `stroke-dasharray="${dash}"` : ''}/>`

const APP_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <radialGradient id="bg" cx="50%" cy="45%" r="70%"><stop offset="0" stop-color="#0b2a44"/><stop offset="1" stop-color="#02070d"/></radialGradient>
    <radialGradient id="core" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#ffffff"/><stop offset="0.35" stop-color="#9af0ff"/><stop offset="1" stop-color="#38d6ff" stop-opacity="0"/></radialGradient>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="14" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  <rect x="64" y="64" width="896" height="896" rx="200" fill="url(#bg)"/>
  <rect x="64" y="64" width="896" height="896" rx="200" fill="none" stroke="#38d6ff" stroke-opacity="0.35" stroke-width="6"/>
  <g filter="url(#glow)">
    ${ring(330, 10, '#38d6ff', '40 18')}
    ${ring(280, 26, '#38d6ff')}
    ${ring(230, 6, '#9af0ff', '6 14')}
    ${Array.from({ length: 10 }, (_, i) => {
      const a = (i / 10) * Math.PI * 2
      const x1 = 512 + Math.cos(a) * 170, y1 = 512 + Math.sin(a) * 170
      const x2 = 512 + Math.cos(a) * 262, y2 = 512 + Math.sin(a) * 262
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#38d6ff" stroke-width="30" stroke-linecap="round" stroke-opacity="0.85"/>`
    }).join('')}
    <polygon points="512,400 610,570 414,570" fill="none" stroke="#e8fdff" stroke-width="18" stroke-linejoin="round"/>
    <circle cx="512" cy="512" r="150" fill="url(#core)"/>
  </g>
</svg>`

// macOS 메뉴바용 템플릿 (검정 + 투명, 시스템이 색을 입힘)
const TRAY_TEMPLATE = (s) => `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 22 22">
  <circle cx="11" cy="11" r="9" fill="none" stroke="#000" stroke-width="1.6"/>
  <circle cx="11" cy="11" r="5.6" fill="none" stroke="#000" stroke-width="1.2" stroke-dasharray="2 1.4"/>
  <polygon points="11,7.6 14,12.8 8,12.8" fill="#000"/>
</svg>`

// Windows 트레이 (컬러)
const TRAY_COLOR = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 22 22">
  <circle cx="11" cy="11" r="10" fill="#02070d"/>
  <circle cx="11" cy="11" r="8.4" fill="none" stroke="#38d6ff" stroke-width="1.8"/>
  <circle cx="11" cy="11" r="5" fill="none" stroke="#9af0ff" stroke-width="1.2" stroke-dasharray="2 1.4"/>
  <polygon points="11,7.6 14,12.8 8,12.8" fill="#e8fdff"/>
</svg>`

async function render(svg, size, file) {
  // 작은 창은 로드가 실패할 수 있어 크게 그린 뒤 줄인다
  const draw = Math.max(size, 512)
  const w = new BrowserWindow({ width: draw, height: draw, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } })
  const html = `<html><body style="margin:0;background:transparent">${svg.replace(/width="\d+" height="\d+"/, `width="${draw}" height="${draw}"`)}</body></html>`
  await w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  await new Promise((r) => setTimeout(r, 300))
  const img = await w.webContents.capturePage({ x: 0, y: 0, width: draw, height: draw })
  writeFileSync(join(out, file), img.resize({ width: size, height: size }).toPNG())
  w.destroy()
  console.log('[icon]', file, size)
}

app.disableHardwareAcceleration()
app.on('window-all-closed', () => undefined) // 렌더 창을 닫아도 앱이 끝나지 않게
app.whenReady().then(async () => {
  await render(APP_ICON, 1024, 'icon.png')
  await render(TRAY_TEMPLATE(22), 22, 'trayTemplate.png')
  await render(TRAY_TEMPLATE(44), 44, 'trayTemplate@2x.png')
  await render(TRAY_COLOR, 32, 'tray.png')
  app.quit()
})
