// 문장 중간에 쉬어도 한 문장으로: 끝나지 않은 말은 잠깐 기다렸다가 이어지는 말과 합쳐 다시 인식
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { looksUnfinished } from '../../src/renderer/src/voice/text'
import { VoiceEngine } from '../../src/renderer/src/voice/VoiceEngine'

const SR = 16000
const FRAME = 1024
function loadSpeech(): Float32Array {
  const b = readFileSync(join(__dirname, '../fixtures/speech-ko-16k.wav'))
  const di = b.indexOf('data') + 8
  const n = (b.length - di) >> 1
  const s = new Float32Array(n)
  for (let i = 0; i < n; i++) s[i] = b.readInt16LE(di + i * 2) / 32768
  return s
}
const quiet = (sec: number): Float32Array => new Float32Array(Math.round(sec * SR)).map(() => (Math.random() * 2 - 1) * 0.0005)
const cat = (...xs: Float32Array[]): Float32Array => {
  const out = new Float32Array(xs.reduce((a, x) => a + x.length, 0))
  let o = 0
  for (const x of xs) {
    out.set(x, o)
    o += x.length
  }
  return out
}

describe('끝나지 않은 말 판정', () => {
  it.each(['오늘 일정 정리해서', '카톡으로 엄마한테', '방금 만든 커밋은', '크롬 열어서 유튜브에서', '그리고', '아이폰 시뮬레이터 띄워서'])('안 끝남: %s', (t) => {
    expect(looksUnfinished(t)).toBe(true)
  })
  it.each(['다운로드 폴더 열어줘', '지금 몇 시야', '목소리 좀 더 낮게 바꿔줘', '푸시하지 말고 기다려', '테스트 돌려', '고마워', '이거 뭐예요?', '확인해 주세요.', 'open chrome', '빌드했습니다'])('끝남: %s', (t) => {
    expect(looksUnfinished(t)).toBe(false)
  })
})

