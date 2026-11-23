import type { AgentEvent, ProviderId } from '../../../shared/types'

export type Block =
  | { type: 'text'; text: string; open: boolean }
  | { type: 'thinking'; text: string }
  | { type: 'tool'; id: string; name: string; input: unknown; output?: string; isError?: boolean }
  | { type: 'files'; paths: string[] }
  | { type: 'status'; text: string }
  | { type: 'error'; text: string }

export interface Turn {
  id: string
  role: 'user' | 'assistant'
  provider: ProviderId
  blocks: Block[]
  done: boolean
  costUsd?: number
  durationMs?: number
  sessionId?: string
  model?: string
  ts: number
}

export function userTurn(id: string, provider: ProviderId, text: string): Turn {
  return { id: `${id}:u`, role: 'user', provider, blocks: [{ type: 'text', text, open: false }], done: true, ts: Date.now() }
}

export function assistantTurn(id: string, provider: ProviderId): Turn {
  return { id, role: 'assistant', provider, blocks: [], done: false, ts: Date.now() }
}

function closeText(blocks: Block[]): Block[] {
  return blocks.map((b) => (b.type === 'text' && b.open ? { ...b, open: false } : b))
}

/** 순수 리듀서: 이벤트 하나를 턴에 반영 */
export function applyEvent(turn: Turn, e: AgentEvent): Turn {
  const blocks = turn.blocks.slice()
  const last = blocks[blocks.length - 1]
  switch (e.kind) {
    case 'session':
      return { ...turn, sessionId: e.sessionId, model: e.model ?? turn.model }
    case 'text-delta':
      if (last && last.type === 'text' && last.open) blocks[blocks.length - 1] = { ...last, text: last.text + e.text }
      else blocks.push({ type: 'text', text: e.text, open: true })
      return { ...turn, blocks }
    case 'text':
      if (!e.text) return { ...turn, blocks: closeText(blocks) }
      return { ...turn, blocks: [...closeText(blocks), { type: 'text', text: e.text, open: false }] }
    case 'thinking':
      return { ...turn, blocks: [...closeText(blocks), { type: 'thinking', text: e.text }] }
    case 'tool-use': {
      const i = blocks.findIndex((b) => b.type === 'tool' && b.id === e.id)
      if (i >= 0) return turn
      return { ...turn, blocks: [...closeText(blocks), { type: 'tool', id: e.id, name: e.name, input: e.input }] }
    }
    case 'tool-result': {
      const i = blocks.findIndex((b) => b.type === 'tool' && b.id === e.id)
      if (i >= 0) {
        const b = blocks[i] as Extract<Block, { type: 'tool' }>
        blocks[i] = { ...b, output: e.output, isError: e.isError }
      }
      return { ...turn, blocks }
    }
    case 'file-change':
      return { ...turn, blocks: [...blocks, { type: 'files', paths: e.paths }] }
    case 'status':
      return { ...turn, blocks: [...blocks, { type: 'status', text: e.message }] }
    case 'error':
      return { ...turn, blocks: [...closeText(blocks), { type: 'error', text: e.message }] }
    case 'result': {
      let next = closeText(blocks)
      const hasText = next.some((b) => b.type === 'text' && b.text.trim())
      if (!hasText && e.text && !e.isError) next = [...next, { type: 'text', text: e.text, open: false }]
      return { ...turn, blocks: next, done: true, costUsd: e.costUsd, durationMs: e.durationMs }
    }
  }
}

/** 음성으로 읽을 최종 답변 텍스트 */
export function finalAnswer(turn: Turn): string {
  for (let i = turn.blocks.length - 1; i >= 0; i--) {
    const b = turn.blocks[i]
    if (b.type === 'text' && b.text.trim()) return b.text
  }
  return ''
}
