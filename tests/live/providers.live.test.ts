// 실제 모델 호출 스모크 테스트. 사용자의 실제 로그인(Claude Code / Codex) 을 사용한다.
// 임시 git 저장소에서만 동작하며, 커밋 승인/거부 게이트가 실제로 동작하는지 검증한다.
import { beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, ApprovalRequest } from '../../src/shared/types'
import { ClaudeProvider } from '../../src/main/providers/claude'
import { CodexProvider } from '../../src/main/providers/codex'
import { GeminiProvider } from '../../src/main/providers/gemini'
import type { TurnContext } from '../../src/main/providers/types'
import { git } from '../../src/main/git'
import { AuthService } from '../../src/main/auth'
import { SecretStore } from '../../src/main/secrets'
import type { AuditInput } from '../../src/main/audit'

async function repo(): Promise<string> {
  const d = mkdtempSync(join(tmpdir(), 'jarvis-live-'))
  await git(d, ['init', '-q', '-b', 'main'])
  await git(d, ['config', 'user.email', 'live@example.com'])
  await git(d, ['config', 'user.name', 'Live'])
  await git(d, ['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(d, 'README.md'), '# live\n')
  await git(d, ['add', '.'])
  await git(d, ['commit', '-qm', 'init'])
  return d
}

function harness(cwd: string, answer: (r: Omit<ApprovalRequest, 'id' | 'provider'>) => boolean) {
  const events: AgentEvent[] = []
  const approvals: Array<Omit<ApprovalRequest, 'id' | 'provider'>> = []
  const audits: AuditInput[] = []
  const ctx = (env: NodeJS.ProcessEnv = {}): TurnContext => ({
    turnId: 't',
    cwd,
    permissionMode: 'acceptEdits',
    env,
    emit: (e) => events.push(e),
    approve: async (r) => {
      approvals.push(r)
      return { approved: answer(r), reason: answer(r) ? undefined : '테스트에서 거부' }
    },
    audit: (a) => audits.push(a)
  })
  return { events, approvals, audits, ctx }
}

const commits = async (d: string): Promise<number> => (await git(d, ['rev-list', '--count', 'HEAD'])).stdout.trim() as unknown as number

describe('Claude (Agent SDK, 실제 로그인)', () => {
  let dir: string
  beforeAll(async () => {
    dir = await repo()
  })

  it('파일 생성 + commit 시도 → 승인 창 → 거부 시 커밋 안 됨', async () => {
    const allow = { commit: false }
    const h = harness(dir, (r) => (r.kind === 'git-commit' ? allow.commit : true))
    const p = new ClaudeProvider()
    await p.send(
      'hello.txt 파일을 만들고 내용은 정확히 "jarvis" 한 줄로 써라. 그 다음 Bash 로 `git add hello.txt && git commit -m "test: hello"` 를 실행해라. 거부되면 다시 시도하지 말고 끝내라.',
      h.ctx()
    )
    expect(readFileSync(join(dir, 'hello.txt'), 'utf8').trim()).toBe('jarvis')
    expect(h.events.some((e) => e.kind === 'file-change')).toBe(true)
    expect(h.audits.some((a) => a.action === 'file.modified')).toBe(true)
    expect(h.approvals.some((a) => a.kind === 'git-commit')).toBe(true)
    expect(String(await commits(dir))).toBe('1') // 커밋 안 됨
    expect(h.events.some((e) => e.kind === 'result' && !e.isError)).toBe(true)
    expect(p.sessionId()).toBeTruthy()

    // 같은 세션에서 이어서: 이번엔 승인
    allow.commit = true
    const h2 = harness(dir, (r) => (r.kind === 'git-commit' ? true : true))
    await p.send('방금 거부됐던 커밋을 이제 다시 실행해라. 사용자가 승인할 것이다.', h2.ctx())
    expect(h2.approvals.some((a) => a.kind === 'git-commit')).toBe(true)
    expect(String(await commits(dir))).toBe('2')
    const log = await git(dir, ['log', '-1', '--pretty=%s'])
    expect(log.stdout.trim()).toBe('test: hello')
    p.reset()
  })
})

describe('GPT (Codex CLI, 실제 ChatGPT 로그인)', () => {
  it('파일 생성 → file-change 이벤트, 세션 이어가기', async () => {
    const dir = await repo()
    const h = harness(dir, () => false)
    const p = new CodexProvider()
    await p.send('notes.md 파일을 만들고 내용은 "codex ok" 한 줄로 써라. 커밋은 하지 마라.', h.ctx())
    expect(existsSync(join(dir, 'notes.md'))).toBe(true)
    expect(readFileSync(join(dir, 'notes.md'), 'utf8')).toContain('codex ok')
    expect(h.events.some((e) => e.kind === 'file-change')).toBe(true)
    expect(h.events.some((e) => e.kind === 'result' && !e.isError)).toBe(true)
    const sid = p.sessionId()
    expect(sid).toBeTruthy()

    const h2 = harness(dir, () => false)
    await p.send('방금 만든 파일 이름만 답해라.', h2.ctx())
    expect(p.sessionId()).toBe(sid)
    const result = h2.events.find((e) => e.kind === 'result') as Extract<AgentEvent, { kind: 'result' }>
    expect(result.text).toContain('notes.md')
  })

  it('Codex 가 commit 을 시도해도 HEAD 변경이 감지·기록된다 (또는 샌드박스가 막는다)', async () => {
    const dir = await repo()
    writeFileSync(join(dir, 'x.txt'), 'x\n')
    const h = harness(dir, () => false)
    const p = new CodexProvider()
    await p.send('git add x.txt && git commit -m "codex commit" 를 실행해 봐라. 실패하면 실패 이유만 한 줄로 말해라.', h.ctx())
    const n = String(await commits(dir))
    if (n === '1') {
      console.log('[codex] 샌드박스가 커밋을 막음')
    } else {
      expect(h.audits.some((a) => a.action === 'git.commit' && (a.detail as { unapproved?: boolean })?.unapproved)).toBe(true)
      console.log('[codex] 커밋됨 → 미승인 커밋으로 이력 기록 확인')
    }
  })
})

describe('Gemini (로그인 상태 점검)', () => {
  it('미로그인이면 즉시 오류 이벤트로 끝난다 (멈추지 않음)', async () => {
    const secrets = new SecretStore(join(mkdtempSync(join(tmpdir(), 'jv-')), 's.json'), {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(s),
      decryptString: (b) => b.toString()
    })
    const auth = new AuthService(secrets, { geminiUseGoogleLogin: () => true })
    const st = await auth.status('gemini')
    const dir = await repo()
    const h = harness(dir, () => false)
    const p = new GeminiProvider()
    const t0 = Date.now()
    await p.send('Reply with exactly: pong', h.ctx(auth.envFor('gemini')))
    if (!st.loggedIn) {
      expect(h.events[0].kind).toBe('error')
      expect(Date.now() - t0).toBeLessThan(2000)
    } else {
      const r = h.events.find((e) => e.kind === 'result') as Extract<AgentEvent, { kind: 'result' }>
      expect(r.text.toLowerCase()).toContain('pong')
    }
  })

  it('Claude / Codex 로그인 상태 조회', async () => {
    const secrets = new SecretStore(join(mkdtempSync(join(tmpdir(), 'jv-')), 's.json'), {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(s),
      decryptString: (b) => b.toString()
    })
    const auth = new AuthService(secrets, { geminiUseGoogleLogin: () => true })
    const c = await auth.status('claude')
    const g = await auth.status('gpt')
    console.log('[auth]', JSON.stringify({ claude: { ...c, account: c.account ? '***' : undefined }, gpt: g }))
    expect(c.loggedIn).toBe(true)
    expect(c.method).toBe('login')
    expect(g.loggedIn).toBe(true)
  })
})
