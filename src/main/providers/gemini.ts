// Gemini: Google Gemini CLI (`gemini -p ... -o stream-json`). Google 계정 로그인 또는 API 키.
// auto_edit 모드: 파일 편집은 자동, 셸 명령은 헤드리스에서 승인 불가 → 실행되지 않음 (commit/push 불가).
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { geminiCredsPath } from '../auth'
import { geminiCommand, JsonLineParser, spawnCli } from '../cli'
import { extractFilePaths, FILE_MUTATING_TOOLS } from '../policy'
import { CLI_AGENT_RULES, type AgentProvider, type TurnContext } from './types'

type Obj = Record<string, unknown>

export function geminiArgs(opts: { prompt: string; model?: string; sessionId: string | null; readOnly: boolean }): string[] {
  const args = ['-p', opts.prompt, '-o', 'stream-json', '--skip-trust', '--approval-mode', opts.readOnly ? 'plan' : 'auto_edit']
  if (opts.model) args.push('-m', opts.model)
  if (opts.sessionId) args.push('--resume', opts.sessionId)
  return args
}

export function mapGeminiEvent(o: Obj, state: { text: string; tools: Map<string, string> }, ctx: Pick<TurnContext, 'emit'>): void {
  switch (o.type) {
    case 'init':
      ctx.emit({ kind: 'session', sessionId: String(o.session_id), model: o.model ? String(o.model) : undefined })
      break
    case 'message':
      if (o.role === 'assistant' && typeof o.content === 'string') {
        if (o.delta) {
          state.text += o.content
          ctx.emit({ kind: 'text-delta', text: o.content })
        } else {
          state.text = o.content
          ctx.emit({ kind: 'text', text: o.content })
        }
      }
      break
    case 'tool_use': {
      const name = String(o.tool_name)
      const id = String(o.tool_id)
      state.tools.set(id, name)
      // 도구 호출 전까지의 텍스트는 별도 블록으로 끊는다
      ctx.emit({ kind: 'text', text: '' })
      ctx.emit({ kind: 'tool-use', id, name, input: o.parameters })
      if (FILE_MUTATING_TOOLS.has(name)) {
        const paths = extractFilePaths(o.parameters)
        if (paths.length) ctx.emit({ kind: 'file-change', paths })
      }
      break
    }
    case 'tool_result': {
      const err = o.error as Obj | undefined
      ctx.emit({
        kind: 'tool-result',
        id: String(o.tool_id),
        output: String(o.output ?? err?.message ?? '').slice(0, 20000),
        isError: o.status === 'error'
      })
      break
    }
    case 'error':
      ctx.emit({ kind: o.severity === 'warning' ? 'status' : 'error', message: String(o.message ?? 'Gemini 오류') })
      break
    case 'result': {
      const err = o.error as Obj | undefined
      if (o.status === 'error' && err) ctx.emit({ kind: 'error', message: String(err.message ?? 'Gemini 실패') })
      break
    }
  }
}

export class GeminiProvider implements AgentProvider {
  readonly id = 'gemini' as const
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
    // 미로그인 상태로 실행하면 CLI 가 stdin 동의 프롬프트에서 멈추므로 미리 막는다
    if (!ctx.env.GEMINI_API_KEY && (!ctx.env.GOOGLE_GENAI_USE_GCA || !existsSync(geminiCredsPath()))) {
      ctx.emit({ kind: 'error', message: 'Gemini 에 로그인되어 있지 않습니다. 왼쪽 AI 연결에서 Gemini 로그인(Google) 또는 API 키를 등록하세요.' })
      ctx.emit({ kind: 'result', text: '', isError: true })
      return
    }
    // 첫 턴에만 규칙을 붙인다 (resume 시 히스토리에 남아 있음)
    const full = this.session ? prompt : `${CLI_AGENT_RULES}${ctx.memory ? `\n\n${ctx.memory}` : ''}\n\n${prompt}`
    const args = geminiArgs({ prompt: full, model: ctx.model, sessionId: this.session, readOnly: ctx.permissionMode === 'plan' })
    const started = Date.now()
    const state = { text: '', tools: new Map<string, string>() }
    let failed = false
    const emit: TurnContext['emit'] = (e) => {
      if (e.kind === 'session') this.session = e.sessionId
      if (e.kind === 'error') failed = true
      if (e.kind === 'file-change') for (const p of e.paths) ctx.audit({ action: 'file.modified', provider: 'gemini', project: ctx.cwd, target: p })
      ctx.emit(e)
    }
    await new Promise<void>((resolve) => {
      const child = spawnCli(geminiCommand(args), { cwd: ctx.cwd, extraEnv: ctx.env, stdio: ['pipe', 'pipe', 'pipe'] })
      this.child = child
      let stderr = ''
      const parser = new JsonLineParser((o) => mapGeminiEvent(o, state, { emit }))
      child.stdout?.on('data', (d) => parser.push(d))
      child.stderr?.on('data', (d) => (stderr += d))
      child.on('error', (e) => {
        failed = true
        ctx.emit({ kind: 'error', message: `Gemini 실행 실패: ${e.message}` })
      })
      child.on('close', (code) => {
        parser.flush()
        this.child = null
        if (code !== 0 && !failed) {
          failed = true
          ctx.emit({ kind: 'error', message: stderr.trim().split('\n').slice(-6).join('\n') || `gemini 종료 코드 ${code}` })
        }
        resolve()
      })
      child.stdin?.end()
    })
    ctx.emit({ kind: 'result', text: state.text, isError: failed, durationMs: Date.now() - started })
  }
}
