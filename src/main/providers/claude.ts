// Claude: Claude Agent SDK (= Claude Code 엔진). 파일 읽기/수정, Bash, git, CLAUDE.md, 세션 유지까지 Claude Code 와 동일.
// git commit / push / 파괴적 명령은 PreToolUse 훅에서 강제로 사용자 승인을 받는다
// (훅은 사용자 settings 의 allow 규칙보다 먼저 실행되므로 우회 불가).
import { query, type Query, type SDKMessage, type SDKUserMessage, type HookCallback, type CanUseTool } from '@anthropic-ai/claude-agent-sdk'
import { claudeBinary } from '../cli'
import { classifyCommand, extractFilePaths, FILE_MUTATING_TOOLS } from '../policy'
import type { AgentProvider, TurnContext } from './types'

const JARVIS_APPEND = [
  '당신은 J.A.R.V.I.S. — 사용자의 데스크톱 AI 비서다. 한국어로, 정중하고 간결하게("~입니다", "알겠습니다") 답한다.',
  '음성 인터페이스로도 쓰이므로 최종 답변의 첫 문장은 귀로 들어도 이해되는 짧은 요약으로 시작한다.',
  'git commit / git push 는 JARVIS 가 사용자에게 확인을 받은 뒤에만 실행된다. 거부되면 다시 시도하지 말고 사용자 지시를 기다린다.',
  '앱/웹사이트/폴더 열기·닫기, 스크린샷, 클립보드, 알림, 프로젝트 전환은 mcp__jarvis__* 도구를 사용한다.'
].join('\n')

class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = []
  private waiters: Array<(r: IteratorResult<T>) => void> = []
  private closed = false
  push(v: T): void {
    const w = this.waiters.shift()
    if (w) w({ value: v, done: false })
    else this.items.push(v)
  }
  close(): void {
    this.closed = true
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true })
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false })
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((r) => this.waiters.push(r))
      }
    }
  }
}

interface Live {
  q: Query
  input: AsyncQueue<SDKUserMessage>
  key: string
  /** 이 프로세스가 알고 있는 기억 (시작 때 시스템 프롬프트 + 이후 전달한 갱신) */
  memory: string
}

/** 기억이 바뀌었으면 프로세스를 다시 띄우지 않고 다음 메시지 앞에 붙여 알려 준다 */
export function withMemoryUpdate(prompt: string, known: string, current: string): string {
  if (!current || current === known) return prompt
  return `[JARVIS 기억 갱신 — 이전 기억 대신 이것을 따른다]\n${current}\n\n[사용자 요청]\n${prompt}`
}

export class ClaudeProvider implements AgentProvider {
  readonly id = 'claude' as const
  private live: Live | null = null
  private session: string | null = null
  private ctx: TurnContext | null = null
  private turnDone: (() => void) | null = null
  private streamedText = false
  private background = 0

  sessionId(): string | null {
    return this.session
  }

  reset(): void {
    this.close()
    this.session = null
  }

  async interrupt(): Promise<void> {
    await this.live?.q.interrupt().catch(() => undefined)
  }

  private close(): void {
    if (!this.live) return
    const live = this.live
    this.live = null
    if (this.background) {
      this.background = 0
      this.ctx?.emit({ kind: 'background', count: 0, tasks: [] })
    }
    live.input.close()
    live.q.close?.()
    // 진행 중이던 턴이 있으면 여기서 끝낸다 (닫힌 프로세스의 종료 신호가 다음 턴을 끝내 버리지 않게)
    this.finishTurn()
  }

