// 실제 Claude + 실제 JARVIS 연결 코드: 작업 도중 새로 한 말이 줄 서지 않고 바로 전달되는지
//   - 하던 명령은 끊기지 않는다
//   - 새 말에 대한 답이 마지막 답에 들어 있고, 답은 한 번만 (앞 작업은 조용히)
//   - 답은 한국어
// 권한: 숫자 세기 명령 하나만 승인한다
import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Orchestrator } from '../../src/main/orchestrator'
import { ClaudeProvider } from '../../src/main/providers/claude'
import { isMostlyForeign } from '../../src/shared/lang'
import type { JobInfo } from '../../src/shared/types'

const COUNT = 'for i in 1 2 3 4 5 6; do echo step $i; sleep 2; done'

describe('내 말이 1순위 (실제 Claude)', () => {
  it('작업 도중 새 말 → 끊지 않고 바로 반영', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'jv-steer-'))
    const log: string[] = []
    const t0 = Date.now()
    const at = (): string => `${((Date.now() - t0) / 1000).toFixed(1)}s`
    const toolResults: string[] = []
    let firstTool = 0
    const o = new Orchestrator({
      createProvider: () => new ClaudeProvider(),
      buildContext: (s, turnId, emit) => ({
        turnId,
        cwd: ws,
        model: 'sonnet',
        permissionMode: 'default',
        env: {},
        emit,
        approve: async (req) => ({ approved: req.toolName === 'Bash' && String((req.input as { command?: string })?.command ?? '').startsWith('for i in 1 2 3 4 5 6') }),
        audit: () => undefined
      }),
      ask: async () => '',
      defaultCwd: () => ws,
      onSessions: () => undefined,
      onJob: () => undefined,
      onEvent: (e) => {
        if (e.event.kind === 'tool-use') {
          firstTool ||= Date.now()
          log.push(`${at()} 도구 시작: ${JSON.stringify(e.event.input).slice(0, 90)}`)
        }
        if (e.event.kind === 'tool-result') {
          toolResults.push(e.event.output)
          log.push(`${at()} 도구 결과: ${e.event.output.replace(/\n/g, ' ').slice(0, 80)}`)
        }
        if (e.event.kind === 'status') log.push(`${at()} 상태: ${e.event.message}`)
      },
      onTurnStart: (e) => log.push(`${at()} 차례 시작 (작업 ${e.jobId})`),
      onTurnDone: () => log.push(`${at()} 차례 끝`),
      onSteer: (e) => log.push(`${at()} 끼워 넣음: ${e.fromJobId} → ${e.jobId}`)
    })
    const job = (id: string, prompt: string): JobInfo => ({ id, prompt, status: 'planning', tasks: [], notes: [], via: 'voice', createdAt: 0 })
    const a = job('A', `Bash 로 \`${COUNT}\` 를 한 번만 실행하고(백그라운드 말고 그대로), 끝나면 "카운트 완료"라고 답해.`)
    const ra = o.runJob(a, a.prompt, 'claude', [], { project: null })
    // 명령이 돌기 시작하면 2초 뒤 말을 건다
    for (let i = 0; i < 200 && !firstTool; i++) await new Promise((r) => setTimeout(r, 100))
    await new Promise((r) => setTimeout(r, 2000))
    const b = job('B', '잠깐, 지금 무슨 작업 하고 있는지 한 문장으로 말해 줘.')
    log.push(`${at()} >>> 사용자가 새로 말함: ${b.prompt}`)
    const tb = Date.now()
    const rb = o.runJob(b, b.prompt, 'claude', [], { project: null })
    const [ja, jb] = await Promise.all([ra, rb])
    log.push(`${at()} A 답: "${ja.answer}" / 메모: ${ja.notes.join(', ')}`)
    log.push(`${at()} B 답 (${((Date.now() - tb) / 1000).toFixed(1)}초 뒤): ${jb.answer?.replace(/\n/g, ' ')}`)
    writeFileSync(join(tmpdir(), 'jv-steer-live.txt'), log.join('\n'))
    console.log(log.join('\n'))
    // 하던 명령은 끝까지 (끊기지 않음)
    expect(toolResults.join('\n')).toContain('step 6')
    // 답은 한 번만: A 는 조용히, B 가 합쳐진 답
    expect(ja.answer).toBe('')
    expect(jb.answer).toBeTruthy()
    expect(isMostlyForeign(jb.answer ?? '')).toBe(false)
    o.resetAll()
  }, 180_000)
})
