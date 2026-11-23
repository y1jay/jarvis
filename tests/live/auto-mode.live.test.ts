// auto 권한 모드: 안전한 명령은 묻지 않고 실행, commit 은 여전히 JARVIS 승인 게이트
import { expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeProvider } from '../../src/main/providers/claude'
import { git } from '../../src/main/git'
import type { AgentEvent } from '../../src/shared/types'

it('auto 모드: ls 는 승인 없이, git commit 은 승인 요청', async () => {
  const d = mkdtempSync(join(tmpdir(), 'jarvis-auto-'))
  await git(d, ['init', '-q', '-b', 'main'])
  await git(d, ['config', 'user.email', 'a@example.com'])
  await git(d, ['config', 'user.name', 'A'])
  writeFileSync(join(d, 'a.txt'), 'x\n')
  const approvals: string[] = []
  const events: AgentEvent[] = []
  const p = new ClaudeProvider()
  await p.send('Bash 로 `ls` 를 실행하고, 이어서 `git add a.txt && git commit -m "t"` 를 실행해. 거부되면 재시도하지 말고 결과만 한 줄로.', {
    turnId: 't',
    cwd: d,
    permissionMode: 'auto',
    env: {},
    emit: (e) => events.push(e),
    approve: async (r) => {
      approvals.push(`${r.kind}:${r.toolName}`)
      return { approved: false, reason: 'test' }
    },
    audit: () => undefined
  })
  console.log('approvals', approvals, 'tools', events.filter((e) => e.kind === 'tool-use').map((e) => (e as { input: { command?: string } }).input.command))
  expect(approvals.filter((a) => a.startsWith('tool:'))).toEqual([]) // ls 는 묻지 않음
  expect(approvals).toContain('git-commit:Bash') // 커밋은 게이트
  expect((await git(d, ['rev-list', '--all'])).stdout.trim()).toBe('') // 커밋 안 됨
  p.reset()
})
