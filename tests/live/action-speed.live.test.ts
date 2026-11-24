// 실제 동작 확인 (창 없음, 읽기 전용 요청만): 일상 행동 요청이 빠른 모델의 일반 세션에서 처리되는지 + 소요 시간
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Orchestrator } from '../../src/main/orchestrator'
import { ClaudeProvider } from '../../src/main/providers/claude'
import type { JobInfo, SessionInfo } from '../../src/shared/types'

function make(actionModel: string | undefined) {
  const ws = mkdtempSync(join(tmpdir(), 'jv-ws-'))
  const models: string[] = []
  const o = new Orchestrator({
    createProvider: () => new ClaudeProvider(),
    // 앱과 같은 규칙: 프로젝트 없는 일반 세션은 actionModel
    buildContext: (s: SessionInfo, turnId, emit) => ({
      turnId,
      cwd: s.projectDir ?? ws,
      model: !s.projectDir && actionModel ? actionModel : undefined,
      permissionMode: 'auto',
      env: {},
      emit: (e) => {
        if (e.kind === 'session' && e.model) models.push(e.model)
        emit(e)
      },
      approve: async () => ({ approved: false, reason: '테스트: 승인 거부' }),
      audit: () => undefined
    }),
    ask: async () => '',
    defaultCwd: () => ws,
    onSessions: () => undefined,
    onJob: () => undefined,
    onEvent: () => undefined,
    onTurnStart: () => undefined,
    onTurnDone: () => undefined
  })
  return { o, models }
}
const job = (prompt: string): JobInfo => ({ id: 'j', prompt, status: 'planning', tasks: [], notes: [], via: 'voice', createdAt: 0 })

describe('일상 행동 속도 (실제 Claude, 읽기 전용)', () => {
  const PROMPTS = ['이 맥의 디스크 남은 용량이 얼마인지 한 문장으로 알려줘', '지금 실행 중인 앱 중에 크롬이 있는지 예/아니오로만 답해']
  it('빠른 모델 일반 세션 (미리 띄움) vs 기본 모델', async () => {
    const out: Record<string, number[]> = {}
    for (const [label, model] of [['빠른 모델(sonnet)', 'sonnet'], ['기본 모델', undefined]] as const) {
      const { o, models } = make(model)
      o.prewarmFor('claude', null)
      await new Promise((r) => setTimeout(r, 4000)) // 앱에서는 시작 직후 미리 띄워 둔다
      out[label] = []
      for (const p of PROMPTS) {
        const t = Date.now()
        const j = await o.runJob(job(p), p, 'claude', [], { project: null, focus: false })
        const ms = Date.now() - t
        out[label].push(ms)
        console.log(`  ${label} | ${models[0]} | ${(ms / 1000).toFixed(1)}s | ${String(j.answer).replace(/\n/g, ' ').slice(0, 60)}`)
        expect(j.status).toBe('done')
      }
      if (model) expect(models[0]).toMatch(/sonnet/)
      o.resetAll()
    }
    const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length
    console.log(`  평균: 빠른 ${(avg(out['빠른 모델(sonnet)']) / 1000).toFixed(1)}s / 기본 ${(avg(out['기본 모델']) / 1000).toFixed(1)}s`)
    expect(avg(out['빠른 모델(sonnet)'])).toBeLessThan(avg(out['기본 모델']))
  }, 300_000)
})
