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

describe('흐린 발음 호출어 (자모 유사도)', () => {
  const W = effectiveWakeWords('자비스')
  const W2 = effectiveWakeWords('프라이데이')
  it.each([
    ['자빗스 불 꺼줘', '불 꺼줘'],
    ['차비스, 오늘 일정', '오늘 일정'],
    ['재비스 커밋해줘', '커밋해줘'],
    ['헤이 자비쓰 테스트 돌려', '테스트 돌려'],
    ['쟈빗스야 음악 틀어', '음악 틀어'],
    ['자 빗스 날씨 어때', '날씨 어때'],
    ['헤이 잡이스', ''],
    ['jervis open the browser', 'open the browser']
  ])('잡아냄: %s → "%s"', (t, cmd) => {
    expect(matchWakeWord(t, W)).toEqual({ matched: true, command: cmd })
  })
  it.each([
    '자비를 베풀어 주세요',
    '자비심이 없네',
    '자세히 설명해줘',
    '서비스 너무 좋다',
    '잠깐만 기다려',
    '자 이제 시작하자',
    '재밌는 영화 보자',
    '차 빼줘',
    '자바 스크립트 공부 중',
    '오늘 회의 자료 보내줘',
    '사비 털어서 샀어',
    '그 자식 진짜'
  ])('무시: %s', (t) => {
    expect(matchWakeWord(t, W).matched).toBe(false)
  })
  it.each([
    ['프라이대이 크롬 열어', '크롬 열어'],
    ['헤이 브라이데이', ''],
    ['플라이데이 일정 알려줘', '일정 알려줘']
  ])('사용자 이름도 흐린 발음 허용: %s', (t, cmd) => {
    expect(matchWakeWord(t, W2)).toEqual({ matched: true, command: cmd })
  })
  it.each(['프라이팬 어디 있어', '프라이드 치킨 먹자', '파라다이스 가자'])('사용자 이름과 비슷한 일상어 무시: %s', (t) => {
    expect(matchWakeWord(t, W2).matched).toBe(false)
  })
})

describe('화면에 쓰는 이름', () => {
  it('이름을 바꾸면 화면 이름도', async () => {
    const { brandName, shortName } = await import('../../src/shared/wake')
    expect(brandName('자비스')).toBe('J.A.R.V.I.S.')
    expect(brandName('프라이데이')).toBe('F.R.I.D.A.Y.')
    expect(shortName('프라이데이')).toBe('FRIDAY')
    expect(brandName('friday')).toBe('F.R.I.D.A.Y.')
    expect(brandName('금요일')).toBe('금요일')
    expect(shortName('금요일')).toBe('금요일')
  })
})
