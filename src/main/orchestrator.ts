// JARVIS 오케스트레이터: 하나의 요청을 프로젝트별 작업으로 나눠 각자의 세션에서 실행(독립 작업은 병렬),
// 결과를 모아 JARVIS 한 목소리로 답한다. 세션 = (AI, 프로젝트) 단위의 독립 대화.
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { AgentEvent, JobInfo, ProviderId, SessionInfo, TaskInfo } from '../shared/types'
import type { AgentProvider, TurnContext } from './providers/types'
import { norm } from './projects'

export interface OrchestratorDeps {
  createProvider: (p: ProviderId) => AgentProvider
  /** 세션 한 턴을 위한 컨텍스트 (env, 승인, 이력, 도구 등) */
  buildContext: (session: SessionInfo, turnId: string, emit: (e: AgentEvent) => void) => TurnContext
  /** 도구 없는 단발 질의 (계획 / 요약용) */
  ask: (provider: ProviderId, prompt: string) => Promise<string>
  defaultCwd: () => string
  onSessions: (list: SessionInfo[], focused: string | null) => void
  onJob: (job: JobInfo) => void
  onEvent: (e: { turnId: string; sessionId: string; provider: ProviderId; event: AgentEvent }) => void
  onTurnStart: (e: { turnId: string; sessionId: string; provider: ProviderId; prompt: string; jobId?: string }) => void
  onTurnDone: (e: { turnId: string; sessionId: string; provider: ProviderId }) => void
  /** 작업 도중 사용자의 새 말을 지금 차례에 끼워 넣었다 */
  onSteer?: (e: { sessionId: string; jobId?: string; fromJobId?: string; prompt: string }) => void
  onSessionOpen?: (s: SessionInfo) => void
  onSessionClose?: (s: SessionInfo) => void
}

interface SessionRec {
  info: SessionInfo
  provider: AgentProvider
  chain: Promise<unknown>
  /** 뒤 작업이 끝나고 AI 의 완료 보고를 기다리는 중 */
  awaitingReport?: ReturnType<typeof setTimeout> | null
  /** 지금 돌고 있는 차례 (작업 도중 사용자가 새로 말하면 여기에 끼워 넣는다) */
  active?: { turnId: string; jobId?: string; done: Promise<TurnResult> } | null
  /** 답을 말하지 않고 조용히 끝낼 작업 (새 말에 자리를 넘겼거나 사용자가 멈춘 작업) */
  silenced?: Map<string, 'steer' | 'stop'>
}

export interface TurnResult {
  text: string
  isError: boolean
  /** 사용자의 새 말에 자리를 넘기거나 멈춰서 조용히 끝난 차례 */
  silenced?: 'steer' | 'stop'
}

/** 작업 도중 들어온 사용자의 새 말 — 하던 작업을 끊지 않고 바로 보게 한다 */
export function steerPrompt(prompt: string): string {
  return [
    '[사용자가 작업 도중 새로 한 말 — 이 말이 1순위다]',
    prompt,
    '',
    '(이 말을 바로 반영하라. 멈추라는 뜻이면 멈추고, 하던 작업을 바꾸라는 뜻이면 바꿔라. 하던 작업과 관계없는 말이면 먼저 답하고 하던 작업을 마저 끝내라. 마지막 답에는 이 말에 대한 답이 꼭 들어가야 한다.)'
  ].join('\n')
}

export interface PlannedTask {
  project: string | null
  instruction: string
  after: number[]
}

/**
 * 요청에 이름이 등장하는 프로젝트들.
 * - 따옴표/백틱 안(파일 내용, 명령어 등)은 제외 — "hello jarvis" 같은 문자열을 프로젝트 언급으로 오인하지 않게
 * - 단어 경계로만 매칭, 5자 이상 이름만, 긴 이름 우선으로 겹침 제거
 */
