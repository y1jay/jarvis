import { describe, expect, it } from 'vitest'
import type { AgentEvent, JobInfo, ProviderId, SessionInfo } from '../../src/shared/types'
import type { AgentProvider, TurnContext } from '../../src/main/providers/types'
import { mentionedProjects, needsPlanning, Orchestrator, parsePlan } from '../../src/main/orchestrator'

const KNOWN = ['/w/xcroll-be', '/w/xcroll-app', '/w/xcroll-admin', '/w/moneytree-backend', '/h/Jarvis']

/** 가짜 AI: cwd 와 프롬프트를 기록하고, 지연 후 답한다 */
class FakeProvider implements AgentProvider {
  static log: Array<{ cwd: string; prompt: string; start: number; end: number; instance: number }> = []
  static n = 0
  readonly id: ProviderId = 'claude'
  private inst = ++FakeProvider.n
  sessionId(): string | null {
    return null
  }
  reset(): void {}
  async interrupt(): Promise<void> {}
  async send(prompt: string, ctx: TurnContext): Promise<void> {
    const start = Date.now()
    await new Promise((r) => setTimeout(r, 120))
    ctx.emit({ kind: 'text-delta', text: `done@${ctx.cwd}` })
    ctx.emit({ kind: 'result', text: `완료: ${ctx.cwd.split('/').pop()}`, isError: false })
    FakeProvider.log.push({ cwd: ctx.cwd, prompt, start, end: Date.now(), instance: this.inst })
  }
}

function make(askImpl: (prompt: string) => Promise<string>) {
  FakeProvider.log = []
  const jobs: JobInfo[] = []
  const events: AgentEvent[] = []
  let sessions: SessionInfo[] = []
  const o = new Orchestrator({
    createProvider: () => new FakeProvider(),
    buildContext: (s, turnId, emit) => ({ turnId, cwd: s.projectDir ?? '/tmp/ws', permissionMode: 'acceptEdits', env: {}, emit, approve: async () => ({ approved: false }), audit: () => undefined }),
    ask: (_p, prompt) => askImpl(prompt),
    defaultCwd: () => '/tmp/ws',
    onSessions: (l) => (sessions = l),
    onJob: (j) => jobs.push(j),
    onEvent: (e) => events.push(e.event),
    onTurnStart: () => undefined,
    onTurnDone: () => undefined
  })
  const newJob = (prompt: string): JobInfo => ({ id: 'j', prompt, status: 'planning', tasks: [], notes: [], via: 'text', createdAt: 0 })
  return { o, jobs, events, sessions: () => sessions, newJob }
}

describe('mentionedProjects / needsPlanning', () => {
  it('여러 프로젝트 언급', () => {
    expect(mentionedProjects('xcroll-be 에 API 추가하고 xcroll-app 에서 호출하게 해줘', KNOWN)).toEqual(['/w/xcroll-admin', '/w/xcroll-app', '/w/xcroll-be'].filter((p) => ['xcroll-app', 'xcroll-be'].some((n) => p.endsWith(n))).sort((a, b) => b.length - a.length))
    expect(needsPlanning('x', ['/a', '/b'])).toBe(true)
    expect(needsPlanning('그냥 테스트 돌려', ['/a'])).toBe(false)
    expect(needsPlanning('xcroll-be 랑 나머지 각각 테스트', ['/a'])).toBe(true)
  })
  it('겹치는 이름은 긴 것 우선', () => {
    expect(mentionedProjects('moneytree-backend 고쳐줘', ['/w/moneytree-backend', '/w/moneytree'])).toEqual(['/w/moneytree-backend'])
  })
})

describe('parsePlan', () => {
  it('JSON 추출 + 알 수 없는 경로는 null + 잘못된 의존성 제거', () => {
    const raw = 'blah {"tasks":[{"project":"/w/xcroll-be","instruction":"API 추가","after":[]},{"project":"/nope","instruction":"호출","after":[0,5,1]}]} trailing'
    expect(parsePlan(raw, KNOWN)).toEqual([
      { project: '/w/xcroll-be', instruction: 'API 추가', after: [] },
      { project: null, instruction: '호출', after: [0] }
    ])
    expect(parsePlan('nope', KNOWN)).toBeNull()
  })
})

