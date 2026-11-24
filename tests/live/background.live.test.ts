// 실제 Claude: 뒤에서 도는 작업이 끝날 때까지 '작업 중'이고, 끝나면 완료 보고가 온다
import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Orchestrator } from '../../src/main/orchestrator'
import { ClaudeProvider } from '../../src/main/providers/claude'
import type { JobInfo, SessionInfo } from '../../src/shared/types'

describe('뒤에서 도는 작업', () => {
  it('차례가 끝나도 뒤 작업이 남아 있으면 작업 중 → 끝나면 완료 보고', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'jv-bg-'))
    const log: string[] = []
    let sessions: SessionInfo[] = []
    const followups: string[] = []
    const t0 = Date.now()
    const at = (): string => `${((Date.now() - t0) / 1000).toFixed(1)}s`
    const o = new Orchestrator({
      createProvider: () => new ClaudeProvider(),
      buildContext: (s, turnId, emit) => ({ turnId, cwd: ws, model: 'sonnet', permissionMode: 'auto', env: {}, emit, approve: async () => ({ approved: true }), audit: () => undefined }),
      ask: async () => '',
      defaultCwd: () => ws,
      onSessions: (l) => (sessions = l),
      onJob: () => undefined,
      onEvent: (e) => {
        if (e.event.kind === 'background') log.push(`${at()} 뒤 작업 ${e.event.count}개 ${e.event.tasks.join(', ')} → 작업 중? ${sessions.some((x) => x.status === 'running')}`)
        if (e.event.kind === 'followup') {
          followups.push(e.event.text)
          log.push(`${at()} 완료 보고: ${e.event.text.replace(/\n/g, ' ').slice(0, 80)}`)
        }
      },
      onTurnStart: () => undefined,
      onTurnDone: () => log.push(`${at()} 차례 끝`)
    })
    const job: JobInfo = { id: 'j', prompt: '', status: 'planning', tasks: [], notes: [], via: 'text', createdAt: 0 }
    const prompt = 'Bash 도구로 `sleep 10 && echo 검토완료` 를 run_in_background 로 실행해. 실행만 걸어 두고 기다리지 말고 바로 "시작했어요" 라고만 답해. 끝나면 결과를 한 문장으로 알려줘.'
    await o.runJob(job, prompt, 'claude', [], { project: null })
    log.push(`${at()} 첫 답: ${job.answer}`)
    const busyAfterTurn = sessions.some((s) => s.status === 'running')
    log.push(`${at()} 차례 끝난 직후 작업 중? ${busyAfterTurn}`)
    // 차례가 끝난 뒤 완료 보고가 올 때까지 0.2초마다 '작업 중'인지 본다
    let idleBeforeReport = 0
    for (let i = 0; i < 300 && !followups.length; i++) {
      if (!sessions.some((x) => x.status === 'running')) idleBeforeReport++
      await new Promise((r) => setTimeout(r, 200))
    }
    log.push(`${at()} 보고 전까지 '쉬는 중'으로 보인 횟수: ${idleBeforeReport}`)
    await new Promise((r) => setTimeout(r, 1500))
    const busyAtEnd = sessions.some((s) => s.status === 'running')
    log.push(`${at()} 모두 끝난 뒤 작업 중? ${busyAtEnd}`)
    if (process.env.STT_REPORT) writeFileSync(process.env.STT_REPORT, log.join('\n'))
    console.log(log.join('\n'))
    expect(busyAfterTurn).toBe(true)
    expect(followups.join(' ')).toMatch(/검토완료|완료/)
    expect(idleBeforeReport).toBe(0)
    expect(busyAtEnd).toBe(false)
    o.resetAll()
  }, 180_000)
})