export function mentionedProjects(prompt: string, known: string[]): string[] {
  const text = prompt
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/"[^"]*"|“[^”]*”|'[^']*'|‘[^’]*’/g, ' ')
    .toLowerCase()
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const hits = known
    .map((p) => ({ p, name: basename(p).toLowerCase(), n: norm(basename(p)) }))
    .filter((x) => x.n.length >= 5)
    .filter((x) => {
      // 원래 이름 또는 구분자를 공백/없음으로 바꾼 변형이 단어로 등장
      const variants = [x.name, x.name.replace(/[-_.]/g, ' '), x.name.replace(/[-_.]/g, '')]
      return variants.some((v) => new RegExp(`(^|[^a-z0-9가-힣/\\-_])${esc(v)}($|[^a-z0-9/\\-_])`).test(text))
    })
    .sort((a, b) => b.n.length - a.n.length)
  const out: string[] = []
  const used: string[] = []
  for (const h of hits) {
    if (used.some((u) => u.includes(h.n))) continue // xcroll-be 가 xcroll-be-admin 에 포함되는 경우 등
    used.push(h.n)
    out.push(h.p)
  }
  return out
}

const PARALLEL_HINT = /(각각|동시에|병렬|모든\s*프로젝트|전부\s*다|여러\s*프로젝트|둘\s*다|세\s*개\s*다|양쪽)/

export function needsPlanning(prompt: string, mentioned: string[]): boolean {
  return mentioned.length >= 2 || (mentioned.length >= 1 && PARALLEL_HINT.test(prompt))
}

export function planPrompt(prompt: string, known: string[], focused: string | null): string {
  return [
    '너는 JARVIS 의 작업 분배기다. 사용자 요청을 프로젝트별 독립 작업으로 나눈다.',
    '규칙:',
    '- 각 작업은 하나의 프로젝트 경로에서 실행된다. project 는 아래 목록의 경로를 그대로 쓴다 (프로젝트가 필요 없으면 null).',
    '- instruction 은 그 프로젝트의 AI 개발자에게 줄 구체적인 한국어 지시문. 다른 프로젝트 작업 결과가 필요하면 after 에 그 작업 인덱스(0부터)를 넣는다.',
    '- 서로 독립적이면 after 는 빈 배열 (병렬 실행됨).',
    '- 쪼갤 필요가 없으면 작업 1개.',
    '- 출력은 JSON 하나만: {"tasks":[{"project":"/abs/path","instruction":"...","after":[]}]}',
    '',
    `현재 포커스 프로젝트: ${focused ?? '(없음)'}`,
    '프로젝트 목록:',
    ...known.slice(0, 300),
    '',
    `사용자 요청: ${prompt}`
  ].join('\n')
}

export function parsePlan(raw: string, known: string[]): PlannedTask[] | null {
  const m = /\{[\s\S]*\}/.exec(raw)
  if (!m) return null
  let j: { tasks?: Array<{ project?: unknown; instruction?: unknown; after?: unknown }> }
  try {
    j = JSON.parse(m[0])
  } catch {
    return null
  }
  if (!Array.isArray(j.tasks) || j.tasks.length === 0) return null
  const tasks: PlannedTask[] = []
  for (const t of j.tasks.slice(0, 8)) {
    if (typeof t.instruction !== 'string' || !t.instruction.trim()) return null
    const project = typeof t.project === 'string' && known.includes(t.project) ? t.project : null
    const after = Array.isArray(t.after) ? t.after.filter((x): x is number => Number.isInteger(x)) : []
    tasks.push({ project, instruction: t.instruction.trim(), after })
  }
  // 잘못된/순환 의존성 제거: 앞선 작업만 참조 허용
  tasks.forEach((t, i) => (t.after = t.after.filter((a) => a >= 0 && a < i)))
  return tasks
}

export function summaryPrompt(prompt: string, results: Array<{ title: string; text: string; isError: boolean }>): string {
  return [
    '너는 J.A.R.V.I.S. 다. 여러 세션에서 나눠 처리한 작업 결과를 사용자에게 하나의 답변으로 보고한다.',
    '한국어로, 정중하고 간결하게. 첫 문장은 귀로 들어도 이해되는 전체 요약. 이후 프로젝트별 핵심 결과를 짧은 목록으로.',
    '실패한 작업은 숨기지 말고 무엇이 실패했는지 말한다. 승인 대기/거부된 커밋·푸시가 있으면 명시한다.',
    '',
    `사용자 요청: ${prompt}`,
    '',
    ...results.map((r) => `## ${r.title}${r.isError ? ' (실패)' : ''}\n${r.text.slice(0, 6000)}`)
  ].join('\n')
}

