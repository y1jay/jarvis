// 맥북 덮개 닫힘(클램쉘)에서도 듣기: 끊긴 마이크 감지, 외장 마이크 자동 선택
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseClamshell } from '../../src/main/power'
import { VoiceEngine } from '../../src/renderer/src/voice/VoiceEngine'

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
