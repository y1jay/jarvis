// 시스템 제어: 앱 열기/종료, URL, 파일 탐색기, 클립보드, 알림, 스크린샷.
// Mac / Windows 각각의 OS 명령을 사용한다. 파괴적 작업은 여기 없다(삭제/강제종료 미제공).
import { execFile, spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'

export interface AppEntry {
  name: string
  /** mac: .app 경로 / win: .lnk 또는 .exe 경로 */
  path: string
}

// 말로 부르는 이름 → 실제 앱 이름 후보
export const APP_ALIASES: Record<string, string[]> = {
  크롬: ['Google Chrome', 'Chrome'],
  구글크롬: ['Google Chrome'],
  사파리: ['Safari'],
  엣지: ['Microsoft Edge'],
  파이어폭스: ['Firefox'],
  슬랙: ['Slack'],
  카톡: ['카카오톡', 'KakaoTalk'],
  카카오톡: ['카카오톡', 'KakaoTalk'],
  텔레그램: ['Telegram'],
  디스코드: ['Discord'],
  줌: ['zoom.us', 'Zoom'],
  노션: ['Notion'],
  피그마: ['Figma'],
  터미널: ['Terminal', 'Windows Terminal', 'iTerm'],
  아이텀: ['iTerm'],
  파인더: ['Finder'],
  탐색기: ['File Explorer', 'Explorer'],
  메모: ['Notes', 'Notepad'],
  메모장: ['Notepad', 'Notes', 'TextEdit'],
  텍스트편집기: ['TextEdit', 'Notepad'],
  캘린더: ['Calendar'],
  달력: ['Calendar'],
  메일: ['Mail', 'Outlook'],
  계산기: ['Calculator'],
  사진: ['Photos'],
  음악: ['Music'],
  스포티파이: ['Spotify'],
  설정: ['System Settings', 'System Preferences', 'Settings'],
  시스템설정: ['System Settings', 'System Preferences', 'Settings'],
  환경설정: ['System Settings', 'System Preferences'],
  코드: ['Visual Studio Code', 'Code'],
  vs코드: ['Visual Studio Code'],
  브이에스코드: ['Visual Studio Code'],
  비주얼스튜디오코드: ['Visual Studio Code'],
  vscode: ['Visual Studio Code'],
  커서: ['Cursor'],
  엑스코드: ['Xcode'],
  안드로이드스튜디오: ['Android Studio'],
  도커: ['Docker', 'Docker Desktop'],
  디비버: ['DBeaver'],
  포크: ['Fork'],
  포스트맨: ['Postman'],
  유니티: ['Unity Hub', 'Unity'],
  블렌더: ['Blender'],
  엑셀: ['Microsoft Excel', 'Numbers'],
  워드: ['Microsoft Word', 'Pages'],
  파워포인트: ['Microsoft PowerPoint', 'Keynote'],
  키노트: ['Keynote'],
  넘버스: ['Numbers'],
  페이지스: ['Pages'],
  앱스토어: ['App Store'],
  활동모니터: ['Activity Monitor'],
  작업관리자: ['Task Manager'],
  미리보기: ['Preview'],
  아이무비: ['iMovie'],
  개러지밴드: ['GarageBand']
}

export const SITE_ALIASES: Record<string, string> = {
  유튜브: 'https://www.youtube.com',
  youtube: 'https://www.youtube.com',
  구글: 'https://www.google.com',
  google: 'https://www.google.com',
  네이버: 'https://www.naver.com',
  naver: 'https://www.naver.com',
  깃허브: 'https://github.com',
  github: 'https://github.com',
  지메일: 'https://mail.google.com',
  gmail: 'https://mail.google.com',
  챗지피티: 'https://chatgpt.com',
  클로드: 'https://claude.ai',
  제미나이: 'https://gemini.google.com',
  다음: 'https://www.daum.net',
  넷플릭스: 'https://www.netflix.com',
  쿠팡: 'https://www.coupang.com',
  지도: 'https://map.naver.com'
}

export const FOLDER_ALIASES: Record<string, string> = {
  다운로드: 'Downloads',
  다운로드폴더: 'Downloads',
  downloads: 'Downloads',
  문서: 'Documents',
  documents: 'Documents',
  데스크탑: 'Desktop',
  바탕화면: 'Desktop',
  desktop: 'Desktop',
  홈: '',
  홈폴더: '',
  사진폴더: 'Pictures',
  음악폴더: 'Music'
}

const n = (s: string): string => s.toLowerCase().replace(/[\s\-_.]/g, '')

// ── 앱 목록 ──
export function listApps(): AppEntry[] {
  const out: AppEntry[] = []
  const seen = new Set<string>()
  const add = (name: string, path: string): void => {
    const k = n(name)
    if (seen.has(k)) return
    seen.add(k)
    out.push({ name, path })
  }
  if (process.platform === 'darwin') {
    const dirs = ['/Applications', '/Applications/Utilities', '/System/Applications', '/System/Applications/Utilities', join(homedir(), 'Applications'), '/System/Library/CoreServices']
    for (const d of dirs) {
      let entries: string[] = []
      try {
        entries = readdirSync(d)
      } catch {
        continue
      }
      for (const e of entries) {
        if (e.endsWith('.app')) add(e.slice(0, -4), join(d, e))
        else if (!e.startsWith('.') && d === '/Applications') {
          // /Applications/<Vendor>/<App>.app
          try {
            for (const x of readdirSync(join(d, e))) if (x.endsWith('.app')) add(x.slice(0, -4), join(d, e, x))
          } catch {
            /* ignore */
          }
        }
      }
    }
  } else if (process.platform === 'win32') {
    const dirs = [
      join(process.env.ProgramData ?? 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
      join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')
    ]
    const walk = (d: string, depth: number): void => {
      let entries: string[] = []
      try {
        entries = readdirSync(d)
      } catch {
        return
      }
      for (const e of entries) {
        const p = join(d, e)
        if (extname(e).toLowerCase() === '.lnk' && !/uninstall|제거/i.test(e)) add(basename(e, '.lnk'), p)
        else if (depth > 0) {
          try {
            if (statSync(p).isDirectory()) walk(p, depth - 1)
          } catch {
            /* ignore */
          }
        }
      }
    }
    for (const d of dirs) walk(d, 3)
    // Windows 기본 앱 (시작 메뉴에 .lnk 가 없는 것)
    for (const [name, exe] of [
      ['Notepad', 'notepad.exe'],
      ['Calculator', 'calc.exe'],
      ['File Explorer', 'explorer.exe'],
      ['Task Manager', 'taskmgr.exe'],
      ['Settings', 'ms-settings:'],
      ['Windows Terminal', 'wt.exe']
    ])
      add(name, exe)
  }
  return out
}

/** 0~1 */
function appScore(query: string, name: string): number {
  const q = n(query)
  const a = n(name)
  if (!q) return 0
  if (q === a) return 1
  if (a.startsWith(q) && q.length >= 3) return 0.85
  if (a.includes(q) && q.length >= 3) return 0.7
  return 0
}

export function resolveApp(query: string, apps: AppEntry[]): AppEntry | null {
  const q = n(query).replace(/(앱|어플|프로그램|애플리케이션|app)$/, '')
  const names = APP_ALIASES[q] ?? []
  // 별칭 우선
  for (const alias of names) {
    const hit = apps.find((x) => n(x.name) === n(alias))
    if (hit) return hit
  }
  for (const alias of names) {
    const hit = apps.find((x) => n(x.name).includes(n(alias)))
    if (hit) return hit
  }
  let best: { a: AppEntry; s: number } | null = null
  for (const a of apps) {
    const s = appScore(q, a.name)
    if (s > (best?.s ?? 0)) best = { a, s }
  }
  return best && best.s >= 0.7 ? best.a : null
}

export function resolveSite(query: string): string | null {
  const q = query.trim()
  if (/^https?:\/\//i.test(q)) return q
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(q)) return `https://${q}`
  return SITE_ALIASES[n(q).replace(/(사이트|홈페이지|웹사이트)$/, '')] ?? null
}

export function resolveFolder(query: string): string | null {
  const q = n(query).replace(/폴더$/, '') || n(query)
  const key = FOLDER_ALIASES[n(query)] !== undefined ? n(query) : q
  if (FOLDER_ALIASES[key] === undefined) return null
  const p = join(homedir(), FOLDER_ALIASES[key])
  return existsSync(p) ? p : null
}

// ── 실행 ──
function run(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 20000 }, (err, stdout, stderr) => {
      resolve({ code: err ? 1 : 0, out: String(stdout || stderr || err?.message || '').trim() })
    })
  })
}

