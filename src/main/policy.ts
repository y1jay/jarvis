// 셸 명령 위험도 분류. git commit / push 와 복구 불가능한 명령은 반드시 사용자 승인을 받는다.
import type { ApprovalKind } from '../shared/types'

export interface CommandVerdict {
  /** null 이면 승인 불필요 */
  gate: Exclude<ApprovalKind, 'tool'> | null
  reason?: string
}

// 셸 연결자(; && || | 줄바꿈, 서브셸)로 명령을 쪼갠다. 따옴표 안은 보존.
export function splitShellCommands(command: string): string[] {
  const parts: string[] = []
  let buf = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (quote) {
      buf += c
      if (c === quote && command[i - 1] !== '\\') quote = null
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      buf += c
      continue
    }
    const two = command.slice(i, i + 2)
    if (two === '&&' || two === '||') {
      parts.push(buf)
      buf = ''
      i++
      continue
    }
    if (c === ';' || c === '|' || c === '\n' || c === '(' || c === ')' || c === '`' || c === '&') {
      parts.push(buf)
      buf = ''
      continue
    }
    if (two === '$(') {
      parts.push(buf)
      buf = ''
      i++
      continue
    }
    buf += c
  }
  parts.push(buf)
  return parts.map((p) => p.trim()).filter(Boolean)
}

function tokenize(segment: string): string[] {
  const tokens: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(segment))) tokens.push(m[1] ?? m[2] ?? m[3])
  return tokens
}

// git 의 전역 옵션(-C dir, -c k=v, --git-dir=...)을 건너뛰고 서브커맨드를 찾는다
export function gitSubcommand(tokens: string[]): { sub: string; args: string[] } | null {
  let i = 0
  // env 할당, sudo, command, exec 등 접두어 스킵
  while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) || ['sudo', 'command', 'exec', 'env', 'nohup', 'time'].includes(tokens[i]))) i++
  const bin = tokens[i]
  if (!bin || !/(^|[\\/])git(\.exe)?$/i.test(bin)) return null
  i++
  while (i < tokens.length) {
    const t = tokens[i]
    if (t === '-C' || t === '-c' || t === '--git-dir' || t === '--work-tree' || t === '--namespace') {
      i += 2
      continue
    }
    if (t.startsWith('-')) {
      i++
      continue
    }
    return { sub: t, args: tokens.slice(i + 1) }
  }
  return null
}

const DESTRUCTIVE_PATTERNS: Array<[RegExp, string]> = [
  [/^rm\s+(-[a-zA-Z]*[rR][a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*[rR]|--recursive\s+--force|--force\s+--recursive)\b/, 'rm -rf (재귀 강제 삭제)'],
  [/^(rmdir|rd)\s+\/s\b/i, 'Windows 재귀 삭제'],
  [/^del\s+.*\/[sq]\b/i, 'Windows 강제 삭제'],
  [/^Remove-Item\b.*-Recurse/i, 'PowerShell 재귀 삭제'],
  [/^find\b.*\s-delete\b/, 'find -delete'],
  [/^(mkfs|dd)\b/, '디스크 포맷/덮어쓰기'],
  [/^docker\s+(system\s+prune|volume\s+(rm|prune)|compose\s+down\b.*\s-v\b|image\s+prune)/, 'Docker 볼륨/이미지 삭제'],
  [/^docker-compose\s+down\b.*\s-v\b/, 'Docker 볼륨 삭제'],
  [/^(kill|pkill|killall)\s+.*-9\b/, '강제 종료 (-9)'],
  [/\b(DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b/i, '데이터 파괴 SQL'],
  [/^(prisma|npx\s+prisma|pnpm\s+prisma)\s+(migrate\s+(reset|deploy)|db\s+push)/, 'DB 마이그레이션/리셋'],
  [/^chmod\s+-R\s+777\b/, '권한 전체 개방'],
  [/^expo\s+prebuild\b.*--clean/, '네이티브 프로젝트 재생성']
]

export function classifyCommand(command: string): CommandVerdict {
  const segments = splitShellCommands(command)
  let destructive: CommandVerdict | null = null

  for (const seg of segments) {
    const tokens = tokenize(seg)
    const git = gitSubcommand(tokens)
    if (git) {
      if (git.sub === 'push') return { gate: 'git-push', reason: 'git push 는 사용자 확인이 필요합니다' }
      if (git.sub === 'commit') return { gate: 'git-commit', reason: 'git commit 은 사용자 확인이 필요합니다' }
      const a = git.args
      if (git.sub === 'reset' && a.includes('--hard')) destructive ??= { gate: 'destructive', reason: 'git reset --hard' }
      if (git.sub === 'clean' && a.some((x) => /^-[a-zA-Z]*f/.test(x))) destructive ??= { gate: 'destructive', reason: 'git clean -f' }
      if ((git.sub === 'checkout' || git.sub === 'restore') && (a.includes('.') || a.includes('--')) && !a.includes('-b'))
        destructive ??= { gate: 'destructive', reason: `git ${git.sub} 로 작업 내용 폐기` }
      if (git.sub === 'branch' && a.includes('-D')) destructive ??= { gate: 'destructive', reason: 'git branch -D' }
      if (git.sub === 'stash' && (a[0] === 'drop' || a[0] === 'clear')) destructive ??= { gate: 'destructive', reason: `git stash ${a[0]}` }
      if (git.sub === 'rebase' || git.sub === 'filter-branch') destructive ??= { gate: 'destructive', reason: `git ${git.sub} (히스토리 재작성)` }
      continue
    }
    for (const [re, reason] of DESTRUCTIVE_PATTERNS) {
      if (re.test(seg)) {
        destructive ??= { gate: 'destructive', reason }
        break
      }
    }
  }
  return destructive ?? { gate: null }
}

/** 파일을 바꾸는 도구 이름 (Claude / Gemini) */
export const FILE_MUTATING_TOOLS = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'replace',
  'write_file',
  'edit'
])

export function extractFilePaths(input: unknown): string[] {
  if (!input || typeof input !== 'object') return []
  const o = input as Record<string, unknown>
  const out: string[] = []
  for (const k of ['file_path', 'path', 'notebook_path', 'absolute_path']) {
    if (typeof o[k] === 'string') out.push(o[k] as string)
  }
  return out
}
