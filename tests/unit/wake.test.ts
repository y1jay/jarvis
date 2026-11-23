import { describe, expect, it } from 'vitest'
import { effectiveWakeWords, parseRenameIntent } from '../../src/shared/wake'
import { matchWakeWord } from '../../src/renderer/src/voice/text'

describe('호출어: 헤이 자비스 / 헤이 ○○ / ○○', () => {
  const W = effectiveWakeWords('프라이데이', ['금요일'])
  it.each([
    ['헤이 자비스, 오늘 일정 알려줘', '오늘 일정 알려줘'],
    ['Hey Jarvis, open the project', 'open the project'],
    ['자비스 커밋해줘', '커밋해줘'],
    ['헤이 프라이데이 크롬 열어줘', '크롬 열어줘'],
    ['프라이데이, 테스트 돌려', '테스트 돌려'],
    ['헤이 금요일 날씨 어때', '날씨 어때'],
    ['헤이 프라이데이', ''],
    ['헤이자비스', '']
  ])('%s → "%s"', (t, cmd) => {
    expect(matchWakeWord(t, W)).toEqual({ matched: true, command: cmd })
  })
  it('이름이 아닌 말로는 안 깨어남', () => {
    expect(matchWakeWord('오늘 금요일이라 기분 좋다', W).matched).toBe(false)
    expect(matchWakeWord('회의 시간 바꿔줘', W).matched).toBe(false)
  })
  it('기본 이름 + 추가 호출어 중복 제거, 긴 것부터', () => {
    const w = effectiveWakeWords('자비스', ['자비스', 'JARVIS'])
    expect(w.filter((x) => x === '자비스').length).toBe(1)
    expect(w[0].length).toBeGreaterThanOrEqual(w[w.length - 1].length)
  })
})

describe('이름 바꾸기', () => {
  it.each([
    ['이제부터 네 이름은 프라이데이야', '프라이데이'],
    ['너 이름 프라이데이로 해', '프라이데이'],
    ['앞으로 너를 헤이 금요일이라고 부를게', '금요일'],
    ['네 이름을 에디스로 바꿔줘', '에디스'],
    ['너의 이름은 "카렌"이야', '카렌']
  ])('%s → %s', (t, name) => {
    expect(parseRenameIntent(t)).toBe(name)
  })
  it.each(['너 이름이 뭐야?', '네 이름 기억나?', '이 함수 이름 바꿔줘', 'README 이름을 수정해'])('아님: %s', (t) => {
    expect(parseRenameIntent(t)).toBeNull()
  })
})
