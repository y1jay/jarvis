// 데스크톱 제어: 앱 활성화, 텍스트 입력(클립보드 붙여넣기 — 한글 안전), 키 입력, 마우스 클릭, 메신저 메시지 준비/전송.
// macOS: osascript(System Events) + cliclick(있으면) / JXA CGEvent. Windows: PowerShell(SendKeys, user32).
// macOS 는 최초 사용 시 "손쉬운 사용" 권한을 요청한다.
import { execFile } from 'node:child_process'

export interface RunOut {
  code: number
  out: string
}

function run(cmd: string, args: string[], timeout = 20000): Promise<RunOut> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout }, (err, stdout, stderr) => resolve({ code: err ? 1 : 0, out: String(stdout || stderr || err?.message || '').trim() }))
  })
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const isMac = process.platform === 'darwin'
const isWin = process.platform === 'win32'
export interface Clip {
  read: () => string | Promise<string>
  write: (t: string) => void
}

const asStr = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

export const PERMISSION_HINT = isMac
  ? '시스템 설정 → 개인정보 보호 및 보안 → 손쉬운 사용 에서 JARVIS(개발 중에는 Electron/터미널)를 허용해 주세요.'
  : ''

function permissionError(out: string): boolean {
  return /not allowed|-1719|-25211|1002|assistive access|접근이 허용되지/i.test(out)
}

export async function activateApp(name: string): Promise<RunOut> {
  if (isMac) {
    const r = await run('osascript', ['-e', `tell application ${asStr(name)} to activate`])
    await sleep(600)
    return r
  }
  if (isWin) return run('powershell.exe', ['-NoProfile', '-Command', `$w=New-Object -ComObject WScript.Shell; [void]$w.AppActivate(${asStr(name)})`])
  return { code: 1, out: '지원하지 않는 OS' }
}

/** 클립보드에 넣고 붙여넣기 (한글/이모지 안전). 기존 클립보드는 복원. */
export async function typeText(text: string, clip: Clip): Promise<RunOut> {
  const saved = await clip.read()
  clip.write(text)
  await sleep(120)
  const r = await keyCombo(isMac ? 'cmd+v' : 'ctrl+v')
  await sleep(250)
  clip.write(saved)
  return r
}

const MAC_KEYCODES: Record<string, number> = { enter: 36, return: 36, tab: 48, space: 49, delete: 51, backspace: 51, escape: 53, esc: 53, left: 123, right: 124, down: 125, up: 126, home: 115, end: 119, pageup: 116, pagedown: 121 }
const WIN_KEYS: Record<string, string> = { enter: '{ENTER}', return: '{ENTER}', tab: '{TAB}', space: ' ', delete: '{DEL}', backspace: '{BACKSPACE}', escape: '{ESC}', esc: '{ESC}', left: '{LEFT}', right: '{RIGHT}', down: '{DOWN}', up: '{UP}', home: '{HOME}', end: '{END}', pageup: '{PGUP}', pagedown: '{PGDN}' }

