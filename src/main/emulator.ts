// 안드로이드 에뮬레이터: AVD 실행(창 없이) → JARVIS 화면 안으로 스트리밍(adb screencap) → 탭/스와이프/입력/키.
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

export function sdkPath(): string | null {
  const cands = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.platform === 'darwin' ? join(homedir(), 'Library', 'Android', 'sdk') : null,
    process.platform === 'win32' ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Android', 'Sdk') : null,
    join(homedir(), 'Android', 'Sdk')
  ].filter(Boolean) as string[]
  return cands.find((p) => existsSync(p)) ?? null
}

const exe = (name: string): string => (process.platform === 'win32' ? `${name}.exe` : name)

export function adbPath(): string | null {
  const s = sdkPath()
  const p = s ? join(s, 'platform-tools', exe('adb')) : null
  return p && existsSync(p) ? p : null
}

export function emulatorPath(): string | null {
  const s = sdkPath()
  const p = s ? join(s, 'emulator', exe('emulator')) : null
  return p && existsSync(p) ? p : null
}

function run(cmd: string, args: string[], opts: { timeout?: number; encoding?: 'buffer' } = {}): Promise<{ code: number; out: string; buf?: Buffer }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: opts.timeout ?? 30000, maxBuffer: 64 * 1024 * 1024, encoding: opts.encoding === 'buffer' ? 'buffer' : 'utf8' }, (err, stdout, stderr) => {
      if (opts.encoding === 'buffer') resolve({ code: err ? 1 : 0, out: String(stderr || err?.message || ''), buf: stdout as unknown as Buffer })
      else resolve({ code: err ? 1 : 0, out: String(stdout || stderr || err?.message || '').trim() })
    })
  })
}

export interface Device {
  serial: string
  state: string
  avd?: string
}

