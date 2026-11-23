import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ruleApproval, parseClassification, normPhrase } from '../../src/shared/approval'
import { ApprovalLexicon, ConversationLog, MemoryStore, parseMemoryExtraction } from '../../src/main/memory'
import { isAuthError, parseProviderIntent, parseSiteLoginIntent, splitTargets } from '../../src/main/intents'
import { resolveSiteDef, SENSITIVE_CLICK, SiteStore } from '../../src/main/sites'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'jv-learn-'))

describe('자연어 승인 판정 (규칙)', () => {
  it.each(['응', '응응', '어', '네', '넵', '예', 'ㅇㅇ', '그래', '그래 해', '그렇게 해', '그렇게 하자', '진행해', '진행시켜', '콜', '좋아', '오케이', '해', '해줘', '고고', '가자', '당연하지', '물론', '승인', '자비스, 진행해', 'yes', 'go ahead', 'do it', '올려'])('approve: %s', (t) => {
    expect(ruleApproval(t)).toBe('approve')
  })
  it.each(['하지 마', '하지마', '안 돼', '안 해', '잠깐', '잠깐만', '기다려', '보류', '나중에', '아니', '아니야', '아니요', '싫어', '됐어', '취소', '거부', '멈춰', '그만', '승인하지 마', '진행하지 말고', 'no', 'wait', "don't"])('deny: %s', (t) => {
    expect(ruleApproval(t)).toBe('deny')
  })
  it.each(['응?', '네?', '그래?', '뭐라고', '왜?', '무슨 커밋인데', '어떤 파일이야', '음…', '흠', ''])('판단 불가(질문/애매): %s', (t) => {
    expect(ruleApproval(t)).toBeNull()
  })
  it('AI 판정 응답 파싱', () => {
    expect(parseClassification('approve')).toBe('approve')
    expect(parseClassification(' Deny.')).toBe('deny')
    expect(parseClassification('unclear')).toBeNull()
  })
  it('표현 정규화', () => {
    expect(normPhrase('자비스, 그렇게 해요!')).toBe('그렇게해')
  })
})

describe('승인 표현 학습 사전', () => {
  it('AI 학습 → 조회, 사용자 결정이 AI 보다 우선, 영속화', () => {
    const f = join(tmp(), 'lex.json')
    const lx = new ApprovalLexicon(f)
    expect(lx.learn('밀어붙여', 'approve', 'ai')?.decision).toBe('approve')
    expect(lx.lookup('밀어 붙여!')?.decision).toBe('approve')
    expect(lx.learn('밀어붙여', 'deny', 'user')?.decision).toBe('deny')
    expect(lx.learn('밀어붙여', 'approve', 'ai')).toBeNull() // 사용자 결정은 AI 가 못 뒤집음
    const again = new ApprovalLexicon(f)
    expect(again.lookup('밀어붙여')).toMatchObject({ decision: 'deny', source: 'user', count: 2 })
    expect(again.remove('밀어붙여')).toBe(true)
    expect(again.lookup('밀어붙여')).toBeNull()
  })
})

describe('기억 / 대화 기록', () => {
  it('기억 추가(중복 제거) / 삭제 / 프롬프트 변환', () => {
    const m = new MemoryStore(join(tmp(), 'memory.json'))
    const added = m.add([{ text: '커밋 메시지는 한국어로 쓴다', category: 'preference' }, { text: '커밋 메시지는 한국어로 쓴다.' }, { text: 'xcroll-be 는 NestJS 백엔드', category: 'project' }], 'job1')
    expect(added.length).toBe(2)
    expect(m.asPrompt()).toContain('[preference] 커밋 메시지는 한국어로 쓴다')
    m.remove(added[0].id)
    expect(m.list().length).toBe(1)
  })
  it('추출 결과 파싱 (잘못된 카테고리 → fact)', () => {
    expect(parseMemoryExtraction('```json\n{"add":[{"text":"A","category":"habit"},{"text":"B","category":"weird"},{"text":""}]}\n```')).toEqual([
      { text: 'A', category: 'habit' },
      { text: 'B', category: 'fact' }
    ])
    expect(parseMemoryExtraction('없음')).toEqual([])
  })
  it('대화 기록 append-only + 최근 조회', () => {
    const f = join(tmp(), 'c.jsonl')
    const c = new ConversationLog(f)
    c.record({ type: 'job', ts: 't1', jobId: '1', provider: 'claude', via: 'voice', prompt: 'p1', answer: 'a1', status: 'done', tasks: [] })
    c.record({ type: 'turn', ts: 't2', sessionId: 's', title: 'x', provider: 'claude', project: null, prompt: 'p', answer: 'a', isError: false })
    c.record({ type: 'job', ts: 't3', jobId: '2', provider: 'gpt', via: 'text', prompt: 'p2', answer: 'a2', status: 'done', tasks: [] })
    expect(c.recent('job').map((r) => (r as { jobId: string }).jobId)).toEqual(['1', '2'])
    expect(c.count()).toBe(3)
    expect(readFileSync(f, 'utf8').trim().split('\n').length).toBe(3)
  })
})