/** "cmd+shift+k", "enter", "ctrl+f" */
export async function keyCombo(combo: string): Promise<RunOut> {
  const parts = combo.toLowerCase().split('+').map((s) => s.trim())
  const key = parts.pop()!
  const mods = parts
  if (isMac) {
    const using = mods
      .map((m) => (m === 'cmd' || m === 'command' || m === 'meta' ? 'command down' : m === 'shift' ? 'shift down' : m === 'alt' || m === 'option' ? 'option down' : m === 'ctrl' || m === 'control' ? 'control down' : ''))
      .filter(Boolean)
    const usingStr = using.length ? ` using {${using.join(', ')}}` : ''
    const action = MAC_KEYCODES[key] !== undefined ? `key code ${MAC_KEYCODES[key]}${usingStr}` : `keystroke ${asStr(key)}${usingStr}`
    const r = await run('osascript', ['-e', `tell application "System Events" to ${action}`])
    if (r.code !== 0 && permissionError(r.out)) return { code: 1, out: `손쉬운 사용 권한이 필요합니다. ${PERMISSION_HINT}` }
    return r
  }
  if (isWin) {
    const m = mods.map((x) => (x === 'ctrl' || x === 'control' || x === 'cmd' ? '^' : x === 'shift' ? '+' : x === 'alt' ? '%' : '')).join('')
    const k = WIN_KEYS[key] ?? (key.length === 1 ? key : `{${key.toUpperCase()}}`)
    return run('powershell.exe', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${m}${k.replace(/'/g, "''")}')`])
  }
  return { code: 1, out: '지원하지 않는 OS' }
}

export async function click(x: number, y: number, opts: { double?: boolean; right?: boolean } = {}): Promise<RunOut> {
  x = Math.round(x)
  y = Math.round(y)
  if (isMac) {
    const cli = await run('which', ['cliclick'])
    if (cli.code === 0 && cli.out) return run(cli.out.split('\n')[0], [`${opts.right ? 'rc' : opts.double ? 'dc' : 'c'}:${x},${y}`])
    const btn = opts.right ? ['kCGEventRightMouseDown', 'kCGEventRightMouseUp', 'kCGMouseButtonRight'] : ['kCGEventLeftMouseDown', 'kCGEventLeftMouseUp', 'kCGMouseButtonLeft']
    const js = `ObjC.import('CoreGraphics'); const p=$.CGPointMake(${x},${y}); for (let i=0;i<${opts.double ? 2 : 1};i++){ const d=$.CGEventCreateMouseEvent(null,$.${btn[0]},p,$.${btn[2]}); $.CGEventPost($.kCGHIDEventTap,d); const u=$.CGEventCreateMouseEvent(null,$.${btn[1]},p,$.${btn[2]}); $.CGEventPost($.kCGHIDEventTap,u); }`
    return run('osascript', ['-l', 'JavaScript', '-e', js])
  }
  if (isWin) {
    const down = opts.right ? '0x0008' : '0x0002'
    const up = opts.right ? '0x0010' : '0x0004'
    const ps = `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); [DllImport("user32.dll")] public static extern void mouse_event(int f,int x,int y,int d,int e);' -Name U -Namespace W; [W.U]::SetCursorPos(${x},${y}); 1..${opts.double ? 2 : 1} | % { [W.U]::mouse_event(${down},0,0,0,0); [W.U]::mouse_event(${up},0,0,0,0) }`
    return run('powershell.exe', ['-NoProfile', '-Command', ps])
  }
  return { code: 1, out: '지원하지 않는 OS' }
}

// ── 메신저 ──
export interface MessengerProfile {
  key: string
  name: string
  /** 실제 앱 이름 후보 (설치된 이름에 맞춰 활성화) */
  apps: string[]
  /** 대화방 찾기 단축키 */
  searchKey: string
  /** 검색 후 대화방 열기까지 대기(ms) */
  openDelay: number
}

const MOD = isMac ? 'cmd' : 'ctrl'
export const MESSENGERS: Record<string, MessengerProfile> = {
  kakaotalk: { key: 'kakaotalk', name: '카카오톡', apps: ['KakaoTalk', '카카오톡'], searchKey: `${MOD}+f`, openDelay: 1200 },
  slack: { key: 'slack', name: 'Slack', apps: ['Slack'], searchKey: `${MOD}+k`, openDelay: 1500 }
}

export function resolveMessenger(q: string): MessengerProfile | null {
  const s = q.toLowerCase().replace(/\s/g, '')
  if (/(카톡|카카오|kakao)/.test(s)) return MESSENGERS.kakaotalk
  if (/(슬랙|slack)/.test(s)) return MESSENGERS.slack
  return null
}

/**
 * 메시지 준비: 앱 활성화 → 대화방 검색 → 열기 → 입력창에 메시지 입력 (전송 X).
 * 전송은 사용자 승인 후 sendPrepared() 로.
 */
export async function prepareMessage(p: MessengerProfile, appName: string, to: string, text: string, clip: Clip): Promise<RunOut> {
  const a = await activateApp(appName)
  if (a.code !== 0) return { code: 1, out: `${p.name} 실행 실패: ${a.out}` }
  let r = await keyCombo(p.searchKey)
  if (r.code !== 0) return r
  await sleep(500)
  await typeText(to, clip)
  await sleep(p.openDelay)
  r = await keyCombo('enter')
  if (r.code !== 0) return r
  await sleep(p.openDelay)
  await typeText(text, clip)
  return { code: 0, out: `${p.name}: "${to}" 대화방에 메시지를 입력했습니다 (아직 전송 안 함).` }
}

export async function sendPrepared(): Promise<RunOut> {
  return keyCombo('enter')
}

/** 준비한 메시지 취소: 입력창 비우기 */
export async function discardPrepared(): Promise<RunOut> {
  await keyCombo(`${MOD}+a`)
  return keyCombo('delete')
}
