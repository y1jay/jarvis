// iOS 시뮬레이터: xcrun simctl(부팅/스크린샷/앱 설치·실행) + AXe(터치/스와이프/입력 — 실제 마우스는 건드리지 않음).
// 화면은 창 없이(헤드리스) 부팅해 JARVIS 팝업 안으로 스트리밍한다.
import { execFile } from 'node:child_process'
import { readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function run(cmd: string, args: string[], timeout = 60000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ code: err ? 1 : 0, out: String(stdout || stderr || err?.message || '').trim() }))
  })
}

export interface SimDevice {
  udid: string
  name: string
  runtime: string
  state: string
}

let axePath: string | null | undefined
async function axe(): Promise<string | null> {
  if (axePath !== undefined) return axePath
  for (const p of ['/opt/homebrew/bin/axe', '/usr/local/bin/axe']) {
    const r = await run('test', ['-x', p])
    if (r.code === 0) return (axePath = p)
  }
  const w = await run('which', ['axe'])
  return (axePath = w.code === 0 && w.out ? w.out.split('\n')[0] : null)
}

/** "com.apple.CoreSimulator.SimRuntime.iOS-26-4" → "iOS 26.4" */
export function runtimeLabel(id: string): string {
  const m = /SimRuntime\.([a-zA-Z]+)-(\d+)-(\d+)/.exec(id)
  return m ? `${m[1]} ${m[2]}.${m[3]}` : id
}

export function parseSimctlList(json: string): SimDevice[] {
  const j = JSON.parse(json) as { devices: Record<string, Array<{ udid: string; name: string; state: string; isAvailable?: boolean }>> }
  const out: SimDevice[] = []
  for (const [rt, list] of Object.entries(j.devices)) {
    if (!/iOS/i.test(rt)) continue
    for (const d of list) if (d.isAvailable !== false) out.push({ udid: d.udid, name: d.name, runtime: runtimeLabel(rt), state: d.state })
  }
  // 최신 런타임 + iPhone 우선
  return out.sort((a, b) => (b.runtime.localeCompare(a.runtime, undefined, { numeric: true }) || Number(/iPhone/.test(b.name)) - Number(/iPhone/.test(a.name))))
}

export class IosSimulator {
  udid: string | null = null
  name: string | null = null
  /** 픽셀/포인트 비율 (스크린샷은 픽셀, AXe 좌표는 포인트) */
  scale = 3
  lastSize: { width: number; height: number } | null = null
  private bootedByJarvis = new Set<string>()
  private streamTimer: NodeJS.Timeout | null = null

  static available(): boolean {
    return process.platform === 'darwin'
  }

  async list(): Promise<SimDevice[]> {
    if (!IosSimulator.available()) return []
    const r = await run('xcrun', ['simctl', 'list', 'devices', 'available', '-j'])
    try {
      return parseSimctlList(r.out)
    } catch {
      return []
    }
  }

  async start(udid: string, onLog: (s: string) => void = () => undefined): Promise<{ ok: boolean; message: string }> {
    const dev = (await this.list()).find((d) => d.udid === udid)
    if (!dev) return { ok: false, message: `시뮬레이터를 찾지 못했습니다: ${udid}` }
    if (dev.state !== 'Booted') {
      onLog(`${dev.name} 부팅 중…`)
      const b = await run('xcrun', ['simctl', 'boot', udid], 120000)
      if (b.code !== 0 && !/current state: Booted/i.test(b.out)) return { ok: false, message: `부팅 실패: ${b.out.slice(0, 200)}` }
      this.bootedByJarvis.add(udid)
    }
    await run('xcrun', ['simctl', 'bootstatus', udid, '-b'], 240000)
    this.udid = udid
    this.name = dev.name
    // 스케일 계산: 스크린샷 픽셀 ÷ 루트 요소 포인트 폭
    try {
      const png = await this.screencap()
      const ui = await this.describe()
      const w = /"width"\s*:\s*([\d.]+)/.exec(ui)
      if (w && png.length) this.scale = Math.max(1, Math.round((this.lastSize?.width ?? 1170) / Number(w[1])))
    } catch {
      /* 기본 3배 */
    }
    return { ok: true, message: `${dev.name} (${dev.runtime}) 준비 완료` }
  }

