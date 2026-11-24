// 오늘 실제로 끊겼던 대화를 그대로 재현: 대화 흐름이 이어지는지, 목소리 명령이 엉뚱하게 가로채지 않는지
import { describe, expect, it } from 'vitest'
import { DialogContext } from '../../src/main/dialog'
import { isOtherRequest, parseVoiceIntent } from '../../src/main/intents'
import { withMemoryUpdate } from '../../src/main/providers/claude'

describe('대화 흐름 이어 주기', () => {
  it('[실제 재현] 빠른 대화가 "오픈소스 엔진 찾아 드릴까요?" → "그렇게 해줘"는 에이전트로 가도 앞 흐름을 안다', () => {
    const d = new DialogContext()
    d.add({ user: '목소리를 오픈소스나 다른 인터넷상에서 좀 찾아봐', jarvis: '음성 설정을 열었습니다.', lane: 'local' })
    d.add({ user: '인화 말곤 없어', jarvis: '유나 목소리만 설치돼 있다는 말씀이시죠? 아니면 제가 오픈소스 음성 엔진을 찾아서 정리해 드릴까요?', lane: 'fast' })
    const toAgent = d.wrap('그렇게 해줘', 'agent:general', '자비스')
    expect(toAgent).toMatch(/오픈소스 음성 엔진을 찾아서 정리해 드릴까요/)
    expect(toAgent).toMatch(/\[지금 사용자 말\]\n그렇게 해줘$/)
    // 같은 내용을 두 번 붙이지 않음
    expect(d.wrap('고마워', 'agent:general', '자비스')).toBe('고마워')
    // 빠른 대화는 자기가 답한 건 이미 알고 있으니 다른 경로 것만
    const toFast = d.wrap('응', 'fast', '자비스')
    expect(toFast).toMatch(/음성 설정을 열었습니다/)
    expect(toFast).not.toMatch(/정리해 드릴까요/)
  })
  it('"다시 말해줘"용 마지막 답', () => {
    const d = new DialogContext()
    d.add({ user: '목소리 더 내려받기', jarvis: '음성 설정을 열었습니다.', lane: 'local' })
    d.add({ user: '음', jarvis: '', lane: 'local' })
    expect(d.last()?.jarvis).toBe('음성 설정을 열었습니다.')
  })
})

describe('목소리 바꾸기 명령은 분명할 때만', () => {
  it.each(['목소리를 오픈소스나 다른 인터넷상에서 좀 찾아봐', '음성 인식 코드 고쳐줘', '목소리 엔진 좋은 거 알아봐', '내 말을 먼저 들어', '말 좀 해봐'])('가로채지 않음: %s', (t) => {
    expect(parseVoiceIntent(t)).toBeNull()
  })
  it.each([
    ['목소리 바꿔줘', 'choose'],
    ['네 목소리를 좀 바꾸고 싶은데 뭐가 있을까', 'choose'],
    ['다른 목소리로 해줘', 'choose'],
    ['목소리 좀 더 빠르게', 'faster'],
    ['목소리 더 낮게 해줘', 'lower'],
    ['목소리 더 내려받을래', null]
  ])('%s → %s', (t, a) => expect(parseVoiceIntent(t)?.action ?? null).toBe(a))
})

describe('선택지 질문에 다른 말을 했을 때', () => {
  it.each(['뭐 다른 거 뭐 좀 찾아봐', '탐색기 말고 오픈소스나 다른 뭐 인터넷상에서 좀 찾아보라는 거야', '유난한 건 없어', '그냥 됐어 나중에 할게', '유나 말고 다른 건 없어?'])('새 요청으로: %s', (t) => {
    expect(isOtherRequest(t)).toBe(true)
  })
  it.each(['더 내라고 하다가.', '유나', '2번', '목소리 더 내려받기', '더 내려가다 봐'])('다시 묻기 (선택 시도/인식 실수): %s', (t) => {
    expect(isOtherRequest(t)).toBe(false)
  })
})

describe('기억 갱신은 다시 띄우지 않고 메시지로', () => {
  it('바뀐 기억만 앞에 붙인다', () => {
    expect(withMemoryUpdate('안녕', 'A', 'A')).toBe('안녕')
    expect(withMemoryUpdate('안녕', 'A', 'A\nB')).toMatch(/기억 갱신[\s\S]*A\nB[\s\S]*안녕$/)
    expect(withMemoryUpdate('안녕', 'A', '')).toBe('안녕')
  })
})

describe('문맥 보정 안전장치', () => {
  it('발음이 전혀 다른 문장으로 바꾸면 버리고, 비슷하면 받는다', async () => {
    const { acceptCorrection } = await import('../../src/main/corrector')
    expect(acceptCorrection('나쁜 거야?', '말투가 어때?')).toBe('나쁜 거야?')
    expect(acceptCorrection('인화 말곤 없어', '유나 말곤 없어')).toBe('유나 말곤 없어')
    expect(acceptCorrection('자이스 지금 역시야', '자비스 지금 몇 시야')).toBe('자비스 지금 몇 시야')
    expect(acceptCorrection('다운로드 폴더 열어줘', '교정: 다운로드 폴더 열어줘')).toBe('다운로드 폴더 열어줘')
    expect(acceptCorrection('열어줘', '열어줘 그리고 오늘 일정과 날씨와 뉴스까지 전부 정리해서 알려줘')).toBe('열어줘')
  })
})