describe('모델 연결 명령', () => {
  it.each([
    ['클로드 연결해줘', 'login', 'claude', ''],
    ['지피티 로그인해줘', 'login', 'gpt', ''],
    ['제미나이 연결 좀', 'login', 'gemini', ''],
    ['지피티로 바꿔줘', 'switch', 'gpt', ''],
    ['클로드로 전환해서 README 요약해줘', 'switch', 'claude', 'README 요약해줘'],
    ['제미나이 써줘', 'switch', 'gemini', ''],
    ['클로드 연결 끊어줘', 'logout', 'claude', ''],
    ['코덱스 로그아웃', 'logout', 'gpt', ''],
    ['모델 연결 상태 알려줘', 'status', null, '']
  ])('%s', (t, action, provider, rest) => {
    expect(parseProviderIntent(t)).toEqual({ action, provider, rest })
  })
  it.each(['이 함수 설명해줘', 'README 에 클로드 사용법 추가하고 커밋 메시지는 짧게 써줘'])('아님: %s', (t) => {
    expect(parseProviderIntent(t)).toBeNull()
  })
  it('인증 오류 감지', () => {
    expect(isAuthError('Error: Not logged in · Please run /login')).toBe(true)
    expect(isAuthError('401 Unauthorized')).toBe(true)
    expect(isAuthError('TypeError: x is undefined')).toBe(false)
  })
})

describe('사이트 로그인 연동', () => {
  it.each([
    ['깃허브 로그인해줘', '깃허브', 'login'],
    ['노션 연결해줘', '노션', 'login'],
    ['슬랙 계정 연동해줘', '슬랙', 'login'],
    ['네이버 로그아웃해줘', '네이버', 'logout'],
    ['example.com 로그인', 'example.com', 'login']
  ])('%s', (t, site, action) => {
    expect(parseSiteLoginIntent(t)).toEqual({ site, action })
  })
  it('AI 모델 이름은 사이트 로그인이 아님', () => {
    expect(parseSiteLoginIntent('클로드 로그인해줘')).toBeNull()
  })
  it('사이트 해석', () => {
    expect(resolveSiteDef('깃허브')?.url).toBe('https://github.com/login')
    expect(resolveSiteDef('노션')?.domain).toBe('notion.so')
    expect(resolveSiteDef('example.com')?.domain).toBe('example.com')
    expect(resolveSiteDef('없는사이트')).toBeNull()
  })
  it('민감 클릭 감지', () => {
    for (const t of ['결제하기', '구매', 'Delete repository', '송금', 'Checkout']) expect(SENSITIVE_CLICK.test(t)).toBe(true)
    for (const t of ['Pull requests', '다음', 'Sign in']) expect(SENSITIVE_CLICK.test(t)).toBe(false)
  })
  it('연결 사이트 저장', () => {
    const f = join(tmp(), 'sites.json')
    const st = new SiteStore(f)
    st.upsert(resolveSiteDef('깃허브')!)
    expect(new SiteStore(f).list().map((x) => x.key)).toEqual(['github'])
    st.remove('github')
    expect(new SiteStore(f).list()).toEqual([])
  })
  it('여러 대상 분리', () => {
    expect(splitTargets('xcroll-be랑 xcroll-app')).toEqual(['xcroll-be', 'xcroll-app'])
    expect(splitTargets('a, b 그리고 c')).toEqual(['a', 'b', 'c'])
    expect(splitTargets('jarvis')).toEqual(['jarvis'])
  })
})
