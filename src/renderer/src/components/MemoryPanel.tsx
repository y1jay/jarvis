// JARVIS 가 학습한 것: 사용자 기억 + 승인 대답 표현 사전 + 대화 기록 수
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { LexiconEntry, MemoryItem } from '../../../shared/types'

const CAT: Record<MemoryItem['category'], string> = { preference: '선호', habit: '습관', project: '프로젝트', fact: '사실' }

export function MemoryPanel({ learning, onToggle }: { learning: boolean; onToggle: (on: boolean) => void }): ReactNode {
  const [items, setItems] = useState<MemoryItem[]>([])
  const [lex, setLex] = useState<LexiconEntry[]>([])
  const [count, setCount] = useState(0)
  const [path, setPath] = useState('')
  const [text, setText] = useState('')
  const load = useCallback(async () => {
    const r = await window.jarvis.memory.list()
    setItems(r.items)
    setLex(r.lexicon)
    setCount(r.conversations)
    setPath(r.path)
  }, [])
  useEffect(() => {
    void load()
    return window.jarvis.memory.onChanged(() => void load())
  }, [load])

  return (
    <div className="memory panel-pad" data-testid="memory-panel">
      <label className="set-check">
        <input type="checkbox" checked={learning} onChange={(e) => onToggle(e.target.checked)} />
        대화에서 학습하기 (모든 세션에 기억 주입)
      </label>
      <div className="muted small">대화 기록 {count}건 · {path}</div>

      <div className="set-group">
        <div className="set-title">기억 ({items.length})</div>
        <div className="row mem-add">
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="직접 기억시키기 (예: 커밋 메시지는 한국어로)" />
          <button
            className="btn btn-xs"
            disabled={!text.trim()}
            onClick={async () => {
              setItems(await window.jarvis.memory.add(text.trim()))
              setText('')
            }}
          >
            추가
          </button>
        </div>
        {items.length === 0 && <div className="muted small">아직 학습한 내용이 없습니다.</div>}
        {[...items].reverse().map((m) => (
          <div key={m.id} className="mem">
            <span className={`mem-cat cat-${m.category}`}>{CAT[m.category]}</span>
            <span className="mem-text">{m.text}</span>
            <button className="sess-x" onClick={async () => setItems(await window.jarvis.memory.remove(m.id))} title="잊기">
              ×
            </button>
          </div>
        ))}
      </div>

      <div className="set-group">
        <div className="set-title">학습한 승인 대답 ({lex.length})</div>
        {lex.length === 0 && <div className="muted small">규칙으로 모르는 대답을 AI 가 판정하거나, 사용자가 직접 결정하면 여기에 쌓입니다.</div>}
        {[...lex].reverse().map((e) => (
          <div key={e.phrase} className="mem">
            <span className={`mem-cat ${e.decision === 'approve' ? 'cat-ok' : 'cat-no'}`}>{e.decision === 'approve' ? '승인' : '거부'}</span>
            <span className="mem-text">“{e.example}”</span>
            <span className="muted small">{e.source === 'user' ? '직접' : 'AI'} · {e.count}회</span>
            <button className="sess-x" onClick={async () => setLex(await window.jarvis.memory.removePhrase(e.phrase))}>
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