export class Orchestrator {
  private sessions = new Map<string, SessionRec>()
  private focused: string | null = null

  constructor(private readonly d: OrchestratorDeps) {}

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => ({ ...s.info }))
  }
  focusedId(): string | null {
    return this.focused
  }
  get(id: string): SessionInfo | null {
    const s = this.sessions.get(id)
    return s ? { ...s.info } : null
  }

  private publish(): void {
    this.d.onSessions(this.list(), this.focused)
  }

  newSession(provider: ProviderId, projectDir: string | null, focus = true): SessionInfo {
    const name = projectDir ? basename(projectDir) : '일반'
    const sameName = [...this.sessions.values()].filter((s) => s.info.projectDir === projectDir && s.info.provider === provider).length
    const info: SessionInfo = {
      id: randomUUID(),
      title: sameName ? `${name} #${sameName + 1}` : name,
      provider,
      projectDir,
      status: 'idle',
      createdAt: Date.now(),
      lastActive: Date.now(),
      turns: 0
    }
    this.sessions.set(info.id, { info, provider: this.d.createProvider(provider), chain: Promise.resolve() })
    if (focus) this.focused = info.id
    this.d.onSessionOpen?.(info)
    this.publish()
    return { ...info }
  }

  focus(id: string): SessionInfo | null {
    if (!this.sessions.has(id)) return null
    this.focused = id
    this.publish()
    return this.get(id)
  }

  close(id: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    void s.provider.interrupt().catch(() => undefined)
    s.provider.reset()
    this.sessions.delete(id)
    if (this.focused === id) this.focused = [...this.sessions.keys()].pop() ?? null
    this.d.onSessionClose?.(s.info)
    this.publish()
  }

  /** 포커스된 세션의 AI 를 미리 띄워 둔다 */
  prewarm(): void {
    const rec = this.focused ? this.sessions.get(this.focused) : undefined
    if (!rec?.provider.warm) return
    rec.provider.warm(this.d.buildContext({ ...rec.info }, 'warm', () => undefined))
  }

  /** 특정 (AI, 프로젝트) 세션을 포커스 변경 없이 미리 띄워 둔다 — 일상 행동용 일반 세션 */
  prewarmFor(provider: ProviderId, projectDir: string | null): void {
    const info = this.sessionFor(provider, projectDir, false)
    const rec = this.sessions.get(info.id)
    if (!rec?.provider.warm) return
    rec.provider.warm(this.d.buildContext({ ...rec.info }, 'warm', () => undefined))
  }

  resetAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id)
  }

  /** 실행 중이던 세션 수를 돌려준다 */
  async interruptAll(): Promise<number> {
    const list = [...this.sessions.values()].filter((s) => s.info.status === 'running')
    // 사용자가 멈춘 작업은 '끊겼습니다' 같은 답을 따로 말하지 않는다
    for (const s of list) if (s.active?.jobId) (s.silenced ??= new Map()).set(s.active.jobId, 'stop')
    await Promise.all(list.map((s) => s.provider.interrupt().catch(() => undefined)))
    return list.length
  }

  /** (AI, 프로젝트) 세션 재사용 — 포커스된 것 우선, 없으면 새로 */
  sessionFor(provider: ProviderId, projectDir: string | null, focus = false): SessionInfo {
    const f = this.focused ? this.sessions.get(this.focused) : undefined
    if (f && f.info.provider === provider && f.info.projectDir === projectDir) return { ...f.info }
    const existing = [...this.sessions.values()]
      .filter((s) => s.info.provider === provider && s.info.projectDir === projectDir)
      .sort((a, b) => b.info.lastActive - a.info.lastActive)[0]
    if (existing) {
      if (focus) this.focus(existing.info.id)
      return { ...existing.info }
    }
    return this.newSession(provider, projectDir, focus)
  }

  /** 세션에서 한 턴 실행. 같은 세션의 턴은 순서대로(직렬), 다른 세션끼리는 동시에. */
  runInSession(sessionId: string, prompt: string, jobId?: string, opts: { preempt?: boolean } = {}): Promise<TurnResult> {
    const rec = this.sessions.get(sessionId)
    if (!rec) return Promise.resolve({ text: '세션이 닫혔습니다.', isError: true })
    // 사용자의 새 말은 앞 작업이 끝날 때까지 줄 서지 않는다 — 하던 작업을 끊지 않고 지금 차례에 바로 끼워 넣는다.
    // 앞 작업의 답은 조용히 넘기고, 합쳐진 마지막 답을 새 말의 답으로 한 번만 말한다.
    const cur = rec.active
    if (opts.preempt && cur && cur.jobId !== jobId && rec.provider.steer?.(steerPrompt(prompt))) {
      if (cur.jobId) (rec.silenced ??= new Map()).set(cur.jobId, 'steer')
      const from = cur.jobId
      cur.jobId = jobId
      this.d.onEvent({ turnId: cur.turnId, sessionId, provider: rec.info.provider, event: { kind: 'status', message: `🎙 하던 작업에 새 말씀을 바로 전했습니다: ${prompt.slice(0, 200)}` } })
      this.d.onSteer?.({ sessionId, jobId, fromJobId: from, prompt })
      return cur.done.then((r) => ({ text: r.text, isError: r.isError }))
    }
    const run = async (): Promise<TurnResult> => {
      const turnId = randomUUID()
      let settle: (r: TurnResult) => void = () => undefined
      rec.active = { turnId, jobId, done: new Promise<TurnResult>((r) => (settle = r)) }
      const info = rec.info
      info.status = 'running'
      info.lastActive = Date.now()
      info.turns++
      this.publish()
      this.d.onTurnStart({ turnId, sessionId, provider: info.provider, prompt, jobId })
      let lastText = ''
      let streamed = ''
      let resultText = ''
      let turnRunning = false
      let isError = false
      const errors: string[] = []
      const emit = (event: AgentEvent): void => {
        if (event.kind === 'text-delta') streamed += event.text
        else if (event.kind === 'text') {
          if (event.text) lastText = event.text
          else if (streamed) lastText = streamed
          streamed = ''
        } else if (event.kind === 'result') {
          resultText = event.text
          isError = isError || event.isError
        } else if (event.kind === 'error') {
          isError = true
          errors.push(event.message)
        } else if (event.kind === 'background') {
          // 뒤에서 도는 작업이 남아 있는 동안은 이 세션을 '작업 중'으로.
          // 다 끝나도 AI 가 완료 보고를 쓰는 동안은 계속 작업 중 (보고가 오거나 90초가 지나면 끝)
          const had = info.background ?? 0
          info.background = event.count
          if (event.count > 0) info.status = 'running'
          else if (had > 0) {
            rec.awaitingReport = setTimeout(() => {
              rec.awaitingReport = null
              if (!info.background && info.status === 'running') {
                info.status = 'idle'
                this.publish()
              }
            }, 90_000)
          } else if (!turnRunning) info.status = 'idle'
          this.publish()
        } else if (event.kind === 'followup') {
          if (rec.awaitingReport) clearTimeout(rec.awaitingReport)
          rec.awaitingReport = null
          if (!info.background && !turnRunning) {
            info.status = 'idle'
            this.publish()
          }
        }
        this.d.onEvent({ turnId, sessionId, provider: info.provider, event })
      }
      turnRunning = true
      try {
        await rec.provider.send(prompt, this.d.buildContext({ ...info }, turnId, emit))
      } catch (e) {
        isError = true
        errors.push((e as Error).message)
        this.d.onEvent({ turnId, sessionId, provider: info.provider, event: { kind: 'error', message: (e as Error).message } })
      } finally {
        turnRunning = false
        info.status = isError ? 'error' : info.background || rec.awaitingReport ? 'running' : 'idle'
        info.lastActive = Date.now()
        this.publish()
        this.d.onTurnDone({ turnId, sessionId, provider: info.provider })
      }
      const text = resultText || lastText || streamed || errors.join('\n')
      const result: TurnResult = { text, isError }
      rec.active = null
      settle(result)
      const quiet = jobId ? rec.silenced?.get(jobId) : undefined
      if (jobId && quiet) {
        rec.silenced!.delete(jobId)
        return { text: '', isError: false, silenced: quiet }
      }
      return result
    }
    const next = rec.chain.then(run, run)
    rec.chain = next.catch(() => undefined)
    return next
  }

  /**
   * 요청 하나 = 작업(Job) 하나. 여러 프로젝트가 언급되면 계획을 세워 세션별로 나눠 실행하고 한 답변으로 합친다.
   * 반환값은 JARVIS 최종 답변.
   */
  async runJob(job: JobInfo, prompt: string, provider: ProviderId, known: string[], opts?: { project: string | null; focus?: boolean }): Promise<JobInfo> {
    job.status = 'planning'
    this.d.onJob(structuredClone(job))
    const focusedRec = this.focused ? this.sessions.get(this.focused) : undefined
    const focusedProject = focusedRec?.info.projectDir ?? null
    // 고정 프로젝트가 주어지면(생성된 지시문) 이름 분석/분배를 하지 않는다
    const mentioned = opts ? [] : mentionedProjects(prompt, known)

    let plan: PlannedTask[] | null = null
    if (needsPlanning(prompt, mentioned)) {
      try {
        plan = parsePlan(await this.d.ask(provider, planPrompt(prompt, known, focusedProject)), known)
      } catch {
        plan = null
      }
      // 계획 실패 시: 언급된 프로젝트마다 같은 지시를 병렬로
      plan ??= mentioned.map((p) => ({ project: p, instruction: prompt, after: [] }))
    } else {
      // 단일 작업: 언급된 프로젝트가 하나면 그 세션으로, 아니면 포커스 세션
      const project = opts ? opts.project : (mentioned[0] ?? focusedProject)
      plan = [{ project, instruction: prompt, after: [] }]
    }

    // 세션 배정
    const assigned = plan.map((t) => {
      const sameAsFocused = focusedRec && focusedRec.info.projectDir === t.project && focusedRec.info.provider === provider
      // focus:false = 일상 행동 세션처럼, 사용자가 보고 있던 프로젝트 포커스를 빼앗지 않는다
      const s = sameAsFocused ? { ...focusedRec.info } : this.sessionFor(provider, t.project, opts?.focus ?? plan!.length === 1)
      return s
    })
    job.tasks = plan.map<TaskInfo>((t, i) => ({ id: randomUUID(), sessionId: assigned[i].id, title: assigned[i].title, instruction: t.instruction, status: 'pending', after: t.after }))
    job.status = 'running'
    this.d.onJob(structuredClone(job))

    // 의존성 순서대로 실행 (독립 작업은 동시에)
    const results: Array<Promise<TurnResult>> = []
    plan.forEach((t, i) => {
      results[i] = (async () => {
        const deps = await Promise.all(t.after.map((a) => results[a]))
        const task = job.tasks[i]
        let instruction = t.instruction
        if (deps.length) {
          instruction += '\n\n[앞선 작업 결과]\n' + t.after.map((a, k) => `### ${job.tasks[a].title}\n${deps[k].text.slice(0, 4000)}`).join('\n\n')
        }
        task.status = 'running'
        this.d.onJob(structuredClone(job))
        const r = await this.runInSession(task.sessionId, instruction, job.id, { preempt: true })
        task.status = r.isError ? 'error' : 'done'
        task.result = r.text
        this.d.onJob(structuredClone(job))
        return r
      })()
    })
    const done = await Promise.all(results)

    // 새 말씀에 자리를 넘겼거나 멈춘 작업 — 답을 따로 말하지 않는다
    const quiet = done.find((r) => r.silenced)?.silenced
    if (quiet) {
      job.answer = ''
      job.notes.push(quiet === 'stop' ? '말씀대로 멈췄습니다' : '새 말씀을 먼저 반영했습니다')
      job.status = 'done'
      this.d.onJob(structuredClone(job))
      return job
    }
    if (done.length === 1) {
      job.answer = done[0].text
    } else {
      job.status = 'summarizing'
      this.d.onJob(structuredClone(job))
      const items = done.map((r, i) => ({ title: job.tasks[i].title, text: r.text, isError: r.isError }))
      try {
        job.answer = (await this.d.ask(provider, summaryPrompt(prompt, items))).trim()
      } catch {
        job.answer = ''
      }
      if (!job.answer) job.answer = items.map((x) => `### ${x.title}${x.isError ? ' (실패)' : ''}\n${x.text}`).join('\n\n')
    }
    job.status = done.every((r) => r.isError) ? 'error' : 'done'
    this.d.onJob(structuredClone(job))
    return job
  }
}
