// 실제 Claude: 턴 사이에 기억이 바뀌어도 (학습 후 매번 일어남) 답이 끊기지 않고, 프로세스를 다시 띄우지 않는다
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeProvider } from '../../src/main/providers/claude'
import type { AgentEvent } from '../../src/shared/types'

describe('기억이 바뀌는 사이의 턴', () => {
  it('미리 띄운 뒤 기억이 바뀌어도 매 턴 실제 답을 받고, 바뀐 기억을 안다', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'jv-mem-'))
    const p = new ClaudeProvider()
    let sessions = 0
    const ctx = (memory: string, sink: string[]) => ({
      turnId: 't',
      cwd,
      model: 'sonnet',
      permissionMode: 'auto' as const,
      env: {},
      memory,
      emit: (e: AgentEvent) => {
        if (e.kind === 'result') sink.push(e.text)
        if (e.kind === 'session') sessions++
      },
      approve: async () => ({ approved: false }),
      audit: () => undefined
    })
    p.warm(ctx('[기억] 사용자는 커피를 좋아한다.', []))
    await new Promise((r) => setTimeout(r, 3000))
    const times: number[] = []
    const answers: string[] = []
    for (const [mem, q] of [
      ['[기억] 사용자는 커피를 좋아한다.\n[기억] 사용자의 고양이 이름은 나비다.', '내 고양이 이름이 뭐야? 이름만.'],
      ['[기억] 사용자는 커피를 좋아한다.\n[기억] 사용자의 고양이 이름은 나비다.\n[기억] 사용자의 차는 아반떼다.', '내 차 이름은? 이름만.'],
      ['[기억] 사용자는 커피를 좋아한다.\n[기억] 사용자의 고양이 이름은 나비다.\n[기억] 사용자의 차는 아반떼다.', '방금 내가 처음에 물어본 게 뭐였지? 짧게.']
    ]) {
      const sink: string[] = []
      const t = Date.now()
      await p.send(q, ctx(mem, sink))
      times.push(Date.now() - t)
      answers.push(sink.join(' '))
    }
    console.log(answers.map((a, i) => `  ${times[i]}ms → ${a}`).join('\n'))
    expect(answers[0]).toMatch(/나비/)
    expect(answers[1]).toMatch(/아반떼/)
    expect(answers[2]).toMatch(/고양이/)
    // 다시 띄우지 않음: 다시 띄우면 매 턴 3초 이상 걸린다
    for (const t of times) expect(t).toBeLessThan(3500)
    expect(sessions).toBeGreaterThan(0)
    p.reset()
  }, 180_000)
})

describe('에이전트가 다른 경로의 앞 대화를 이어받음', () => {
  it('"그렇게 해줘" → 앞에서 제안한 일을 한다', async () => {
    const { DialogContext } = await import('../../src/main/dialog')
    const d = new DialogContext()
    d.add({ user: '숫자 놀이 하자', jarvis: '좋아요. 1부터 10까지 모두 더한 값을 계산해 드릴까요?', lane: 'fast' })
    const cwd = mkdtempSync(join(tmpdir(), 'jv-ctx-'))
    const p = new ClaudeProvider()
    const out: string[] = []
    await p.send(d.wrap('그렇게 해줘. 숫자만.', 'agent:general', '자비스'), {
      turnId: 't', cwd, model: 'sonnet', permissionMode: 'auto', env: {}, memory: '',
      emit: (e: AgentEvent) => { if (e.kind === 'result') out.push(e.text) },
      approve: async () => ({ approved: false }), audit: () => undefined
    })
    console.log(`  → ${out.join(' ')}`)
    expect(out.join(' ')).toMatch(/55/)
    p.reset()
  }, 120_000)
})
