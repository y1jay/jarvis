import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../../src/shared/types'
import { codexArgs, mapCodexEvent } from '../../src/main/providers/codex'
import { geminiArgs, mapGeminiEvent } from '../../src/main/providers/gemini'
import { codexCommand, geminiCommand, claudeBinary, JsonLineParser } from '../../src/main/cli'
import { existsSync } from 'node:fs'

describe('Codex 이벤트 매핑 (실제 codex exec --json 출력 형식)', () => {
  it('thread → session, agent_message → text, command → tool, file_change → file-change', () => {
    const ev: AgentEvent[] = []
    const state = { last: '' }
    const lines = [
      { type: 'thread.started', thread_id: 't-1' },
      { type: 'turn.started' },
      { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'ls', status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'ls', aggregated_output: 'a.txt\n', exit_code: 0, status: 'completed' } },
      { type: 'item.completed', item: { id: 'i2', type: 'file_change', changes: [{ path: '/p/a.txt', kind: 'update' }], status: 'completed' } },
      { type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: '완료했습니다.' } },
      { type: 'turn.completed', usage: {} }
    ]
    for (const l of lines) mapCodexEvent(l, state, { emit: (e) => ev.push(e) })
    expect(ev[0]).toEqual({ kind: 'session', sessionId: 't-1' })
    expect(ev).toContainEqual({ kind: 'tool-use', id: 'i1', name: 'shell', input: { command: 'ls' } })
    expect(ev).toContainEqual({ kind: 'tool-result', id: 'i1', output: 'a.txt\n', isError: false })
    expect(ev).toContainEqual({ kind: 'file-change', paths: ['/p/a.txt'] })
    expect(ev).toContainEqual({ kind: 'text', text: '완료했습니다.' })
    expect(state.last).toBe('완료했습니다.')
  })

  it('turn.failed → error', () => {
    const ev: AgentEvent[] = []
    mapCodexEvent({ type: 'turn.failed', error: { message: 'quota' } }, { last: '' }, { emit: (e) => ev.push(e) })
    expect(ev).toEqual([{ kind: 'error', message: 'quota' }])
  })

  it('args: 새 세션은 -C, resume 은 세션 id, 프롬프트는 stdin(-)', () => {
    const a = codexArgs({ cwd: '/p', sessionId: null, readOnly: false })
    expect(a.slice(0, 1)).toEqual(['exec'])
    expect(a).toContain('workspace-write')
    expect(a.slice(-3)).toEqual(['-C', '/p', '-'])
    const r = codexArgs({ cwd: '/p', sessionId: 'abc', readOnly: true, model: 'gpt-x' })
    expect(r.slice(0, 2)).toEqual(['exec', 'resume'])
    expect(r.slice(-2)).toEqual(['abc', '-'])
    expect(r).toContain('sandbox_mode="read-only"')
    expect(r).toContain('gpt-x')
  })
})

describe('Gemini 이벤트 매핑 (stream-json)', () => {
  it('init / delta / tool / result', () => {
    const ev: AgentEvent[] = []
    const state = { text: '', tools: new Map<string, string>() }
    const lines = [
      { type: 'init', session_id: 's-1', model: 'gemini-x' },
      { type: 'message', role: 'user', content: 'hi' },
      { type: 'message', role: 'assistant', content: '안녕', delta: true },
      { type: 'message', role: 'assistant', content: '하세요', delta: true },
      { type: 'tool_use', tool_name: 'write_file', tool_id: 'w1', parameters: { file_path: '/p/b.md', content: 'x' } },
      { type: 'tool_result', tool_id: 'w1', status: 'success', output: 'ok' },
      { type: 'result', status: 'success', stats: {} }
    ]
    for (const l of lines) mapGeminiEvent(l, state, { emit: (e) => ev.push(e) })
    expect(ev[0]).toEqual({ kind: 'session', sessionId: 's-1', model: 'gemini-x' })
    expect(ev.filter((e) => e.kind === 'text-delta').map((e) => (e as { text: string }).text).join('')).toBe('안녕하세요')
    expect(state.text).toBe('안녕하세요')
    expect(ev).toContainEqual({ kind: 'file-change', paths: ['/p/b.md'] })
    expect(ev).toContainEqual({ kind: 'tool-result', id: 'w1', output: 'ok', isError: false })
    expect(ev.some((e) => e.kind === 'message' as never)).toBe(false)
  })

  it('result error → error 이벤트', () => {
    const ev: AgentEvent[] = []
    mapGeminiEvent({ type: 'result', status: 'error', error: { message: 'auth' } }, { text: '', tools: new Map() }, { emit: (e) => ev.push(e) })
    expect(ev).toEqual([{ kind: 'error', message: 'auth' }])
  })

  it('args', () => {
    const a = geminiArgs({ prompt: 'p', sessionId: 's', readOnly: false })
    expect(a).toEqual(['-p', 'p', '-o', 'stream-json', '--skip-trust', '--approval-mode', 'auto_edit', '--resume', 's'])
    expect(geminiArgs({ prompt: 'p', sessionId: null, readOnly: true })).toContain('plan')
  })
})

describe('번들 CLI 경로 해석', () => {
  it('codex / gemini 는 JS 엔트리를 Node(Electron) 로 실행', () => {
    const c = codexCommand(['--version'])
    expect(c.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(existsSync(c.args[0])).toBe(true)
    const g = geminiCommand(['--version'])
    expect(existsSync(g.args[0])).toBe(true)
  })
  it('claude 네이티브 바이너리 존재', () => {
    expect(existsSync(claudeBinary())).toBe(true)
  })
})

describe('JsonLineParser', () => {
  it('청크가 줄 중간에서 잘려도 올바르게 파싱, 비 JSON 줄은 텍스트로', () => {
    const objs: unknown[] = []
    const texts: string[] = []
    const p = new JsonLineParser((o) => objs.push(o), (t) => texts.push(t))
    p.push('{"a":1}\n{"b"')
    p.push(':2}\nwarning: x\n{"c":3}')
    p.flush()
    expect(objs).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }])
    expect(texts).toEqual(['warning: x'])
  })
})
