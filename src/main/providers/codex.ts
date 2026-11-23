// GPT: OpenAI Codex CLI (`codex exec --json`). ChatGPT 계정 로그인 또는 API 키.
// workspace-write 샌드박스 + 네트워크 차단 → push 불가. 커밋은 실행 전후 HEAD 비교로 감시.
import type { ChildProcess } from 'node:child_process'
import { codexCommand, JsonLineParser, spawnCli } from '../cli'
import { classifyCommand } from '../policy'
import { CLI_AGENT_RULES, type AgentProvider, type TurnContext } from './types'
import { gitHead } from '../git'

type Obj = Record<string, unknown>

export function codexArgs(opts: { cwd: string; model?: string; sessionId: string | null; readOnly: boolean }): string[] {
  const common = ['--json', '--skip-git-repo-check']
  if (opts.model) common.push('-m', opts.model)
  const sandbox = ['-s', opts.readOnly ? 'read-only' : 'workspace-write', '-c', 'sandbox_workspace_write.network_access=false']
  if (opts.sessionId) {
    // resume 은 -C / -s 를 받지 않으므로 cwd 는 spawn cwd 로, 샌드박스는 config 로 지정
    return ['exec', 'resume', ...common, '-c', `sandbox_mode="${opts.readOnly ? 'read-only' : 'workspace-write'}"`, '-c', 'sandbox_workspace_write.network_access=false', opts.sessionId, '-']
  }
  return ['exec', ...common, ...sandbox, '-C', opts.cwd, '-']
}

/** codex JSON 이벤트 → AgentEvent. 상태(마지막 메시지)는 state 에 누적 */
export function mapCodexEvent(o: Obj, state: { last: string }, ctx: Pick<TurnContext, 'emit'>): void {
  const type = o.type as string
  if (type === 'thread.started') {
    ctx.emit({ kind: 'session', sessionId: String(o.thread_id) })
    return
  }
  if (type === 'turn.failed') {
    const err = (o.error as Obj | undefined)?.message
    ctx.emit({ kind: 'error', message: String(err ?? 'Codex 턴 실패') })
    return
  }
  if (type === 'error') {
    ctx.emit({ kind: 'error', message: String(o.message ?? 'Codex 오류') })
    return
  }
  const item = o.item as Obj | undefined
  if (!item) return
  const it = item.type as string
  const id = String(item.id ?? '')
  if (type === 'item.started') {
    if (it === 'command_execution') ctx.emit({ kind: 'tool-use', id, name: 'shell', input: { command: item.command } })
    else if (it === 'mcp_tool_call') ctx.emit({ kind: 'tool-use', id, name: `${item.server}.${item.tool}`, input: item.arguments })
    else if (it === 'web_search') ctx.emit({ kind: 'tool-use', id, name: 'web_search', input: { query: item.query } })
    return
  }
  if (type !== 'item.completed') return
  switch (it) {
    case 'agent_message':
      state.last = String(item.text ?? '')
      ctx.emit({ kind: 'text', text: state.last })
      break
    case 'reasoning':
      if (item.text) ctx.emit({ kind: 'thinking', text: String(item.text) })
      break
    case 'command_execution':
      ctx.emit({
        kind: 'tool-result',
        id,
        output: String(item.aggregated_output ?? '').slice(0, 20000),
        isError: typeof item.exit_code === 'number' ? item.exit_code !== 0 : item.status === 'failed'
      })
      break
    case 'file_change': {
      const changes = (item.changes as Obj[] | undefined) ?? []
      const paths = changes.map((c) => String(c.path))
      ctx.emit({ kind: 'tool-use', id, name: 'apply_patch', input: { changes } })
      ctx.emit({ kind: 'tool-result', id, output: changes.map((c) => `${c.kind} ${c.path}`).join('\n'), isError: item.status === 'failed' })
      if (paths.length) ctx.emit({ kind: 'file-change', paths })
      break
    }
    case 'mcp_tool_call':
    case 'web_search':
      ctx.emit({ kind: 'tool-result', id, output: JSON.stringify(item.result ?? item.status ?? '').slice(0, 20000), isError: item.status === 'failed' })
      break
    case 'error':
      ctx.emit({ kind: 'status', message: String(item.message ?? '') })
      break
  }
}

export class CodexProvider implements AgentProvider {
  readonly id = 'gpt' as const
  private session: string | null = null
  private child: ChildProcess | null = null

  sessionId(): string | null {
    return this.session
  }
  reset(): void {
    this.session = null
  }
  async interrupt(): Promise<void> {
    this.child?.kill('SIGINT')
  }

  async send(prompt: string, ctx: TurnContext): Promise<void> {
    const headBefore = await gitHead(ctx.cwd)
    const args = codexArgs({ cwd: ctx.cwd, model: ctx.model, sessionId: this.session, readOnly: ctx.permissionMode === 'plan' })
    const started = Date.now()
    const state = { last: '' }
    let failed = false
    const emit: TurnContext['emit'] = (e) => {
      if (e.kind === 'session') this.session = e.sessionId
      if (e.kind === 'error') failed = true
      if (e.kind === 'tool-use' && e.name === 'shell') {
        const cmd = String((e.input as Obj)?.command ?? '')
        const v = classifyCommand(cmd)
        if (v.gate) ctx.emit({ kind: 'status', message: `⚠️ ${v.reason} — Codex 가 시도한 명령: ${cmd}` })
      }
      if (e.kind === 'file-change') for (const p of e.paths) ctx.audit({ action: 'file.modified', provider: 'gpt', project: ctx.cwd, target: p })
      ctx.emit(e)
    }

    await new Promise<void>((resolve) => {
      const child = spawnCli(codexCommand(args), { cwd: ctx.cwd, extraEnv: ctx.env, stdio: ['pipe', 'pipe', 'pipe'] })
      this.child = child
      let stderr = ''
      const parser = new JsonLineParser((o) => mapCodexEvent(o, state, { emit }))
      child.stdout?.on('data', (d) => parser.push(d))
      child.stderr?.on('data', (d) => (stderr += d))
      child.on('error', (e) => {
        failed = true
        ctx.emit({ kind: 'error', message: `Codex 실행 실패: ${e.message}` })
      })
      child.on('close', (code) => {
        parser.flush()
        this.child = null
        if (code !== 0 && !failed) {
          failed = true
          ctx.emit({ kind: 'error', message: stderr.trim().split('\n').slice(-5).join('\n') || `codex 종료 코드 ${code}` })
        }
        resolve()
      })
      child.stdin?.end(`${CLI_AGENT_RULES}${ctx.memory ? `\n\n${ctx.memory}` : ''}\n\n${prompt}`)
    })

    const headAfter = await gitHead(ctx.cwd)
    if (headBefore && headAfter && headBefore !== headAfter) {
      ctx.audit({ action: 'git.commit', provider: 'gpt', project: ctx.cwd, target: headAfter, detail: { unapproved: true, before: headBefore } })
      ctx.emit({ kind: 'status', message: `⚠️ Codex 가 승인 없이 HEAD 를 변경했습니다 (${headBefore.slice(0, 7)} → ${headAfter.slice(0, 7)}). 이력에 기록했습니다.` })
    }
    ctx.emit({ kind: 'result', text: state.last, isError: failed, durationMs: Date.now() - started })
  }
}
