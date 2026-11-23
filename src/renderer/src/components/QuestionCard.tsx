// JARVIS 가 작업 중에 묻는 질문. 선택지 버튼 / 자유 답변 / 보안 입력(비밀번호·인증번호 — 화면·로그·AI 에 노출 안 됨)
import { useEffect, useRef, useState, type ReactNode } from 'react'

export interface Q {
  id: string
  text: string
  kind: 'choice' | 'text' | 'secret' | 'code'
  options?: string[]
  from?: string
}

export function QuestionCard({ q, voice, onAnswer }: { q: Q; voice: boolean; onAnswer: (v: string | null) => void }): ReactNode {
  const [v, setV] = useState('')
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    setV('')
    ref.current?.focus()
  }, [q.id])
  const secret = q.kind === 'secret' || q.kind === 'code'
  const submit = (): void => {
    if (v.trim()) onAnswer(v.trim())
  }
  return (
    <div className={`question ${secret ? 'question-secret' : ''}`} data-testid="question" data-kind={q.kind}>
      <div className="question-head">
        <span className="question-badge">{secret ? '🔒 보안 입력' : '❓ 질문'}</span>
        {q.from && <span className="muted small">{q.from}</span>}
      </div>
      <div className="question-text">{q.text}</div>
      {q.options && q.options.length > 0 && (
        <div className="question-opts">
          {q.options.map((o, i) => (
            <button key={o} className="btn btn-xs" data-testid="question-option" onClick={() => onAnswer(o)}>
              {i + 1}. {o}
            </button>
          ))}
        </div>
      )}
      <div className="row question-input">
        <input
          ref={ref}
          data-testid="question-input"
          type={q.kind === 'secret' ? 'password' : 'text'}
          inputMode={q.kind === 'code' ? 'numeric' : undefined}
          autoComplete="off"
          value={v}
          placeholder={q.kind === 'secret' ? '비밀번호 (AI·기록에 남지 않음)' : q.kind === 'code' ? '인증번호' : q.options?.length ? '번호나 이름, 또는 직접 입력' : '답변 입력'}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit()
          }}
        />
        <button className="btn btn-primary btn-xs" data-testid="question-submit" onClick={submit} disabled={!v.trim()}>
          답변
        </button>
        <button className="btn btn-ghost btn-xs" onClick={() => onAnswer(null)}>
          취소
        </button>
      </div>
      {voice && q.kind !== 'secret' && <div className="modal-voice">🎙 말로 답해도 됩니다</div>}
    </div>
  )
}
