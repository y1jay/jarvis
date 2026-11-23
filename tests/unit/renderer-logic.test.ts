import { describe, expect, it } from 'vitest'
import { applyEvent, assistantTurn, finalAnswer } from '../../src/renderer/src/lib/chat'
import { isLikelyHallucination, matchWakeWord, speakableText } from '../../src/renderer/src/voice/text'
import { analyzeHand, GestureTracker, type P } from '../../src/renderer/src/vision/gestures'
import { DEFAULT_SETTINGS } from '../../src/main/settings'

describe('chat 리듀서', () => {
  it('스트리밍 delta 누적 → 도구 → 결과', () => {
    let t = assistantTurn('t1', 'claude')
    t = applyEvent(t, { kind: 'session', sessionId: 's', model: 'opus' })
    t = applyEvent(t, { kind: 'text-delta', text: '파일을 ' })
    t = applyEvent(t, { kind: 'text-delta', text: '읽겠습니다.' })
    t = applyEvent(t, { kind: 'text', text: '' })
    t = applyEvent(t, { kind: 'tool-use', id: 'u1', name: 'Read', input: { file_path: 'a' } })
    t = applyEvent(t, { kind: 'tool-result', id: 'u1', output: 'content', isError: false })
    t = applyEvent(t, { kind: 'text-delta', text: '완료' })
    t = applyEvent(t, { kind: 'result', text: '완료', isError: false, costUsd: 0.01, durationMs: 1200 })
    expect(t.blocks.map((b) => b.type)).toEqual(['text', 'tool', 'text'])
    expect(t.blocks[0]).toMatchObject({ text: '파일을 읽겠습니다.', open: false })
    expect(t.blocks[1]).toMatchObject({ output: 'content', isError: false })
    expect(t.done).toBe(true)
    expect(t.model).toBe('opus')
    expect(finalAnswer(t)).toBe('완료')
  })
  it('텍스트 블록이 없으면 result.text 로 채움', () => {
    const t = applyEvent(assistantTurn('t', 'gpt'), { kind: 'result', text: '답변', isError: false })
    expect(finalAnswer(t)).toBe('답변')
  })
})

describe('호출어', () => {
  const W = DEFAULT_SETTINGS.voice.wakeWords
  it.each([
    ['자비스, 오늘 날씨 어때?', '오늘 날씨 어때?'],
    ['자비스야 커밋해줘', '커밋해줘'],
    ['Jarvis open the project', 'open the project'],
    ['쟈비스 README 고쳐줘', 'README 고쳐줘'],
    ['자비스', ''],
    ['어 자비스 테스트 돌려', '테스트 돌려']
  ])('%s → "%s"', (input, cmd) => {
    expect(matchWakeWord(input, W)).toEqual({ matched: true, command: cmd })
  })
  it('문장 중간/뒤에 나온 단어로는 깨어나지 않음', () => {
    expect(matchWakeWord('어제 본 영화에 나오는 인공지능 이름이 자비스였어', W).matched).toBe(false)
    expect(matchWakeWord('안녕하세요', W).matched).toBe(false)
  })
  it('Whisper 환각 문구 필터', () => {
    expect(isLikelyHallucination('시청해주셔서 감사합니다.')).toBe(true)
    expect(isLikelyHallucination('자비스 파일 열어줘')).toBe(false)
  })
})

describe('speakableText', () => {
  it('코드블록/마크다운/URL 제거', () => {
    const s = speakableText('## 결과\n**완료**했습니다. `a.ts` 수정.\n```ts\nconst x=1\n```\n자세히: https://x.com/y')
    expect(s).not.toContain('```')
    expect(s).not.toContain('**')
    expect(s).not.toContain('https://')
    expect(s).toContain('완료했습니다')
    expect(s).toContain('코드는 화면을')
  })
  it('긴 텍스트는 문장 경계에서 자른다', () => {
    const long = '이것은 문장입니다. '.repeat(100)
    const s = speakableText(long, 100)
    expect(s.length).toBeLessThan(140)
    expect(s).toContain('나머지는 화면에')
  })
})

// 합성 손 랜드마크
function hand(kind: 'open' | 'fist' | 'pinch', ox = 0.5, oy = 0.6): P[] {
  const lm: P[] = Array.from({ length: 21 }, () => ({ x: ox, y: oy }))
  const set = (i: number, dx: number, dy: number): void => void (lm[i] = { x: ox + dx, y: oy + dy })
  set(0, 0, 0.15) // wrist
  const fingers: Array<[number, number, number, number, number]> = [
    [5, 6, 7, 8, -0.06],
    [9, 10, 11, 12, -0.02],
    [13, 14, 15, 16, 0.02],
    [17, 18, 19, 20, 0.06]
  ]
  for (const [mcp, pip, dip, tip, dx] of fingers) {
    set(mcp, dx, 0)
    if (kind === 'fist') {
      set(pip, dx, -0.03)
      set(dip, dx, 0.0)
      set(tip, dx, 0.03)
    } else {
      set(pip, dx, -0.05)
      set(dip, dx, -0.08)
      set(tip, dx, -0.11)
    }
  }
  // thumb
  set(1, -0.05, 0.1)
  set(2, -0.08, 0.06)
  set(3, -0.09, 0.02)
  set(4, -0.1, -0.01)
  if (kind === 'pinch') set(4, lm[8].x - ox + 0.005, lm[8].y - oy + 0.005)
  return lm
}

describe('손 제스처', () => {
  it('pose 판별', () => {
    expect(analyzeHand(hand('open')).pose).toBe('open')
    expect(analyzeHand(hand('fist')).pose).toBe('fist')
    expect(analyzeHand(hand('pinch')).pose).toBe('pinch')
  })
  it('집고 이동 → 회전', () => {
    const g = new GestureTracker()
    g.update([analyzeHand(hand('pinch', 0.5))], 0)
    const out = g.update([analyzeHand(hand('pinch', 0.6))], 16)
    expect(out.rotate!.dx).toBeCloseTo(0.1, 5)
  })
  it('양손 집기 벌리기 → 확대', () => {
    const g = new GestureTracker()
    g.update([analyzeHand(hand('pinch', 0.4)), analyzeHand(hand('pinch', 0.6))], 0)
    const out = g.update([analyzeHand(hand('pinch', 0.3)), analyzeHand(hand('pinch', 0.7))], 16)
    expect(out.scale).toBeCloseTo(2, 1)
  })
  it('손바닥 3프레임 → 홀로그램 앵커, 사라지면 해제', () => {
    const g = new GestureTracker()
    const h = analyzeHand(hand('open'))
    expect(g.update([h], 0).anchor).toBeUndefined()
    g.update([h], 16)
    expect(g.update([h], 32).anchor).toBeTruthy()
    expect(g.update([], 48).anchor).toBeNull()
  })
  it('주먹 0.8초 유지 → 호출 1회', () => {
    const g = new GestureTracker()
    const f = analyzeHand(hand('fist'))
    expect(g.update([f], 0).summon).toBeUndefined()
    expect(g.update([f], 900).summon).toBe(true)
    expect(g.update([f], 1500).summon).toBeUndefined()
  })
})

