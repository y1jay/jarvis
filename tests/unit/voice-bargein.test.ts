// 키보드 소리 무시 + 말 끊고 들어오기(barge-in) + "멈춰" 명령
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { analyzeFrame } from '../../src/renderer/src/voice/vad'
import { isEchoOf, isStopCommand } from '../../src/renderer/src/voice/text'
import { VoiceEngine, type VoicePhase } from '../../src/renderer/src/voice/VoiceEngine'

const SR = 16000
const FRAME = 1024

/** macOS `say -v Yuna "자비스, 지금 하던 거 멈추고 내 말 먼저 들어"` → 16kHz mono */
function loadSpeech(): Float32Array {
  const b = readFileSync(join(__dirname, '../fixtures/speech-ko-16k.wav'))
  const di = b.indexOf('data') + 8
  const n = (b.length - di) >> 1
  const s = new Float32Array(n)
  for (let i = 0; i < n; i++) s[i] = b.readInt16LE(di + i * 2) / 32768
  return s
}

function rng(seed: number): () => number {
  let s = seed
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1
}

/** 타건음: 높은 "딸깍"(4ms 감쇠) 과 낮은 "똑"(기계식, 200Hz 12ms 감쇠)을 섞어 초당 ~9타 */
function typing(seconds: number, seed = 1): Float32Array {
  const n = Math.floor(seconds * SR)
  const x = new Float32Array(n)
  const r = rng(seed)
  let pos = 1000
  let k = 0
  while (pos < n) {
    const thock = k++ % 2 === 1
    const amp = 0.25 + Math.abs(r()) * 0.2
    for (let i = pos; i < Math.min(n, pos + 1600); i++) {
      const t = (i - pos) / SR
      const env = Math.exp(-t / (thock ? 0.012 : 0.004))
      x[i] += amp * env * (thock ? Math.sin(2 * Math.PI * 200 * t) * 0.8 + r() * 0.2 : r() * 0.5 + Math.sin(2 * Math.PI * 2500 * t) * 0.5)
    }
    pos += Math.floor(SR * (0.08 + Math.abs(r()) * 0.14))
  }
  return x
}

function quiet(seconds: number, seed = 9): Float32Array {
  const r = rng(seed)
  return Float32Array.from({ length: Math.floor(seconds * SR) }, () => r() * 0.001)
}

function cat(...xs: Float32Array[]): Float32Array {
  const out = new Float32Array(xs.reduce((s, x) => s + x.length, 0))
  let o = 0
  for (const x of xs) {
    out.set(x, o)
    o += x.length
  }
  return out
}

function mix(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(Math.max(a.length, b.length))
  for (let i = 0; i < out.length; i++) out[i] = (a[i] ?? 0) + (b[i] ?? 0)
  return out
}

function frames(x: Float32Array): Float32Array[] {
  const out: Float32Array[] = []
  for (let i = 0; i + FRAME <= x.length; i += FRAME) out.push(x.slice(i, i + FRAME))
  return out
}

describe('목소리 판별 (analyzeFrame)', () => {
  it('실제 한국어 음성의 대부분 프레임은 목소리', () => {
    const f = frames(loadSpeech()).map((b) => analyzeFrame(b)).filter((x) => x.rms > 0.02)
    expect(f.length).toBeGreaterThan(30)
    expect(f.filter((x) => x.voiced).length / f.length).toBeGreaterThan(0.7)
  })
  it('키보드 타건음 프레임은 목소리가 아님', () => {
    const f = frames(typing(5)).map((b) => analyzeFrame(b)).filter((x) => x.rms > 0.01)
    expect(f.length).toBeGreaterThan(30)
    expect(f.filter((x) => x.voiced).length).toBe(0)
  })
  it('백색잡음/무음은 목소리가 아님', () => {
    const r = rng(3)
    expect(analyzeFrame(Float32Array.from({ length: FRAME }, () => r() * 0.2)).voiced).toBe(false)
    expect(analyzeFrame(new Float32Array(FRAME)).voiced).toBe(false)
  })
})

describe('정지 명령 / 메아리', () => {
  it.each(['멈춰', '그만', '그만해', '스톱', '잠깐 멈춰', '작업 중지', '다 멈춰!', 'Stop.'])('정지: %s', (t) => expect(isStopCommand(t)).toBe(true))
  it.each(['멈춰있는 화면 캡처해줘', '그만 보고 커밋해', '음악 멈춰 있는지 확인해줘', '크롬 열어줘'])('정지 아님: %s', (t) => expect(isStopCommand(t)).toBe(false))
  it('자기 목소리 메아리 판정', () => {
    const spoken = '빌드가 완료되었습니다. 테스트 세 개가 실패했고 로그는 화면에 표시했습니다.'
    expect(isEchoOf('테스트 세 개가 실패했고', spoken)).toBe(true)
    expect(isEchoOf('테스트 세계가 실패했고 로그는', spoken)).toBe(true)
    expect(isEchoOf('잠깐 크롬 열어줘', spoken)).toBe(false)
  })
})