  private gateHook: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {}
    const ctx = this.ctx
    if (!ctx) return {}
    const ti = input.tool_input as { command?: string }
    if (input.tool_name !== 'Bash' && input.tool_name !== 'PowerShell') return {}
    const command = String(ti?.command ?? '')
    const verdict = classifyCommand(command)
    if (!verdict.gate) return {}
    const titles = { 'git-commit': 'Git 커밋 승인', 'git-push': 'Git 푸시 승인', destructive: '위험 명령 승인' } as const
    const res = await ctx.approve({
      kind: verdict.gate,
      title: titles[verdict.gate],
      detail: `${verdict.reason}\n\n$ ${command}`,
      toolName: input.tool_name,
      input: ti
    })
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: res.approved ? 'allow' : 'deny',
        permissionDecisionReason: res.approved
          ? '사용자가 JARVIS 에서 승인했습니다.'
          : `사용자가 거부했습니다${res.reason ? `: ${res.reason}` : ''}. 다시 시도하지 마세요.`
      }
    }
  }

  private fileHook: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PostToolUse') return {}
    if (!FILE_MUTATING_TOOLS.has(input.tool_name)) return {}
    const paths = extractFilePaths(input.tool_input)
    if (paths.length && this.ctx) {
      this.ctx.emit({ kind: 'file-change', paths })
      for (const p of paths) this.ctx.audit({ action: 'file.modified', provider: 'claude', project: this.ctx.cwd, target: p, detail: { tool: input.tool_name } })
    }
    return {}
  }

  private canUseTool: CanUseTool = async (toolName, input, opts) => {
    const ctx = this.ctx
    if (!ctx) return { behavior: 'deny', message: 'JARVIS 세션이 없습니다.' }
    const res = await ctx.approve({
      kind: 'tool',
      title: opts.title ?? `${opts.displayName ?? toolName} 실행 허용?`,
      detail: [opts.description, opts.decisionReason, JSON.stringify(input, null, 2).slice(0, 4000)].filter(Boolean).join('\n\n'),
      toolName,
      input
    })
    return res.approved
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: `사용자가 거부했습니다${res.reason ? `: ${res.reason}` : ''}` }
  }

  private ensure(ctx: TurnContext): Live {
    // 기억은 키에 넣지 않는다 — 바뀔 때마다 프로세스를 다시 띄우면 느리고(1~2초), 바뀐 기억은 다음 메시지에 붙여 알려 준다
    const key = JSON.stringify([ctx.cwd, ctx.model, ctx.permissionMode, ctx.env.ANTHROPIC_API_KEY ? 'key' : 'login'])
    if (this.live && this.live.key === key) return this.live
    this.close()
    const input = new AsyncQueue<SDKUserMessage>()
    const q = query({
      prompt: input,
      options: {
        cwd: ctx.cwd,
        model: ctx.model,
        permissionMode: ctx.permissionMode,
        resume: this.session ?? undefined,
        includePartialMessages: true,
        settingSources: ['user', 'project', 'local'],
        systemPrompt: { type: 'preset', preset: 'claude_code', append: ctx.memory ? `${JARVIS_APPEND}\n\n${ctx.memory}` : JARVIS_APPEND },
        pathToClaudeCodeExecutable: claudeBinary(),
        env: { ...process.env, ...ctx.env },
        canUseTool: this.canUseTool,
        mcpServers: ctx.mcpServers,
        allowedTools: ctx.allowedTools,
        hooks: {
          PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [this.gateHook], timeout: 3600 }],
          PostToolUse: [{ hooks: [this.fileHook] }]
        },
        stderr: (d) => {
          if (/error/i.test(d)) this.ctx?.emit({ kind: 'status', message: d.trim().slice(0, 300) })
        }
      }
    })
    const live: Live = { q, input, key, memory: ctx.memory ?? '' }
    this.live = live
    void this.pump(live)
    return live
  }

  private async pump(live: Live): Promise<void> {
    try {
      for await (const m of live.q) this.handle(m)
    } catch (e) {
      this.ctx?.emit({ kind: 'error', message: (e as Error).message })
    } finally {
      // 지금 쓰는 프로세스가 예기치 않게 끝난 경우에만 턴을 끝낸다. 일부러 닫은(교체된) 프로세스의 종료는 무시
      if (this.live === live) {
        this.live = null
        this.finishTurn()
      }
    }
  }

  private finishTurn(): void {
    const done = this.turnDone
    this.turnDone = null
    done?.()
  }

  /** 미리 프로세스를 띄워 둔다 (메시지는 보내지 않음) */
  warm(ctx: TurnContext): void {
    try {
      this.ensure(ctx)
    } catch {
      /* 첫 요청 때 다시 시도 */
    }
  }

  private handle(m: SDKMessage): void {
    // 세션 id 는 미리 띄워 둔 상태(턴 없음)에서도 기억해 둔다
    if (m.type === 'system' && m.subtype === 'init') this.session = m.session_id
    const ctx = this.ctx
    if (!ctx) return
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') {
          this.session = m.session_id
          ctx.emit({ kind: 'session', sessionId: m.session_id, model: m.model })
        } else if ((m.subtype as string) === 'background_tasks_changed') {
          // 뒤에서 도는 작업 목록 (바뀔 때마다 전체가 온다) — 활동이 아닌 감시용(ambient)은 뺀다
          const tasks = ((m as unknown as { tasks?: Array<{ description: string; ambient?: boolean }> }).tasks ?? []).filter((x) => !x.ambient)
          this.background = tasks.length
          ctx.emit({ kind: 'background', count: tasks.length, tasks: tasks.map((x) => x.description) })
        }
        break
      case 'stream_event': {
        if (m.parent_tool_use_id) break
        const ev = m.event
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          this.streamedText = true
          ctx.emit({ kind: 'text-delta', text: ev.delta.text })
        }
        break
      }
      case 'assistant': {
        if (m.parent_tool_use_id) break
        for (const b of m.message.content) {
          if (b.type === 'text' && !this.streamedText) ctx.emit({ kind: 'text', text: b.text })
          else if (b.type === 'thinking' && b.thinking) ctx.emit({ kind: 'thinking', text: b.thinking })
          else if (b.type === 'tool_use') ctx.emit({ kind: 'tool-use', id: b.id, name: b.name, input: b.input })
        }
        if (m.message.content.some((b) => b.type === 'text')) {
          ctx.emit({ kind: 'text', text: '' }) // 텍스트 블록 경계
        }
        this.streamedText = false
        break
      }
      case 'user': {
        if (m.parent_tool_use_id) break
        const content = m.message.content
        if (Array.isArray(content)) {
          for (const b of content) {
            if (b.type === 'tool_result') {
              const out = typeof b.content === 'string' ? b.content : (b.content ?? []).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n')
              ctx.emit({ kind: 'tool-result', id: b.tool_use_id, output: out.slice(0, 20000), isError: !!b.is_error })
            }
          }
        }
        break
      }
      case 'result': {
        const isError = m.subtype !== 'success'
        const text = m.subtype === 'success' ? m.result : (m.errors ?? []).join('\n') || m.subtype
        // 사용자가 보낸 차례가 아닌데 결과가 왔다 = 뒤에서 하던 작업을 마치고 AI 가 낸 완료 보고
        if (!this.turnDone) {
          if (text?.trim() && !isError) ctx.emit({ kind: 'followup', text })
          break
        }
        ctx.emit({ kind: 'result', text, isError, costUsd: m.total_cost_usd, durationMs: m.duration_ms })
        this.finishTurn()
        break
      }
      default:
        break
    }
  }

  send(prompt: string, ctx: TurnContext): Promise<void> {
    this.ctx = ctx
    const live = this.ensure(ctx)
    const content = withMemoryUpdate(prompt, live.memory, ctx.memory ?? '')
    live.memory = ctx.memory ?? ''
    return new Promise<void>((resolve) => {
      this.turnDone = resolve
      live.input.push({
        type: 'user',
        message: { role: 'user', content },
        parent_tool_use_id: null
      } as SDKUserMessage)
    })
  }
}
