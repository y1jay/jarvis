// 응답 속도 개선: 빠른 대화 경로 판정, 문장 단위 읽기, 네이티브 인식 입력/힌트
import { describe, expect, it } from 'vitest'
import { needsAgent, AGENT_TOKEN } from '../../src/main/fastchat'
import { takeSentences } from '../../src/renderer/src/voice/text'
import { buildVocabPrompt, encodeWav, MODELS, defaultModelKey } from '../../src/main/stt'

describe('빠른 대화 경로 판정', () => {
  it.each(['안녕', '오늘 기분 어때?', '고마워', '일 더하기 일은?', '농담 하나 해줘', '파이썬이랑 자바 차이가 뭐야'])('바로 답: %s', (t) => {
    expect(needsAgent(t)).toBe(false)
  })
  it.each(['크롬 열어줘', 'README 수정해줘', '테스트 돌려', '카톡으로 엄마한테 보내줘', '이 프로젝트 구조 설명해줘', '깃허브 로그인해줘', '커밋해줘', '에뮬레이터 띄워줘', '오늘 서울 날씨 검색해줘'])('에이전트로: %s', (t) => {
    expect(needsAgent(t)).toBe(true)
  })
  it('넘김 토큰', () => {
    expect(AGENT_TOKEN).toBe('[[AGENT]]')
  })
})

describe('문장 단위로 바로 읽기', () => {
  it('끝난 문장만 떼고 나머지는 남긴다', () => {
    const r = takeSentences('안녕하세요, 자비스입니다. 오늘 일정은 세 건이 있습니다. 첫 번째는')
    expect(r.sentences).toEqual(['안녕하세요, 자비스입니다.', '오늘 일정은 세 건이 있습니다.'])
    expect(r.rest.trim()).toBe('첫 번째는')
  })
  it('짧은 조각은 다음 문장과 합친다', () => {
    const r = takeSentences('네. 지금 바로 프로젝트를 열겠습니다. ')
    expect(r.sentences).toEqual(['네. 지금 바로 프로젝트를 열겠습니다.'])
  })
  it('버퍼 끝의 마침표는 기다린다 (3.5 같은 숫자가 이어질 수 있음)', () => {
    expect(takeSentences('버전은 3.').sentences).toEqual([])
    expect(takeSentences('버전은 3.5 입니다. 다음').sentences).toEqual(['버전은 3.5 입니다.'])
  })
  it('스트리밍 조각을 이어 붙여도 같은 결과', () => {
    let buf = ''
    const out: string[] = []
    for (const piece of ['오늘은 ', '맑습니다', '. 내일은 비가 ', '올 예정입니다. 우산', ' 챙기세요.']) {
      const r = takeSentences(buf + piece)
      out.push(...r.sentences)
      buf = r.rest
    }
    expect(out).toEqual(['오늘은 맑습니다.', '내일은 비가 올 예정입니다.'])
    expect(buf.trim()).toBe('우산 챙기세요.')
  })
})

describe('네이티브 음성 인식 보조', () => {
  it('WAV 인코딩 (16kHz mono 16bit)', () => {
    const pcm = new Float32Array([0, 0.5, -0.5, 1, -1])
    const w = encodeWav(pcm)
    expect(w.subarray(0, 4).toString()).toBe('RIFF')
    expect(w.readUInt32LE(24)).toBe(16000)
    expect(w.readUInt16LE(34)).toBe(16)
    expect(w.length).toBe(44 + pcm.length * 2)
    expect(w.readInt16LE(44 + 3 * 2)).toBe(32767)
    expect(w.readInt16LE(44 + 4 * 2)).toBe(-32768)
  })
  it('인식 힌트: 중복 제거·길이 제한', () => {
    const p = buildVocabPrompt(['헤이 자비스', '자비스', '자비스', 'xcroll-be', 'a'.repeat(300)])
    expect(p).toBe('헤이 자비스, 자비스, xcroll-be')
  })
  it('플랫폼 기본 모델', () => {
    expect(MODELS[defaultModelKey()]).toBeTruthy()
  })
})
