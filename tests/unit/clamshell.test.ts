// 맥북 덮개 닫힘(클램쉘)에서도 듣기: 끊긴 마이크 감지, 외장 마이크 자동 선택
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseClamshell } from '../../src/main/power'
import { micErrorMessage, VoiceEngine } from '../../src/renderer/src/voice/VoiceEngine'

describe('덮개 닫힘 감지', () => {
  it('ioreg 출력 해석', () => {
    expect(parseClamshell('  |   "AppleClamshellState" = Yes\n')).toBe(true)
    expect(parseClamshell('  |   "AppleClamshellState" = No\n')).toBe(false)
    expect(parseClamshell('')).toBe(false)
  })
})

function engine(opts: { clamshell?: boolean; inputDeviceId?: string | null } = {}) {
  const errors: string[] = []
  const e = new VoiceEngine(
    { model: 'x', language: 'korean', wakeWords: ['자비스'], wakeWordEnabled: true, ttsVoice: null, ttsRate: 1, clamshell: opts.clamshell, inputDeviceId: opts.inputDeviceId ?? null },
    { onPhase: () => undefined, onLevel: () => undefined, onTranscript: () => undefined, onCommand: () => undefined, onWake: () => undefined, onProgress: () => undefined, onError: (m) => errors.push(m) }
  )
  return { e, p: e as unknown as Record<string, unknown>, errors }
}

const DEVICES = [
  { kind: 'audioinput', deviceId: 'default', label: '기본 - MacBook Pro 마이크' },
  { kind: 'audioinput', deviceId: 'builtin', label: 'MacBook Pro 마이크' },
  { kind: 'audioinput', deviceId: 'ibp1', label: 'IB-P1' },
  { kind: 'audiooutput', deviceId: 'spk', label: 'MacBook Pro 스피커' }
]

describe('마이크 선택', () => {
  afterEach(() => vi.unstubAllGlobals())
  const stub = (list = DEVICES) => vi.stubGlobal('navigator', { mediaDevices: { enumerateDevices: async () => list } })

  it('덮개 닫힘 → 내장 대신 외장(블루투스) 마이크', async () => {
    stub()
    const { p } = engine({ clamshell: true })
    expect(await (p.pickDevice as () => Promise<string | undefined>).call(p)).toBe('ibp1')
  })
  it('덮개 열림 + 선택 없음 → 시스템 기본', async () => {
    stub()
    const { p } = engine()
    expect(await (p.pickDevice as () => Promise<string | undefined>).call(p)).toBeUndefined()
  })
  it('사용자가 고른 장치가 살아 있으면 그대로', async () => {
    stub()
    const { p } = engine({ clamshell: true, inputDeviceId: 'builtin' })
    expect(await (p.pickDevice as () => Promise<string | undefined>).call(p)).toBe('builtin')
  })
  it('끊긴 것으로 판정된 장치는 다시 고르지 않음', async () => {
    stub()
    const { p } = engine({ inputDeviceId: 'builtin' })
    ;(p.deadDevices as Set<string>).add('builtin')
    expect(await (p.pickDevice as () => Promise<string | undefined>).call(p)).toBe('ibp1')
  })
  it('외장 마이크가 없으면 기본으로 (덮개 닫힘 안내는 끊김 감지에서)', async () => {
    stub(DEVICES.filter((d) => d.deviceId !== 'ibp1'))
    const { p } = engine({ clamshell: true })
    expect(await (p.pickDevice as () => Promise<string | undefined>).call(p)).toBeUndefined()
  })
})