describe('문장 중간 쉼 → 한 명령으로 합침', () => {
  beforeEach(() => {
    vi.stubGlobal('speechSynthesis', { cancel: () => undefined, getVoices: () => [], speak: () => undefined })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function make(replies: (secs: number) => string) {
    const commands: string[] = []
    const heard: number[] = []
    const e = new VoiceEngine(
      { model: 'x', language: 'korean', wakeWords: ['자비스'], wakeWordEnabled: true, ttsVoice: null, ttsRate: 1 },
      { onPhase: () => undefined, onLevel: () => undefined, onTranscript: () => undefined, onCommand: (t) => commands.push(t), onWake: () => undefined, onProgress: () => undefined, onError: () => undefined }
    )
    const p = e as unknown as Record<string, unknown>
    p.stream = {}
    p.ready = true
    p.speakEndedAt = -1e9
    p.conversation = true
    p.earcon = () => undefined
    p.transcribe = async (a: Float32Array) => {
      heard.push(a.length / SR)
      return replies(a.length / SR)
    }
    ;(p.setPhase as (x: string) => void).call(e, 'awake')
    const feed = async (x: Float32Array): Promise<void> => {
      for (let i = 0; i + FRAME <= x.length; i += FRAME) {
        ;(p.onAudio as (b: Float32Array) => void).call(e, x.slice(i, i + FRAME))
        await vi.advanceTimersByTimeAsync(FRAME / 16) // 실제 시간처럼 64ms 씩
      }
    }
    return { e, commands, heard, feed }
  }

  it('"오늘 일정 정리해서" (쉼) "슬랙으로 보내줘" → 합쳐서 다시 인식한 한 명령', async () => {
    vi.useFakeTimers()
    const speech = loadSpeech()
    const one = speech.length / SR
    const t = make((secs) => (secs < one * 1.6 ? '오늘 일정 정리해서' : '오늘 일정 정리해서 슬랙으로 보내줘'))
    await t.feed(cat(quiet(1), speech, quiet(1.2), speech, quiet(2.5)))
    expect(t.heard).toHaveLength(2)
    expect(t.heard[1]).toBeGreaterThan(t.heard[0] * 1.6) // 두 번째는 앞 말까지 합친 소리
    expect(t.commands).toEqual(['오늘 일정 정리해서 슬랙으로 보내줘'])
  })

  it('끝나지 않은 말 뒤에 이어 말하지 않으면 잠깐 뒤 그대로 실행', async () => {
    vi.useFakeTimers()
    const t = make(() => '크롬 열어서')
    await t.feed(cat(quiet(1), loadSpeech(), quiet(1)))
    expect(t.commands).toEqual([])
    await t.feed(quiet(2))
    expect(t.commands).toEqual(['크롬 열어서'])
  })

  it('끝난 말은 기다리지 않고 바로 실행', async () => {
    vi.useFakeTimers()
    const t = make(() => '다운로드 폴더 열어줘')
    await t.feed(cat(quiet(1), loadSpeech(), quiet(1)))
    expect(t.commands).toEqual(['다운로드 폴더 열어줘'])
  })
})

describe('대화가 이어지게', () => {
  let utter: Array<{ onend?: () => void }> = []
  beforeEach(() => {
    utter = []
    vi.stubGlobal('speechSynthesis', { cancel: () => undefined, getVoices: () => [], speak: (u: { onend?: () => void }) => utter.push(u) })
    vi.stubGlobal(
      'SpeechSynthesisUtterance',
      class {
        constructor(public text: string) {}
      }
    )
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
  function make() {
    const wakes: number[] = []
    const commands: string[] = []
    const e = new VoiceEngine(
      { model: 'x', language: 'korean', wakeWords: ['자비스'], wakeWordEnabled: true, ttsVoice: null, ttsRate: 1 },
      { onPhase: () => undefined, onLevel: () => undefined, onTranscript: () => undefined, onCommand: (t) => commands.push(t), onWake: () => wakes.push(1), onProgress: () => undefined, onError: () => undefined }
    )
    const p = e as unknown as Record<string, unknown>
    p.stream = {}
    p.ready = true
    p.speakEndedAt = -1e9
    p.earcon = () => undefined
    ;(p.setPhase as (x: string) => void).call(e, 'sleeping')
    return { e, p, wakes, commands }
  }

  it('대답을 다 말한 뒤에는 호출어 없이 바로 이어서 들음 (말하는 중에 keepAwake 해도)', async () => {
    vi.useFakeTimers()
    const t = make()
    const done = t.e.speak('목소리를 바꿨습니다.')
    await vi.advanceTimersByTimeAsync(0)
    expect(t.e.current).toBe('speaking')
    t.e.keepAwake(8000) // 말하는 도중에 요청
    await vi.advanceTimersByTimeAsync(9000) // 말이 길어서 8초 넘게 걸림
    utter[0].onend?.()
    await done
    expect(t.e.current).toBe('awake') // 말이 끝난 시점부터 8초
    await vi.advanceTimersByTimeAsync(7000)
    expect(performance.now() < (t.p.awakeUntil as number)).toBe(true)
  })

  it('깨어 있는 중에 이름만 불러도 호출로 처리 (창 다시 띄우기)', async () => {
    const t = make()
    t.e.keepAwake(60_000)
    ;(t.p.transcribe as unknown) = async () => '자비스'
    await (t.p.handleUtterance as (a: Float32Array) => Promise<void>).call(t.e, new Float32Array(16000))
    expect(t.wakes).toHaveLength(1)
    expect(t.commands).toHaveLength(0)
  })
})

describe('주변 소음 추정 (말소리에 끌려 올라가지 않게)', () => {
  it('말하는 동안 소음 추정이 오르지 않고, 조용해지면 바로 내려간다', async () => {
    const { trackNoise } = await import('../../src/renderer/src/voice/VoiceEngine')
    let n = 0.016
    for (let i = 0; i < 40; i++) n = trackNoise(n, 0.3, true) // 가까이서 큰 목소리 2.5초
    expect(n).toBeCloseTo(0.016, 3)
    for (let i = 0; i < 40; i++) n = trackNoise(n, 0.05, false) // 목소리 아닌 큰 소리는 천천히만
    expect(n).toBeLessThan(0.03)
    for (let i = 0; i < 20; i++) n = trackNoise(n, 0.016, false) // 다시 조용 → 빨리 복귀
    expect(n).toBeLessThan(0.019)
  })
})

describe('대화 모드 — 주고받는 동안은 "자비스" 없이', () => {
  beforeEach(() => {
    vi.stubGlobal('speechSynthesis', { cancel: () => undefined, getVoices: () => [], speak: () => undefined })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
  function make(replies: string[]) {
    const commands: string[] = []
    const wakes: number[] = []
    const e = new VoiceEngine(
      { model: 'x', language: 'korean', wakeWords: ['자비스'], wakeWordEnabled: true, ttsVoice: null, ttsRate: 1 },
      { onPhase: () => undefined, onLevel: () => undefined, onTranscript: () => undefined, onCommand: (t) => commands.push(t), onWake: () => wakes.push(1), onProgress: () => undefined, onError: () => undefined }
    )
    const p = e as unknown as Record<string, unknown>
    p.stream = {}
    p.ready = true
    p.speakEndedAt = -1e9
    p.earcon = () => undefined
    let i = 0
    p.transcribe = async () => replies[i++] ?? ''
    ;(p.setPhase as (x: string) => void).call(e, 'sleeping')
    const say = (): Promise<void> => (p.handleUtterance as (a: Float32Array) => Promise<void>).call(e, new Float32Array(16000))
    return { e, commands, wakes, say }
  }

  it('[실제 재현] "자비스" → 15초 뒤 "엑스크롤 프로젝트 열어줘" → 실행', async () => {
    vi.useFakeTimers()
    const t = make(['자비스', '엑스크롤 프로젝트 열어줘', '지금 몇 시야'])
    await t.say()
    expect(t.wakes).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(15_000)
    await t.say()
    expect(t.commands).toEqual(['엑스크롤 프로젝트 열어줘'])
    // 주고받았으니 30초 뒤에도 바로
    await vi.advanceTimersByTimeAsync(30_000)
    await t.say()
    expect(t.commands).toEqual(['엑스크롤 프로젝트 열어줘', '지금 몇 시야'])
  })

  it('50초 넘게 조용하면 다시 "자비스"가 필요 (옆 사람과 하는 말은 무시)', async () => {
    vi.useFakeTimers()
    const t = make(['자비스 지금 몇 시야', '오늘 점심 뭐 먹지'])
    await t.say()
    expect(t.commands).toEqual(['지금 몇 시야'])
    await vi.advanceTimersByTimeAsync(50_000)
    await t.say()
    expect(t.commands).toEqual(['지금 몇 시야'])
  })

  it('대화 중이어도 인식기가 지어낸 말은 명령으로 안 보냄', async () => {
    vi.useFakeTimers()
    const t = make(['자비스', '자막 제공 및 자막 제공 및 광고를 포함하고 있습니다.', '시청해 주셔서 감사합니다'])
    await t.say()
    await t.say()
    await t.say()
    expect(t.commands).toEqual([])
  })
})
