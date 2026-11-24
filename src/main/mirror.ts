// 앱 비춰 보기: 웹 버전이 없는 프로그램(카카오톡 등)의 창을 JARVIS 팝업에 실시간으로 비추고,
// 팝업에서 클릭·입력하면 실제 앱에 전달한다. (macOS: 화면 기록 + 손쉬운 사용 권한 필요)
// 웹 버전이 있는 앱(슬랙·크롬·노션 …)은 비추지 않고 JARVIS 브라우저 팝업으로 연다 → webAppUrl()
import { execFile } from 'node:child_process'
import { desktopCapturer } from 'electron'
import { activateApp, click, keyCombo, typeText, type Clip } from './computer'

/** 웹으로 열 수 있는 앱 → 주소 (JARVIS 브라우저 팝업으로) */
const WEB_APPS: Array<[RegExp, string]> = [
  [/^(크롬|구글\s*크롬|google chrome|chrome|브라우저|인터넷|사파리|safari|엣지|edge|파이어폭스|firefox)$/i, 'https://www.google.com'],
  [/^(슬랙|slack)$/i, 'https://app.slack.com/client'],
  [/^(노션|notion)$/i, 'https://www.notion.so'],
  [/^(지메일|gmail|구글\s*메일)$/i, 'https://mail.google.com'],
  [/^(구글\s*캘린더|google calendar)$/i, 'https://calendar.google.com'],
  [/^(구글\s*드라이브|드라이브|google drive)$/i, 'https://drive.google.com'],
  [/^(피그마|figma)$/i, 'https://www.figma.com/files'],
  [/^(디스코드|discord)$/i, 'https://discord.com/app'],
  [/^(텔레그램|telegram)$/i, 'https://web.telegram.org'],
  [/^(유튜브|youtube)$/i, 'https://www.youtube.com'],
  [/^(깃허브|github)$/i, 'https://github.com'],
  [/^(챗지피티|chatgpt)$/i, 'https://chatgpt.com']
]

export function webAppUrl(query: string): string | null {
  const q = query.trim().replace(/\s*(앱|어플|프로그램)$/, '')
  return WEB_APPS.find(([re]) => re.test(q))?.[1] ?? null
}

function osa(script: string): Promise<string> {
  return new Promise((resolve) => execFile('osascript', ['-e', script], { timeout: 8000 }, (_e, out) => resolve(String(out ?? '').trim())))
}
const q = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/** 앱 프로세스 이름 후보 (카카오톡 → KakaoTalk) */
export function processNames(app: string): string[] {
  const m: Record<string, string[]> = { 카카오톡: ['KakaoTalk', '카카오톡'], KakaoTalk: ['KakaoTalk', '카카오톡'] }
  return m[app] ?? [app]
}

export interface MirrorWindow {
  id: string
  title: string
}

/** 그 앱의 창들 (화면 기록 권한이 없으면 빈 목록) */
export async function appWindows(app: string): Promise<MirrorWindow[]> {
  let titles: string[] = []
  for (const p of processNames(app)) {
    const out = await osa(`tell application "System Events" to if exists process ${q(p)} then get name of every window of process ${q(p)}`)
    if (out) {
      titles = out.split(', ').map((t) => t.trim()).filter(Boolean)
      break
    }
  }
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } })
  const out: MirrorWindow[] = []
  for (const t of titles) {
    const s = sources.find((x) => x.name === t)
    if (s && !out.some((o) => o.id === s.id)) out.push({ id: s.id, title: t })
  }
  // 제목으로 못 찾으면(창 제목이 비어 있는 앱) 앱 이름이 들어간 창
  if (!out.length) for (const s of sources) if (processNames(app).some((n) => s.name.includes(n))) out.push({ id: s.id, title: s.name })
  return out
}

/** 창 위치·크기 (화면 좌표) */
export async function windowBounds(app: string, title: string): Promise<{ x: number; y: number; w: number; h: number } | null> {
  for (const p of processNames(app)) {
    const out = await osa(`tell application "System Events" to tell process ${q(p)} to get {position, size} of (first window whose name is ${q(title)})`)
    const n = out.split(/,\s*/).map(Number)
    if (n.length === 4 && n.every((v) => Number.isFinite(v))) return { x: n[0], y: n[1], w: n[2], h: n[3] }
  }
  return null
}

/** 팝업 안의 상대 위치(0~1)로 실제 창 클릭 — 앱을 앞으로 가져와 누른다 */
export async function mirrorClick(app: string, title: string, rx: number, ry: number, opts: { double?: boolean; right?: boolean } = {}): Promise<{ ok: boolean; message: string }> {
  const b = await windowBounds(app, title)
  if (!b) return { ok: false, message: '창 위치를 알 수 없습니다 (손쉬운 사용 권한을 확인해 주세요)' }
  for (const p of processNames(app)) if ((await activateApp(p)).code === 0) break
  await osa(`tell application "System Events" to tell process ${q(processNames(app)[0])} to perform action "AXRaise" of (first window whose name is ${q(title)})`)
  await new Promise((r) => setTimeout(r, 150))
  const r = await click(b.x + rx * b.w, b.y + ry * b.h, opts)
  return { ok: r.code === 0, message: r.out }
}

/** 실제 앱에 글자 입력 (한글 안전: 붙여넣기), enter 면 이어서 엔터 */
export async function mirrorType(app: string, text: string, enter: boolean, clip: Clip): Promise<{ ok: boolean; message: string }> {
  for (const p of processNames(app)) if ((await activateApp(p)).code === 0) break
  await new Promise((r) => setTimeout(r, 120))
  if (text) {
    const r = await typeText(text, clip)
    if (r.code !== 0) return { ok: false, message: r.out }
  }
  if (enter) await keyCombo('enter')
  return { ok: true, message: '' }
}