/** adb shell input text 용 이스케이프 (ASCII). 공백은 %s */
export function escapeInputText(t: string): string {
  return t.replace(/([\\"'`$&|;<>()*?#~!{}[\]])/g, '\\$1').replace(/ /g, '%s')
}

export class Emulator {
  private proc: ChildProcess | null = null
  private streamTimer: NodeJS.Timeout | null = null
  serial: string | null = null
  lastSize: { width: number; height: number } | null = null

  async listAvds(): Promise<string[]> {
    const e = emulatorPath()
    if (!e) return []
    const r = await run(e, ['-list-avds'])
    return r.out.split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('INFO'))
  }

  async devices(): Promise<Device[]> {
    const adb = adbPath()
    if (!adb) return []
    const r = await run(adb, ['devices'])
    const out: Device[] = []
    for (const line of r.out.split('\n').slice(1)) {
      const [serial, state] = line.trim().split(/\s+/)
      if (!serial) continue
      let avd: string | undefined
      if (serial.startsWith('emulator-') && state === 'device') {
        const n = await run(adb, ['-s', serial, 'emu', 'avd', 'name'])
        avd = n.out.split('\n')[0]?.trim()
      }
      out.push({ serial, state, avd })
    }
    return out
  }

  /** AVD 실행(이미 켜져 있으면 재사용) → 부팅 완료까지 대기 */
  async start(avd: string, onLog: (s: string) => void = () => undefined): Promise<{ ok: boolean; serial?: string; message: string }> {
    const e = emulatorPath()
    const adb = adbPath()
    if (!e || !adb) return { ok: false, message: 'Android SDK(에뮬레이터/adb)를 찾지 못했습니다. Android Studio 설치 또는 ANDROID_HOME 설정이 필요합니다.' }
    const running = (await this.devices()).find((d) => d.avd === avd && d.state === 'device')
    if (running) {
      this.serial = running.serial
      return { ok: true, serial: running.serial, message: `${avd} 이미 실행 중 (${running.serial})` }
    }
    // 창 없이 실행 → 화면은 JARVIS 안에서 스트리밍
    this.proc = spawn(e, ['-avd', avd, '-no-window', '-no-audio', '-no-boot-anim', '-netdelay', 'none', '-netspeed', 'full'], { detached: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let exited = ''
    this.proc.stdout?.on('data', (d) => onLog(String(d).trim().split('\n').pop() ?? ''))
    this.proc.stderr?.on('data', (d) => onLog(String(d).trim().split('\n').pop() ?? ''))
    this.proc.on('exit', (code) => (exited = `에뮬레이터 프로세스 종료 (code ${code})`))
    const deadline = Date.now() + 300_000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000))
      if (exited) return { ok: false, message: `${avd} 실행 실패: ${exited}. 다른 곳에서 같은 AVD 가 실행 중인지 확인하세요.` }
      // 기기 번호(emulator-5554 등)는 재사용될 수 있으므로 AVD 이름으로 찾는다
      const d = (await this.devices()).find((x) => x.serial.startsWith('emulator-') && x.state === 'device' && x.avd === avd)
      if (!d) {
        onLog('부팅 중…')
        continue
      }
      this.serial = d.serial
      const boot = await run(adb, ['-s', d.serial, 'shell', 'getprop', 'sys.boot_completed'])
      if (boot.out.trim() === '1') {
        await run(adb, ['-s', d.serial, 'shell', 'input', 'keyevent', '82']) // 잠금 해제
        return { ok: true, serial: d.serial, message: `${avd} 부팅 완료 (${d.serial})` }
      }
      onLog('부팅 중…')
    }
    return { ok: false, message: `${avd} 부팅 시간 초과` }
  }

  async stop(): Promise<void> {
    this.stopStream()
    const adb = adbPath()
    if (adb && this.serial) await run(adb, ['-s', this.serial, 'emu', 'kill'])
    this.proc = null
    this.serial = null
  }

  private async adb(args: string[], timeout?: number) {
    const adb = adbPath()
    if (!adb || !this.serial) throw new Error('실행 중인 에뮬레이터가 없습니다. emulator_start 로 먼저 켜세요.')
    return run(adb, ['-s', this.serial, ...args], { timeout })
  }

  async screencap(): Promise<Buffer> {
    const adb = adbPath()
    if (!adb || !this.serial) throw new Error('실행 중인 에뮬레이터가 없습니다.')
    const r = await run(adb, ['-s', this.serial, 'exec-out', 'screencap', '-p'], { encoding: 'buffer', timeout: 15000 })
    if (!r.buf || r.buf.length < 100) throw new Error(`화면 캡처 실패: ${r.out}`)
    // PNG 헤더에서 크기 읽기
    if (r.buf.readUInt32BE(12) === 0x49484452) this.lastSize = { width: r.buf.readUInt32BE(16), height: r.buf.readUInt32BE(20) }
    return r.buf
  }

  async screenshotFile(): Promise<string> {
    const f = join(tmpdir(), `jarvis-emulator-${Date.now()}.png`)
    writeFileSync(f, await this.screencap())
    return f
  }

  /** JARVIS 화면으로 프레임 스트리밍 */
  startStream(onFrame: (png: Buffer, size: { width: number; height: number } | null) => void, fps = 4): void {
    this.stopStream()
    let busy = false
    this.streamTimer = setInterval(async () => {
      if (busy || !this.serial) return
      busy = true
      try {
        onFrame(await this.screencap(), this.lastSize)
      } catch {
        /* 일시 실패 무시 */
      } finally {
        busy = false
      }
    }, Math.round(1000 / fps))
  }

  stopStream(): void {
    if (this.streamTimer) clearInterval(this.streamTimer)
    this.streamTimer = null
  }

  tap(x: number, y: number) {
    return this.adb(['shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))])
  }
  swipe(x1: number, y1: number, x2: number, y2: number, ms = 300) {
    return this.adb(['shell', 'input', 'swipe', ...[x1, y1, x2, y2].map((v) => String(Math.round(v))), String(ms)])
  }
  /** ASCII 텍스트 입력 (한글은 adb input 미지원) */
  text(t: string) {
    return this.adb(['shell', 'input', 'text', escapeInputText(t)])
  }
  key(k: string) {
    const map: Record<string, string> = { back: '4', home: '3', recent: '187', enter: '66', delete: '67', menu: '82', power: '26', volume_up: '24', volume_down: '25', tab: '61' }
    return this.adb(['shell', 'input', 'keyevent', map[k.toLowerCase()] ?? k])
  }
  install(apk: string) {
    return this.adb(['install', '-r', apk], 180000)
  }
  launch(pkg: string) {
    return this.adb(['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1'])
  }
  shell(cmd: string) {
    return this.adb(['shell', cmd])
  }
}
