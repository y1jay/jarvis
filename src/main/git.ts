// JARVIS 자체 Git 패널. commit / push 는 approver 가 승인해야만 실행된다.
import { execFile } from 'node:child_process'
import type { GitCommitInfo, GitStatus } from '../shared/types'

export interface GitResult {
  code: number
  stdout: string
  stderr: string
}

function gitOnce(cwd: string, args: string[], input?: string): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      args,
      // GIT_OPTIONAL_LOCKS=0: status 등 조회가 index.lock 을 잡지 않게 (동시 커밋과 충돌 방지)
      { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' } },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : 1) : 0
        resolve({ code, stdout: String(stdout), stderr: String(stderr) })
      }
    )
    if (input !== undefined) child.stdin?.end(input)
  })
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 다른 프로세스(에디터, 에이전트)가 잠깐 index.lock 을 잡고 있으면 짧게 재시도 */
export async function git(cwd: string, args: string[], input?: string): Promise<GitResult> {
  for (let i = 0; ; i++) {
    const r = await gitOnce(cwd, args, input)
    if (r.code === 0 || i >= 6 || !/index\.lock': File exists/.test(r.stderr)) return r
    await sleep(150 * (i + 1))
  }
}

// 저장소별 쓰기 작업 직렬화
const queues = new Map<string, Promise<unknown>>()
function serial<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(cwd) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  queues.set(cwd, next.catch(() => undefined))
  return next
}

export async function gitHead(cwd: string): Promise<string | null> {
  const r = await git(cwd, ['rev-parse', 'HEAD'])
  return r.code === 0 ? r.stdout.trim() : null
}

export function parseStatusV2(out: string): Omit<GitStatus, 'isRepo'> {
  const st: Omit<GitStatus, 'isRepo'> = { branch: null, upstream: null, ahead: 0, behind: 0, files: [] }
  for (const line of out.split('\0')) {
    if (!line) continue
    if (line.startsWith('# branch.head ')) st.branch = line.slice(14)
    else if (line.startsWith('# branch.upstream ')) st.upstream = line.slice(18)
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line)
      if (m) {
        st.ahead = Number(m[1])
        st.behind = Number(m[2])
      }
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const parts = line.split(' ')
      const xy = parts[1]
      const path = line.startsWith('1 ') ? parts.slice(8).join(' ') : parts.slice(9).join(' ')
      st.files.push({ path, index: xy[0], worktree: xy[1] })
    } else if (line.startsWith('? ')) {
      st.files.push({ path: line.slice(2), index: '?', worktree: '?' })
    } else if (line.startsWith('u ')) {
      const parts = line.split(' ')
      st.files.push({ path: parts.slice(10).join(' '), index: 'U', worktree: 'U' })
    }
  }
  // 'rename(2)' 레코드 뒤의 원본 경로 토큰은 별도 NUL 필드 → 위 루프에서 경로 형식이 아니므로 무시됨
  return st
}

export type Approver = (req: { kind: 'git-commit' | 'git-push'; title: string; detail: string }) => Promise<boolean>

export class GitService {
  constructor(private readonly approver: Approver) {}

  async status(cwd: string): Promise<GitStatus> {
    const r = await git(cwd, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'])
    if (r.code !== 0) return { isRepo: false, branch: null, upstream: null, ahead: 0, behind: 0, files: [] }
    return { isRepo: true, ...parseStatusV2(r.stdout) }
  }

  async diff(cwd: string, opts: { path?: string; staged?: boolean } = {}): Promise<string> {
    const args = ['diff', '--no-color']
    if (opts.staged) args.push('--cached')
    if (opts.path) args.push('--', opts.path)
    const r = await git(cwd, args)
    if (opts.path && !r.stdout) {
      // untracked 파일
      const u = await git(cwd, ['diff', '--no-color', '--no-index', '--', process.platform === 'win32' ? 'NUL' : '/dev/null', opts.path])
      return u.stdout
    }
    return r.stdout
  }

  async log(cwd: string, n = 20): Promise<GitCommitInfo[]> {
    const r = await git(cwd, ['log', `-n${n}`, '--pretty=format:%H%x1f%an%x1f%aI%x1f%s'])
    if (r.code !== 0) return []
    return r.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [hash, author, date, subject] = l.split('\x1f')
        return { hash, author, date, subject }
      })
  }

  async stage(cwd: string, paths: string[]): Promise<GitResult> {
    return serial(cwd, () => git(cwd, ['add', '--', ...paths]))
  }

  async unstage(cwd: string, paths: string[]): Promise<GitResult> {
    return serial(cwd, () => git(cwd, ['restore', '--staged', '--', ...paths]))
  }

  async commit(cwd: string, message: string): Promise<GitResult & { approved: boolean; hash?: string }> {
    if (!message.trim()) return { approved: false, code: 1, stdout: '', stderr: '커밋 메시지가 비어 있습니다.' }
    const staged = await git(cwd, ['diff', '--cached', '--stat'])
    if (!staged.stdout.trim()) return { approved: false, code: 1, stdout: '', stderr: '스테이징된 변경이 없습니다.' }
    const ok = await this.approver({ kind: 'git-commit', title: 'Git 커밋 승인', detail: `메시지:\n${message}\n\n변경:\n${staged.stdout}` })
    if (!ok) return { approved: false, code: 1, stdout: '', stderr: '사용자가 커밋을 거부했습니다.' }
    const r = await serial(cwd, () => git(cwd, ['commit', '-F', '-'], message))
    return { ...r, approved: true, hash: r.code === 0 ? ((await gitHead(cwd)) ?? undefined) : undefined }
  }

  async push(cwd: string): Promise<GitResult & { approved: boolean }> {
    const st = await this.status(cwd)
    const target = st.upstream ?? `origin/${st.branch}`
    const ok = await this.approver({ kind: 'git-push', title: 'Git 푸시 승인', detail: `브랜치 ${st.branch} → ${target}\n앞선 커밋 ${st.ahead}개` })
    if (!ok) return { approved: false, code: 1, stdout: '', stderr: '사용자가 푸시를 거부했습니다.' }
    const args = st.upstream ? ['push'] : ['push', '-u', 'origin', String(st.branch)]
    return { ...(await serial(cwd, () => git(cwd, args))), approved: true }
  }
}
