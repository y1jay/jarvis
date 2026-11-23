import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Block, Turn } from '../lib/chat'
import { PROVIDER_LABEL } from '../../../shared/types'
import { Markdown } from './Markdown'

function toolSummary(name: string, input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>
  const v = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.query ?? o.url ?? o.description
  if (typeof v === 'string') return v.length > 140 ? v.slice(0, 140) + '…' : v
  if (Array.isArray(o.changes)) return `${o.changes.length}개 파일 변경`
  return ''
}

function ToolBlock({ b }: { b: Extract<Block, { type: 'tool' }> }): ReactNode {
  const [open, setOpen] = useState(false)
  const state = b.output === undefined ? 'running' : b.isError ? 'error' : 'ok'
  return (
    <div className={`tool tool-${state}`}>
      <button className="tool-head" onClick={() => setOpen(!open)}>
        <span className="tool-dot" />
        <span className="tool-name">{b.name}</span>
        <span className="tool-sum">{toolSummary(b.name, b.input)}</span>
        <span className="tool-caret">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="tool-body">
          <pre className="tool-in">{JSON.stringify(b.input, null, 2)}</pre>
          {b.output !== undefined && <pre className="tool-out">{b.output || '(출력 없음)'}</pre>}
        </div>
      )}
    </div>
  )
}

function TurnView({ t }: { t: Turn }): ReactNode {
  if (t.role === 'user') {
    const b = t.blocks[0]
    return (
      <div className="msg msg-user">
        <div className="msg-text">{b.type === 'text' ? b.text : ''}</div>
      </div>
    )
  }
  return (
    <div className="msg msg-ai" data-testid="assistant-turn" data-done={t.done ? '1' : '0'}>
      <div className="msg-meta">
        <span className="msg-who">JARVIS · {PROVIDER_LABEL[t.provider]}</span>
        {t.model && <span className="msg-model">{t.model}</span>}
        {!t.done && <span className="msg-live">● 처리 중</span>}
        {t.done && t.durationMs !== undefined && <span className="msg-dur">{(t.durationMs / 1000).toFixed(1)}s{t.costUsd ? ` · $${t.costUsd.toFixed(4)}` : ''}</span>}
      </div>
      {t.blocks.map((b, i) => {
        switch (b.type) {
          case 'text':
            return b.text ? <Markdown key={i} text={b.text} /> : null
          case 'thinking':
            return (
              <details key={i} className="thinking">
                <summary>생각</summary>
                <div>{b.text}</div>
              </details>
            )
          case 'tool':
            return <ToolBlock key={i} b={b} />
          case 'files':
            return (
              <div key={i} className="files">
                ✎ 수정됨: {b.paths.map((p) => p.split(/[\\/]/).pop()).join(', ')}
              </div>
            )
          case 'status':
            return <div key={i} className="status-line">{b.text}</div>
          case 'error':
            return <div key={i} className="error-line">⚠ {b.text}</div>
        }
      })}
    </div>
  )
}

export function ChatPanel({ turns, busy, onSend, onStop }: { turns: Turn[]; busy: boolean; onSend: (t: string) => void; onStop: () => void }): ReactNode {
  const [text, setText] = useState('')
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // 최신 Chromium 은 scrollIntoView 가 Promise 를 반환하므로 effect 에서 값을 반환하지 않는다
    void end.current?.scrollIntoView({ block: 'end' })
  }, [turns])
  const submit = (): void => {
    const t = text.trim()
    if (!t || busy) return
    onSend(t)
    setText('')
  }
  return (
    <div className="chat">
      <div className="chat-scroll">
        {turns.length === 0 && (
          <div className="chat-empty">
            <div className="chat-empty-title">무엇을 도와드릴까요?</div>
            <div>"자비스"라고 부르거나 아래에 입력하세요.</div>
            <div className="chat-hints">
              <span>이 프로젝트 구조 설명해줘</span>
              <span>README 에 설치 방법 추가해줘</span>
              <span>변경사항 커밋해줘</span>
            </div>
          </div>
        )}
        {turns.map((t) => (
          <TurnView key={t.id} t={t} />
        ))}
        <div ref={end} />
      </div>
      <div className="chat-input">
        <textarea
          data-testid="chat-input"
          value={text}
          placeholder={busy ? '처리 중…' : '메시지 입력 (Enter 전송, Shift+Enter 줄바꿈)'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
          rows={2}
        />
        {busy ? (
          <button className="btn btn-danger" onClick={onStop}>
            중지
          </button>
        ) : (
          <button className="btn btn-primary" data-testid="chat-send" onClick={submit} disabled={!text.trim()}>
            전송
          </button>
        )}
      </div>
    </div>
  )
}
