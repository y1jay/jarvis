// 안드로이드 에뮬레이터 / iOS 시뮬레이터를 하나의 인터페이스로. 화면은 JARVIS 팝업으로 스트리밍.
import { Emulator } from './emulator'
import { IosSimulator } from './simulator'

export type Platform = 'android' | 'ios'

export interface DeviceStatus {
  platform: Platform | null
  state: 'booting' | 'running' | 'stopped' | 'error'
  name?: string
  log?: string
}

export interface DeviceChoice {
  platform: Platform
  id: string
  label: string
}

export class DeviceHub {
  readonly android = new Emulator()
  readonly ios = new IosSimulator()
  active: Platform | null = null

  /** 선택지 목록 (iOS 는 아이폰 위주, 최신 런타임 우선) */
  async choices(platform?: Platform): Promise<DeviceChoice[]> {
    const out: DeviceChoice[] = []
    if (!platform || platform === 'ios') {
      for (const d of (await this.ios.list()).filter((x) => /iPhone|iPad/.test(x.name)).slice(0, 12)) out.push({ platform: 'ios', id: d.udid, label: `${d.name} (${d.runtime})${d.state === 'Booted' ? ' · 켜져 있음' : ''}` })
    }
    if (!platform || platform === 'android') {
      for (const a of await this.android.listAvds()) out.push({ platform: 'android', id: a, label: `${a} (Android)` })
    }
    return out
  }

  /** 이름으로 고르기: "iPhone 17 Pro", "Pixel_8" */
  match(choices: DeviceChoice[], name: string): DeviceChoice | null {
    const n = (s: string): string => s.toLowerCase().replace(/[\s_\-()]/g, '')
    const q = n(name)
    return choices.find((c) => n(c.label).startsWith(q)) ?? choices.find((c) => n(c.label).includes(q)) ?? null
  }

  async start(c: DeviceChoice, onLog: (s: string) => void): Promise<{ ok: boolean; message: string }> {
    await this.stopStream()
    this.active = c.platform
    if (c.platform === 'ios') return this.ios.start(c.id, onLog)
    const r = await this.android.start(c.id, onLog)
    return { ok: r.ok, message: r.message }
  }

  async stop(): Promise<string> {
    const p = this.active
    this.active = null
    if (p === 'ios') return this.ios.stop()
    if (p === 'android') {
      await this.android.stop()
      return '에뮬레이터를 종료했습니다.'
    }
    return '실행 중인 기기가 없습니다.'
  }

  name(): string | null {
    return this.active === 'ios' ? this.ios.name : this.active === 'android' ? this.android.serial : null
  }

  private dev() {
    if (this.active === 'ios') return this.ios
    if (this.active === 'android') return this.android
    throw new Error('실행 중인 기기가 없습니다. device_start 로 먼저 켜세요.')
  }

  startStream(onFrame: (png: Buffer, size: { width: number; height: number } | null) => void): void {
    this.dev().startStream(onFrame, this.active === 'ios' ? 3 : 4)
  }
  async stopStream(): Promise<void> {
    this.android.stopStream()
    this.ios.stopStream()
  }
  async tap(x: number, y: number): Promise<string> {
    const r = await this.dev().tap(x, y)
    return r.code === 0 ? `tap ${Math.round(x)},${Math.round(y)}` : `실패: ${r.out}`
  }
  async swipe(x1: number, y1: number, x2: number, y2: number): Promise<string> {
    const r = await this.dev().swipe(x1, y1, x2, y2)
    return r.code === 0 ? 'swiped' : `실패: ${r.out}`
  }
  async type(t: string): Promise<string> {
    const r = this.active === 'ios' ? await this.ios.type(t) : await this.android.text(t)
    return r.code === 0 ? 'typed' : `실패: ${r.out}`
  }
  async key(k: string): Promise<string> {
    if (this.active === 'ios') {
      if (/home|홈/i.test(k)) {
        const r = await this.ios.home()
        return r.code === 0 ? 'home' : `실패: ${r.out}`
      }
      return 'iOS 는 home 버튼만 지원합니다 (뒤로가기는 화면의 뒤로 버튼을 탭하세요).'
    }
    const r = await this.android.key(k)
    return r.code === 0 ? k : `실패: ${r.out}`
  }
  async tapLabel(label: string): Promise<string> {
    if (this.active !== 'ios') return 'tap_label 은 iOS 시뮬레이터 전용입니다. 안드로이드는 스크린샷 좌표로 device_tap 하세요.'
    const r = await this.ios.tapLabel(label)
    return r.code === 0 ? r.out : `실패: ${r.out}`
  }
  screenshotFile(): Promise<string> {
    return this.dev().screenshotFile()
  }
  async install(path: string): Promise<string> {
    const r = await this.dev().install(path)
    return r.out || (r.code === 0 ? '설치 완료' : '설치 실패')
  }
  async launch(id: string): Promise<string> {
    const r = await this.dev().launch(id)
    return r.out || (r.code === 0 ? '실행' : '실패')
  }
  async describe(): Promise<string> {
    if (this.active === 'ios') return this.ios.describe()
    const r = await this.android.shell('uiautomator dump /dev/tty')
    return r.out.slice(0, 30000)
  }
}

/** "에뮬레이터 띄워줘" / "아이폰 시뮬레이터 켜서 앱 확인해" / "시뮬레이터 꺼" */
export function parseDeviceIntent(text: string): { action: 'start' | 'stop'; platform: Platform | null; name?: string; rest: string } | null {
  const t = text.trim().replace(/[.!?]+$/, '')
  const m = /(아이폰\s*시뮬레이터|iphone\s*simulator|ios\s*시뮬레이터|시뮬레이터|simulator|안드로이드\s*에뮬레이터|에뮬레이터|에뮬|emulator|애뮬레이터|가상\s*기기|테스트\s*기기)\s*(?:를|을)?\s*([A-Za-z0-9_][\w\s.-]*?)?\s*(띄워|켜|실행|열어|시작|꺼|종료|닫아)[가-힣]*/i.exec(t)
  if (!m) return null
  const word = m[1].toLowerCase()
  const before = t.slice(0, m.index)
  let platform: Platform | null = /(아이폰|iphone|ios|시뮬레이터|simulator)/.test(word) || /(아이폰|iphone|ios)/i.test(before) ? 'ios' : /(안드로이드|에뮬|emulator)/.test(word) || /(안드로이드|android)/i.test(before) ? 'android' : null
  if (/가상\s*기기|테스트\s*기기/.test(word)) platform = /(아이폰|iphone|ios)/i.test(t) ? 'ios' : /(안드로이드|android)/i.test(t) ? 'android' : null
  const stop = /(꺼|종료|닫아)/.test(m[3])
  const rest = t
    .slice(m.index + m[0].length)
    .replace(/^[\s,]*(서|고|그리고|나서)?[\s,]*/, '')
    .trim()
  const name = m[2]?.trim() && !/^(좀|하나|한번)$/.test(m[2].trim()) ? m[2].trim() : undefined
  return { action: stop ? 'stop' : 'start', platform, name, rest }
}