describe('끊긴 마이크 감지', () => {
  it('입력이 2.5초 넘게 완전히 0 이면 안내 1번 + 재연결 예약 (덮개 닫힘 문구)', () => {
    const { p, errors } = engine({ clamshell: true })
    p.stream = { getAudioTracks: () => [{ label: 'MacBook Pro 마이크' }] }
    p.currentDevice = 'builtin'
    p.framesSinceOpen = 1000 // 연 지 오래된 마이크
    p.wanted = true
    let restarts = 0
    p.scheduleRestart = () => restarts++
    const zero = new Float32Array(1024)
    const watch = p.watchDead as (b: Float32Array) => void
    for (let i = 0; i < 30; i++) watch.call(p, zero) // ≈1.9초
    expect(errors).toHaveLength(0)
    for (let i = 0; i < 20; i++) watch.call(p, zero) // ≈3.2초
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/덮개가 닫혀/)
    expect(restarts).toBe(1)
    expect((p.deadDevices as Set<string>).has('builtin')).toBe(true)
    for (let i = 0; i < 100; i++) watch.call(p, zero)
    expect(errors).toHaveLength(1) // 같은 장치로 반복 안내/재시작 안 함
    expect(restarts).toBe(1)
  })
  it('아주 작은 소리라도 들어오면 끊김 아님', () => {
    const { p, errors } = engine()
    p.stream = { getAudioTracks: () => [{ label: 'IB-P1' }] }
    p.currentDevice = 'ibp1'
    const quiet = new Float32Array(1024).map((_, i) => (i % 2 ? 1e-4 : -1e-4))
    for (let i = 0; i < 100; i++) (p.watchDead as (b: Float32Array) => void).call(p, quiet)
    expect(errors).toHaveLength(0)
  })
})

describe('블루투스 연결 직후', () => {
  it('연 직후 3초 동안의 0 입력은 끊김으로 보지 않음 (통화 모드 전환 중)', () => {
    const { p, errors } = engine()
    p.stream = { getAudioTracks: () => [{ label: 'IB-P1' }] }
    p.currentDevice = 'ibp1'
    p.wanted = true
    p.scheduleRestart = () => undefined
    const zero = new Float32Array(1024)
    const watch = p.watchDead as (b: Float32Array) => void
    for (let i = 0; i < 45; i++) watch.call(p, zero) // ≈2.9초: 전부 0
    const voice = new Float32Array(1024).fill(0.01)
    for (let i = 0; i < 100; i++) watch.call(p, voice) // 이후 정상 입력
    expect(errors).toHaveLength(0)
    expect((p.deadDevices as Set<string>).size).toBe(0)
  })
})

// ── 마이크 연결 안정성: 실패해도 포기하지 않고, 불필요한 재연결은 안 함 ──
type Listener = () => void
function micEnv(opts: { failures?: Array<{ name: string }>; granted?: boolean[] } = {}) {
  const failures = [...(opts.failures ?? [])]
  const granted = [...(opts.granted ?? [])]
  let devices = [...DEVICES]
  const listeners = new Set<Listener>()
  const tracks: Array<{ readyState: string; stopped: boolean }> = []
  let calls = 0
  const opened: string[] = []
  vi.stubGlobal('speechSynthesis', { cancel: () => undefined, getVoices: () => [] })
  vi.stubGlobal('window', { jarvis: { media: { request: async () => (granted.length ? granted.shift() : true) } } })
  vi.stubGlobal('navigator', {
    mediaDevices: {
      enumerateDevices: async () => devices,
      addEventListener: (_: string, l: Listener) => listeners.add(l),
      removeEventListener: (_: string, l: Listener) => listeners.delete(l),
      getUserMedia: async (c: { audio: { deviceId?: { exact: string } } }) => {
        calls++
        const f = failures.shift()
        if (f) throw Object.assign(new Error(f.name), { name: f.name })
        const id = c.audio.deviceId?.exact ?? 'default'
        opened.push(id)
        const label = devices.find((d) => d.deviceId === id)?.label ?? id
        const t = { readyState: 'live', stopped: false, label, onended: null as null | (() => void), getSettings: () => ({ deviceId: id }), stop() { this.stopped = true; this.readyState = 'ended' } }
        tracks.push(t)
        return { getAudioTracks: () => [t], getTracks: () => [t] }
      }
    }
  })
  vi.stubGlobal(
    'AudioContext',
    class {
      sampleRate = 16000
      state = 'running'
      destination = {}
      resume = async () => undefined
      close = async () => undefined
      createMediaStreamSource = () => ({ connect: () => undefined })
      createScriptProcessor = () => ({ connect: () => undefined, disconnect: () => undefined, onaudioprocess: null })
    }
  )
  const { e, p, errors } = engine({ clamshell: true })
  p.initRecognizer = async () => undefined
  return {
    e,
    p,
    errors,
    calls: () => calls,
    opened,
    tracks,
    fireDeviceChange: () => listeners.forEach((l) => l()),
    setDevices: (d: typeof DEVICES) => (devices = d)
  }
}