export async function openApp(app: AppEntry): Promise<{ ok: boolean; message: string }> {
  if (process.platform === 'darwin') {
    const r = await run('open', ['-a', app.path])
    return { ok: r.code === 0, message: r.code === 0 ? `${app.name} 실행` : r.out }
  }
  if (process.platform === 'win32') {
    // start "" "<path>" — .lnk / .exe / ms-settings: 모두 처리
    const child = spawn('cmd.exe', ['/c', 'start', '""', app.path], { windowsHide: true, detached: true, stdio: 'ignore' })
    child.unref()
    return { ok: true, message: `${app.name} 실행` }
  }
  const r = await run('xdg-open', [app.path])
  return { ok: r.code === 0, message: r.out }
}

/** 정상 종료 요청 (저장 안 된 문서가 있으면 앱이 직접 물어본다). 강제 종료는 제공하지 않는다. */
export async function quitApp(name: string): Promise<{ ok: boolean; message: string }> {
  if (process.platform === 'darwin') {
    const safe = name.replace(/["\\]/g, '')
    const r = await run('osascript', ['-e', `tell application "${safe}" to quit`])
    return { ok: r.code === 0, message: r.code === 0 ? `${name} 종료 요청` : r.out }
  }
  if (process.platform === 'win32') {
    const exe = name.toLowerCase().endsWith('.exe') ? name : `${name}.exe`
    const r = await run('taskkill', ['/IM', exe]) // /F 없음 = 정상 종료 요청
    return { ok: r.code === 0, message: r.out }
  }
  return { ok: false, message: '지원하지 않는 OS' }
}

export async function openUrl(url: string): Promise<{ ok: boolean; message: string }> {
  if (!/^https?:\/\//i.test(url)) return { ok: false, message: 'http(s) URL 만 열 수 있습니다' }
  const { shell } = await import('electron')
  await shell.openExternal(url)
  return { ok: true, message: `${url} 열기` }
}

export async function revealPath(p: string): Promise<{ ok: boolean; message: string }> {
  if (!existsSync(p)) return { ok: false, message: `경로 없음: ${p}` }
  const { shell } = await import('electron')
  if (statSync(p).isDirectory()) {
    const err = await shell.openPath(p)
    return { ok: !err, message: err || `${p} 열기` }
  }
  shell.showItemInFolder(p)
  return { ok: true, message: `${p} 위치 표시` }
}

export async function openFile(p: string): Promise<{ ok: boolean; message: string }> {
  if (!existsSync(p)) return { ok: false, message: `경로 없음: ${p}` }
  const { shell } = await import('electron')
  const err = await shell.openPath(p)
  return { ok: !err, message: err || `${p} 열기` }
}

export const SCREEN_PERMISSION_MSG = '화면 기록 권한이 필요합니다. 시스템 설정 → 개인정보 보호 및 보안 → 화면 및 시스템 오디오 기록 에서 JARVIS 를 허용해 주세요 (설정 화면을 열었습니다).'
let screenPromptShown = false

export async function screenshot(): Promise<{ ok: boolean; path?: string; message: string }> {
  const file = join(tmpdir(), `jarvis-screenshot-${Date.now()}.png`)
  if (process.platform === 'darwin') {
    const { systemPreferences, shell } = await import('electron')
    if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
      // 권한은 사용자만 줄 수 있다 → 설정 화면을 열어 안내 (최초 1회)
      if (!screenPromptShown) {
        screenPromptShown = true
        await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture').catch(() => undefined)
      }
      return { ok: false, message: SCREEN_PERMISSION_MSG }
    }
    const r = await run('screencapture', ['-x', file])
    return existsSync(file) ? { ok: true, path: file, message: file } : { ok: false, message: r.out || SCREEN_PERMISSION_MSG }
  }
  if (process.platform === 'win32') {
    const ps = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $bmp.Save('${file.replace(/'/g, "''")}')`
    const r = await run('powershell.exe', ['-NoProfile', '-Command', ps])
    return existsSync(file) ? { ok: true, path: file, message: file } : { ok: false, message: r.out }
  }
  return { ok: false, message: '지원하지 않는 OS' }
}

// ── 의도 파싱: "크롬 열어줘" / "카톡 종료해줘" ──
export interface AppIntent {
  verb: 'open' | 'quit'
  target: string
  rest: string
}

export function parseQuitIntent(text: string): AppIntent | null {
  const t = text.trim().replace(/[.!?]+$/, '')
  const m = /^(.+?)\s*(?:앱|어플|프로그램)?\s*(?:을|를|좀)?\s*(종료해\s*줘|종료해|종료|꺼\s*줘|꺼|닫아\s*줘|닫아|끝내\s*줘|quit|close)\s*(.*)$/i.exec(t)
  if (!m) return null
  const target = m[1].replace(/^(지금|그럼|이제)\s+/, '').trim()
  if (!target || target.length > 40) return null
  return { verb: 'quit', target, rest: m[3].replace(/^[\s,]*(그리고|고|하고)?\s*/, '').trim() }
}