describe('Orchestrator', () => {
  it('여러 프로젝트 요청 → 각 세션에서 병렬 실행 → 한 답변으로 요약', async () => {
    const asks: string[] = []
    const { o, jobs, newJob, sessions } = make(async (p) => {
      asks.push(p)
      if (p.includes('작업 분배기')) return JSON.stringify({ tasks: [{ project: '/w/xcroll-be', instruction: 'be 테스트', after: [] }, { project: '/w/xcroll-app', instruction: 'app 테스트', after: [] }] })
      return 'JARVIS 요약: 두 프로젝트 모두 통과'
    })
    const job = await o.runJob(newJob('xcroll-be 랑 xcroll-app 각각 테스트 돌려줘'), 'xcroll-be 랑 xcroll-app 각각 테스트 돌려줘', 'claude', KNOWN)
    expect(job.status).toBe('done')
    expect(job.answer).toBe('JARVIS 요약: 두 프로젝트 모두 통과')
    expect(job.tasks.map((t) => t.status)).toEqual(['done', 'done'])
    expect(new Set(job.tasks.map((t) => t.sessionId)).size).toBe(2) // 세션 분리
    expect(sessions().map((s) => s.projectDir).sort()).toEqual(['/w/xcroll-app', '/w/xcroll-be'])
    const [a, b] = FakeProvider.log
    expect(a.instance).not.toBe(b.instance) // 서로 다른 AI 인스턴스(대화 분리)
    expect(Math.max(a.start, b.start)).toBeLessThan(Math.min(a.end, b.end)) // 시간 겹침 = 병렬
    expect(asks.some((x) => x.includes('여러 세션에서 나눠 처리한'))).toBe(true)
    expect(jobs.some((j) => j.status === 'summarizing')).toBe(true)
  })

  it('의존성: app 작업은 be 결과를 받아 be 이후에 실행', async () => {
    const { o, newJob } = make(async (p) =>
      p.includes('작업 분배기') ? JSON.stringify({ tasks: [{ project: '/w/xcroll-be', instruction: 'API 추가', after: [] }, { project: '/w/xcroll-app', instruction: 'API 호출 추가', after: [0] }] }) : '요약'
    )
    await o.runJob(newJob('q'), 'xcroll-be 에 API 만들고 xcroll-app 에서 써줘', 'claude', KNOWN)
    const [be, app] = FakeProvider.log
    expect(be.cwd).toBe('/w/xcroll-be')
    expect(app.cwd).toBe('/w/xcroll-app')
    expect(app.start).toBeGreaterThanOrEqual(be.end)
    expect(app.prompt).toContain('[앞선 작업 결과]')
    expect(app.prompt).toContain('완료: xcroll-be')
  })

  it('단일 프로젝트 언급 → 계획 없이 그 프로젝트 세션으로 라우팅, 답변 = 세션 결과', async () => {
    const asks: string[] = []
    const { o, newJob } = make(async (p) => {
      asks.push(p)
      return ''
    })
    const job = await o.runJob(newJob('q'), 'xcroll-admin 에서 린트 돌려줘', 'claude', KNOWN)
    expect(asks).toEqual([])
    expect(FakeProvider.log[0].cwd).toBe('/w/xcroll-admin')
    expect(job.answer).toBe('완료: xcroll-admin')
    expect(o.get(o.focusedId()!)?.projectDir).toBe('/w/xcroll-admin')
  })

  it('같은 프로젝트 후속 요청은 같은 세션 재사용, 같은 세션 턴은 직렬', async () => {
    const { o, newJob } = make(async () => '')
    const s = o.sessionFor('claude', '/w/xcroll-be', true)
    await Promise.all([o.runInSession(s.id, 'a'), o.runInSession(s.id, 'b')])
    const [a, b] = FakeProvider.log
    expect(b.start).toBeGreaterThanOrEqual(a.end)
    await o.runJob(newJob('q'), '다음 작업', 'claude', KNOWN)
    expect(o.list().length).toBe(1)
  })

  it('계획 실패 시 언급된 프로젝트마다 원 요청으로 폴백', async () => {
    const { o, newJob } = make(async (p) => (p.includes('작업 분배기') ? '모르겠다' : '요약'))
    const job = await o.runJob(newJob('q'), 'xcroll-be 랑 xcroll-app 둘 다 빌드', 'claude', KNOWN)
    expect(job.tasks.length).toBe(2)
    expect(job.tasks.every((t) => t.instruction === 'xcroll-be 랑 xcroll-app 둘 다 빌드')).toBe(true)
  })

  it('세션 닫기', () => {
    const { o } = make(async () => '')
    const a = o.newSession('claude', '/w/a')
    o.newSession('gpt', '/w/b')
    o.close(a.id)
    expect(o.list().map((s) => s.projectDir)).toEqual(['/w/b'])
  })
})

describe('mentionedProjects 오탐 방지', () => {
  it('따옴표/백틱 안의 단어는 프로젝트 언급이 아님', () => {
    expect(mentionedProjects('e2e.txt 에 "hello jarvis" 를 쓰고 `git commit -m jarvis` 해', KNOWN)).toEqual([])
  })
  it('다른 단어의 일부는 언급 아님 / 단어로 쓰이면 언급', () => {
    expect(mentionedProjects('jarvisfoo 를 고쳐', KNOWN)).toEqual([])
    expect(mentionedProjects('jarvis 테스트 돌려', KNOWN)).toEqual(['/h/Jarvis'])
    expect(mentionedProjects('xcroll be 에서 린트', KNOWN)).toEqual(['/w/xcroll-be'])
  })
})

describe('도구 이름 속 단어는 프로젝트 언급 아님', () => {
  it('mcp__jarvis__ask_user', () => {
    expect(mentionedProjects('mcp__jarvis__ask_user 도구로 물어봐', KNOWN)).toEqual([])
    expect(mentionedProjects('jarvis_test 변수', KNOWN)).toEqual([])
  })
})

describe('생성된 지시문은 프로젝트 고정', () => {
  it('opts.project 가 있으면 이름 언급(JARVIS 등)을 무시하고 그 프로젝트에서 실행', async () => {
    const asks: string[] = []
    const { o, newJob } = make(async (p) => {
      asks.push(p)
      return ''
    })
    await o.runJob(newJob('q'), '[JARVIS 출시 플레이북] jarvis xcroll-be xcroll-app 언급', 'claude', KNOWN, { project: '/w/moneytree-backend' })
    expect(asks).toEqual([]) // 계획 단계 없음
    expect(FakeProvider.log.map((l) => l.cwd)).toEqual(['/w/moneytree-backend'])
  })
})