describe('마이크 연결 안정성', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('열기 실패(블루투스 전환 중) → 포기하지 않고 점점 간격을 늘려 재시도해서 연결', async () => {
    vi.useFakeTimers()
    // 한 번의 시도 = 고른 장치 → 실패 시 기본 장치 (2회 호출)
    const env = micEnv({ failures: Array(4).fill({ name: 'NotReadableError' }) })
    await env.e.start()
    expect(env.calls()).toBe(2)
    expect(env.e.listening).toBe(false)
    expect(env.e.enabled).toBe(true)
    expect(env.errors).toHaveLength(1)
    expect(env.errors[0]).toMatch(/자동으로 다시 연결/)
    await vi.advanceTimersByTimeAsync(2100) // 1차 재시도 (실패)
    expect(env.calls()).toBe(4)
    expect(env.errors).toHaveLength(1) // 같은 원인은 한 번만 안내
    await vi.advanceTimersByTimeAsync(3000) // 아직 2차 재시도 전 (4초 간격)
    expect(env.calls()).toBe(4)
    await vi.advanceTimersByTimeAsync(1200) // 2차 재시도 (성공)
    expect(env.calls()).toBe(5)
    expect(env.e.listening).toBe(true)
  })

  it('권한 꺼짐 → 권한 안내, 사용자가 켜면 자동으로 연결', async () => {
    vi.useFakeTimers()
    const env = micEnv({ granted: [false] })
    await env.e.start()
    expect(env.errors[0]).toMatch(/마이크 권한이 꺼져/)
    expect(env.calls()).toBe(0) // 권한 없이 열지 않음
    await vi.advanceTimersByTimeAsync(2100)
    expect(env.e.listening).toBe(true)
  })

  it('출력/통화 모드 전환처럼 입력 장치가 그대로인 장치 변경은 무시 (재연결 반복 방지)', async () => {
    vi.useFakeTimers()
    const env = micEnv()
    await env.e.start()
    expect(env.calls()).toBe(1)
    for (let i = 0; i < 5; i++) {
      env.fireDeviceChange()
      await vi.advanceTimersByTimeAsync(1500)
    }
    expect(env.calls()).toBe(1)
    expect(env.tracks[0].stopped).toBe(false)
  })

  it('쓰던 이어폰이 빠지면 한 번만 재연결', async () => {
    vi.useFakeTimers()
    const env = micEnv()
    await env.e.start()
    expect(env.opened).toEqual(['ibp1'])
    env.setDevices(DEVICES.filter((d) => d.deviceId !== 'ibp1'))
    env.fireDeviceChange()
    env.fireDeviceChange()
    await vi.advanceTimersByTimeAsync(2500)
    expect(env.calls()).toBe(2)
    expect(env.tracks[0].stopped).toBe(true)
    expect(env.e.listening).toBe(true)
  })

  it('더 나은 마이크가 아닌 장치가 새로 생기면 지금 마이크 유지', async () => {
    vi.useFakeTimers()
    const env = micEnv()
    await env.e.start()
    env.setDevices([...DEVICES, { kind: 'audioinput', deviceId: 'usb', label: 'USB Mic' }])
    env.fireDeviceChange()
    await vi.advanceTimersByTimeAsync(2500)
    expect(env.calls()).toBe(1)
  })

  it('[실제 로그 재현] 이어폰이 조용할 때 0 을 보내도 끊김으로 보지 않음 → 내장 마이크로 안 넘어감', async () => {
    vi.useFakeTimers()
    const env = micEnv()
    await env.e.start()
    env.p.scheduleRestart = () => {
      throw new Error('재연결하면 안 됨')
    }
    const zero = new Float32Array(1024)
    for (let i = 0; i < 300; i++) (env.p.watchDead as (b: Float32Array) => void).call(env.p, zero) // ≈19초 무음
    expect(env.errors).toHaveLength(0)
    expect((env.p.deadDevices as Set<string>).size).toBe(0)
  })

  it('[실제 로그 재현] 이어폰 통화/음악 모드 전환으로 목록이 잠깐 바뀌었다 돌아와도 재연결 안 함', async () => {
    vi.useFakeTimers()
    const env = micEnv()
    await env.e.start()
    // 이어폰이 목록에서 잠깐 빠졌다가 1초 뒤 돌아옴 (macOS 가 프로필을 바꾸는 동안)
    env.setDevices(DEVICES.filter((d) => d.deviceId !== 'ibp1'))
    env.fireDeviceChange()
    await vi.advanceTimersByTimeAsync(1000)
    env.setDevices([...DEVICES])
    env.fireDeviceChange()
    await vi.advanceTimersByTimeAsync(5000)
    expect(env.calls()).toBe(1)
    expect(env.tracks[0].stopped).toBe(false)
  })

  it('[실제 로그 재현] 덮개 닫힘 + 내장 마이크만 → 이어폰 연결되면 이어폰으로 한 번 전환 후 유지', async () => {
    vi.useFakeTimers()
    const env = micEnv()
    env.setDevices(DEVICES.filter((d) => d.deviceId !== 'ibp1'))
    await env.e.start()
    expect(env.opened).toEqual(['default'])
    env.setDevices([...DEVICES])
    env.fireDeviceChange()
    await vi.advanceTimersByTimeAsync(2500)
    expect(env.opened).toEqual(['default', 'ibp1'])
    // 이후 통화 모드 전환 신호가 여러 번 와도 그대로
    for (let i = 0; i < 6; i++) {
      env.fireDeviceChange()
      await vi.advanceTimersByTimeAsync(800)
    }
    expect(env.opened).toEqual(['default', 'ibp1'])
  })

  it('연결 실패 상태에서도 새 마이크가 꽂히면 바로 잡는다', async () => {
    vi.useFakeTimers()
    const env = micEnv({ failures: [{ name: 'NotFoundError' }, { name: 'NotFoundError' }] })
    await env.e.start()
    expect(env.errors[0]).toMatch(/외장 마이크가 없습니다/)
    env.setDevices([...DEVICES, { kind: 'audioinput', deviceId: 'usb', label: 'USB Mic' }])
    env.fireDeviceChange()
    await vi.advanceTimersByTimeAsync(2100)
    expect(env.e.listening).toBe(true)
  })

  it('사용자가 끄면 재시도 중단', async () => {
    vi.useFakeTimers()
    const env = micEnv({ failures: [{ name: 'NotReadableError' }] })
    await env.e.start()
    env.e.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(env.calls()).toBe(2)
    expect(env.e.enabled).toBe(false)
  })

  it('오류 원인별 안내 문구', () => {
    expect(micErrorMessage({ name: 'NotAllowedError' }, false)).toMatch(/권한/)
    expect(micErrorMessage({ name: 'NotFoundError' }, false)).toMatch(/연결된 마이크가 없습니다/)
    expect(micErrorMessage({ name: 'NotReadableError' }, false)).toMatch(/다른 앱|블루투스/)
  })
})

describe('내장 마이크 판별 (덮개 닫으면 꺼지는 것만)', () => {
  it.each([
    ['MacBook Pro 마이크 (Built-in)', true],
    ['Default - MacBook Pro 마이크 (Built-in)', true],
    ['MacBook Air Microphone (Built-in)', true],
    ['Built-in Microphone', true],
    ['외장 마이크 (Built-in)', false],
    ['Default - 외장 마이크 (Built-in)', false],
    ['External Microphone (Built-in)', false],
    ['IB-P1 (Bluetooth)', false],
    ['USB Audio Device', false]
  ])('%s → %s', async (label, builtIn) => {
    const { isBuiltInLabel } = await import('../../src/renderer/src/voice/VoiceEngine')
    expect(isBuiltInLabel(label)).toBe(builtIn)
  })
})