describe('VoiceEngine 상태 흐름', () => {
  let cancel: ReturnType<typeof vi.fn>
  let utterances: { text: string; onend?: () => void }[]

  beforeEach(() => {
    cancel = vi.fn(() => {
      // 실제 브라우저처럼 cancel 시 진행 중 발화의 onend 가 불린다
      const u = utterances.shift()
      u?.onend?.()
    })
    utterances = []
    vi.stubGlobal('speechSynthesis', { cancel, getVoices: () => [], speak: (u: { text: string }) => utterances.push(u) })
    vi.stubGlobal(
      'SpeechSynthesisUtterance',
      class {
        text: string
        constructor(t: string) {
          this.text = t
        }
      }
    )
  })
  afterEach(() => vi.unstubAllGlobals())

  function make(opts: { conversation?: boolean; transcript?: string; bargeIn?: boolean } = {}) {
    const phases: VoicePhase[] = []
    const commands: string[] = []
    const heard: number[] = []
    const bargeIns: number[] = []
    const e = new VoiceEngine(
      { model: 'x', language: 'korean', wakeWords: ['자비스'], wakeWordEnabled: true, ttsVoice: null, ttsRate: 1, bargeIn: opts.bargeIn },
      {
        onPhase: (p) => phases.push(p),
        onLevel: () => undefined,
        onTranscript: () => undefined,
        onCommand: (t) => commands.push(t),
        onWake: () => undefined,
        onProgress: () => undefined,
        onError: () => undefined,
        onBargeIn: () => bargeIns.push(1)
      }
    )
    const p = e as unknown as Record<string, unknown>
    p.stream = {}
    p.ready = true
    p.speakEndedAt = -1e9
    p.conversation = opts.conversation ?? false
    p.transcribe = async (a: Float32Array) => {
      heard.push(a.length / SR)
      return opts.transcript ?? '크롬 열어줘'
    }
    ;(p.setPhase as (x: VoicePhase) => void).call(e, opts.conversation ? 'awake' : 'sleeping')
    const feed = async (x: Float32Array): Promise<void> => {
      for (const f of frames(x)) (p.onAudio as (b: Float32Array) => void).call(e, f)
      await new Promise((r) => setTimeout(r, 0))
    }
    return { e, p, phases, commands, heard, bargeIns, feed }
  }

  it('대화 모드에서 키보드만 쳐도 녹음/인식이 일어나지 않음', async () => {
    const t = make({ conversation: true })
    await t.feed(cat(quiet(1), typing(6), quiet(1.5)))
    expect(t.phases).not.toContain('recording')
    expect(t.heard).toHaveLength(0)
    expect(t.commands).toHaveLength(0)
  })

  it('대화 모드에서 실제 말은 인식되어 명령으로 전달', async () => {
    const t = make({ conversation: true })
    await t.feed(cat(quiet(1), loadSpeech(), quiet(1.5)))
    expect(t.phases).toContain('recording')
    expect(t.heard).toHaveLength(1)
    expect(t.commands).toEqual(['크롬 열어줘'])
  })

  it('말한 뒤 이어지는 타건음은 녹음을 늘리지 않음', async () => {
    const t = make({ conversation: true })
    const speech = loadSpeech()
    await t.feed(cat(quiet(1), speech, typing(6), quiet(1.5)))
    expect(t.heard).toHaveLength(1)
    expect(t.heard[0]).toBeLessThan(speech.length / SR + 1.6)
  })

  it('타건하면서 말해도 말은 잡힘', async () => {
    const t = make({ conversation: true })
    await t.feed(cat(quiet(1), mix(loadSpeech(), typing(3.5, 5)), quiet(1.5)))
    expect(t.heard).toHaveLength(1)
  })

  it('JARVIS 가 말하는 중 사용자가 말하면: 즉시 TTS 중단 → 호출어 없이 명령으로 받음', async () => {
    const t = make({ transcript: '그거 말고 크롬 열어줘' })
    await t.feed(quiet(1))
    const done = t.e.speak('긴 답변을 읽고 있습니다. 첫째, 둘째, 셋째 항목을 차례로 설명하겠습니다.')
    await new Promise((r) => setTimeout(r, 0))
    expect(t.e.current).toBe('speaking')
    cancel.mockClear()
    await t.feed(cat(loadSpeech(), quiet(1.5)))
    expect(cancel).toHaveBeenCalled()
    expect(t.bargeIns).toHaveLength(1)
    expect(t.commands).toEqual(['그거 말고 크롬 열어줘'])
    await done
  })

  it('스트리밍으로 쌓인 문장을 읽는 중 끼어들면 남은 문장은 버리고 사용자 말을 받음', async () => {
    const t = make({ transcript: '아니 그만하고 커밋 내역 보여줘' })
    await t.feed(quiet(1))
    t.e.enqueue('첫 번째 문장을 읽고 있습니다.')
    t.e.enqueue('두 번째 문장입니다.')
    t.e.enqueue('세 번째 문장입니다.')
    await new Promise((r) => setTimeout(r, 0))
    expect(utterances.map((u) => u.text)).toEqual(['첫 번째 문장을 읽고 있습니다.'])
    const spokenBefore = utterances.length
    let speaks = 0
    ;(globalThis.speechSynthesis as unknown as { speak: (u: { text: string }) => void }).speak = (u) => {
      speaks++
      utterances.push(u)
    }
    await t.feed(cat(loadSpeech(), quiet(1.5)))
    await new Promise((r) => setTimeout(r, 50))
    expect(t.bargeIns).toHaveLength(1)
    expect(speaks).toBe(0) // 두 번째·세 번째 문장은 읽지 않음
    expect(spokenBefore).toBe(1)
    expect(t.commands).toEqual(['아니 그만하고 커밋 내역 보여줘'])
  })

  it('대기열 문장은 앞 문장이 끝나면 이어서 차례로 읽음', async () => {
    const t = make()
    await t.feed(quiet(1))
    t.e.enqueue('하나.')
    t.e.enqueue('둘.')
    await new Promise((r) => setTimeout(r, 0))
    expect(utterances.map((u) => u.text)).toEqual(['하나.'])
    utterances[0].onend?.()
    await new Promise((r) => setTimeout(r, 0))
    expect(utterances.map((u) => u.text)).toEqual(['하나.', '둘.'])
    utterances[1].onend?.()
    await t.e.whenIdle()
  })

  it('말하는 중 키보드 소리로는 끊기지 않음', async () => {
    const t = make()
    await t.feed(quiet(1))
    void t.e.speak('답변을 읽고 있습니다.')
    await new Promise((r) => setTimeout(r, 0))
    cancel.mockClear()
    await t.feed(typing(5))
    expect(cancel).not.toHaveBeenCalled()
    expect(t.e.current).toBe('speaking')
    expect(t.bargeIns).toHaveLength(0)
  })

  it('끼어든 소리가 자기 목소리 메아리면 명령으로 보내지 않음', async () => {
    const spoken = '빌드가 완료되었습니다. 테스트 세 개가 실패했습니다.'
    const t = make({ transcript: '테스트 세 개가 실패했습니다' })
    await t.feed(quiet(1))
    void t.e.speak(spoken)
    await new Promise((r) => setTimeout(r, 0))
    await t.feed(cat(loadSpeech(), quiet(1.5)))
    expect(t.heard).toHaveLength(1)
    expect(t.commands).toHaveLength(0)
  })

  it('설정에서 끼어들기를 끄면 말하는 중엔 듣지 않음', async () => {
    const t = make({ bargeIn: false })
    await t.feed(quiet(1))
    void t.e.speak('답변을 읽고 있습니다.')
    await new Promise((r) => setTimeout(r, 0))
    cancel.mockClear()
    await t.feed(cat(loadSpeech(), quiet(1.5)))
    expect(cancel).not.toHaveBeenCalled()
    expect(t.commands).toHaveLength(0)
  })

  it('사용자가 말하는 중에는 JARVIS 가 말을 시작하지 않고 끝날 때까지 기다림', async () => {
    const t = make({ conversation: true })
    const speech = loadSpeech()
    await t.feed(cat(quiet(1), speech.slice(0, SR)))
    expect(t.e.current).toBe('recording')
    const done = t.e.speak('작업이 끝났습니다.')
    await new Promise((r) => setTimeout(r, 150))
    expect(utterances).toHaveLength(0)
    await t.feed(cat(speech.slice(SR), quiet(1.5)))
    await new Promise((r) => setTimeout(r, 250))
    expect(t.commands).toEqual(['크롬 열어줘'])
    expect(utterances.map((u) => u.text)).toEqual(['작업이 끝났습니다.'])
    utterances[0].onend?.()
    await done
  })
})