  /** JARVIS 가 켠 시뮬레이터만 끈다 (사용자가 원래 켜 둔 것은 그대로) */
  async stop(): Promise<string> {
    this.stopStream()
    const u = this.udid
    this.udid = null
    if (u && this.bootedByJarvis.has(u)) {
      await run('xcrun', ['simctl', 'shutdown', u])
      this.bootedByJarvis.delete(u)
      return '시뮬레이터를 종료했습니다.'
    }
    return '시뮬레이터 화면을 닫았습니다 (원래 켜져 있던 기기라 종료하지 않았습니다).'
  }

  private need(): string {
    if (!this.udid) throw new Error('실행 중인 iOS 시뮬레이터가 없습니다. device_start 로 먼저 켜세요.')
    return this.udid
  }

  async screencap(): Promise<Buffer> {
    const u = this.need()
    const f = join(tmpdir(), `jarvis-ios-${process.pid}-${Date.now()}.png`)
    const r = await run('xcrun', ['simctl', 'io', u, 'screenshot', '--type=png', f], 20000)
    if (r.code !== 0) throw new Error(`스크린샷 실패: ${r.out}`)
    const buf = readFileSync(f)
    try {
      unlinkSync(f)
    } catch {
      /* ignore */
    }
    if (buf.readUInt32BE(12) === 0x49484452) this.lastSize = { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
    return buf
  }

  startStream(onFrame: (png: Buffer, size: { width: number; height: number } | null) => void, fps = 3): void {
    this.stopStream()
    let busy = false
    this.streamTimer = setInterval(async () => {
      if (busy || !this.udid) return
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

  private async axe(args: string[]): Promise<{ code: number; out: string }> {
    const a = await axe()
    if (!a) return { code: 1, out: 'AXe 가 설치되어 있지 않아 터치 조작을 할 수 없습니다 (brew install cameroncooke/axe/axe).' }
    return run(a, [...args, '--udid', this.need()], 30000)
  }

  /** 좌표는 스크린샷 픽셀 기준 → 포인트로 변환 */
  tap(xPx: number, yPx: number) {
    return this.axe(['tap', '-x', String(Math.round(xPx / this.scale)), '-y', String(Math.round(yPx / this.scale))])
  }
  tapLabel(label: string) {
    return this.axe(['tap', '--label', label, '--wait-timeout', '5'])
  }
  swipe(x1: number, y1: number, x2: number, y2: number) {
    const s = (v: number): string => String(Math.round(v / this.scale))
    return this.axe(['swipe', '--start-x', s(x1), '--start-y', s(y1), '--end-x', s(x2), '--end-y', s(y2)])
  }
  type(text: string) {
    return this.axe(['type', text])
  }
  home() {
    return this.axe(['button', 'home'])
  }
  describe(): Promise<string> {
    return this.axe(['describe-ui']).then((r) => r.out)
  }
  async screenshotFile(): Promise<string> {
    const f = join(tmpdir(), `jarvis-ios-shot-${Date.now()}.png`)
    const r = await run('xcrun', ['simctl', 'io', this.need(), 'screenshot', '--type=png', f])
    if (r.code !== 0) throw new Error(r.out)
    return f
  }
  install(appPath: string) {
    return run('xcrun', ['simctl', 'install', this.need(), appPath], 180000)
  }
  launch(bundleId: string) {
    return run('xcrun', ['simctl', 'launch', this.need(), bundleId])
  }
  openUrl(url: string) {
    return run('xcrun', ['simctl', 'openurl', this.need(), url])
  }
}
