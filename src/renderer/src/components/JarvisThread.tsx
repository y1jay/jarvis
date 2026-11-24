// JARVIS 메인 대화: 요청 하나 = JARVIS 답변 하나. 뒤에서 여러 세션이 일한 내역은 작업 칩으로 보여준다.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { JobInfo } from '../../../shared/types'
import { Markdown } from './Markdown'

const STATUS: Record<JobInfo['status'], string> = {
  planning: '작업 분석 중',
  running: '작업 중',
  summarizing: '결과 정리 중',
  done: '완료',
  error: '실패'
}

const TASK_ICON = { pending: '○', running: '◐', done: '●', error: '✕' } as const

export function JarvisThread({ jobs, onSend, onStop, onOpenSession }: { jobs: JobInfo[]; onSend: (t: string) => void; onStop: () => void; onOpenSession: (id: string) => void }): ReactNode {
  const [text, setText] = useState('')
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    void end.current?.scrollIntoView({ block: 'end' })
  }, [jobs])
  const running = jobs.some((j) => j.status !== 'done' && j.status !== 'error')
  const submit = (): void => {
    const t = text.trim()
    if (!t) return
    onSend(t)
    setText('')
  }
  return (
    <div className="chat">
      <div className="chat-scroll">
        {jobs.length === 0 && (
          <div className="chat-empty">
            <div className="chat-empty-title">무엇을 도와드릴까요?</div>
            <div>"자비스"라고 부르거나 아래에 입력하세요. 여러 프로젝트 작업도 한 번에 맡기세요.</div>
            <div className="chat-hints">
              <span>xcroll-be 랑 xcroll-app 열어줘</span>
              <span>be 에 API 추가하고 app 에서 호출하게 해줘</span>
              <span>깃허브 로그인해줘</span>
              <span>크롬 열어줘</span>
            </div>
          </div>
        )}
        {jobs.map((j) => (
          <div key={j.id} className="job" data-testid="jarvis-job" data-status={j.status}>
            {/* 음성으로 한 말은 글자로 남기지 않는다 (키보드로 입력한 것만 표시) */}
            {j.via !== 'voice' && (
              <div className="msg msg-user">
                <div className="msg-text">{j.prompt}</div>
              </div>
            )}
            <div className="msg msg-ai">
              <div className="msg-meta">
                <span className="msg-who">JARVIS</span>
                {j.status !== 'done' && j.status !== 'error' && <span className="msg-live">● {STATUS[j.status]}</span>}
                {j.status === 'error' && <span className="msg-err">실패</span>}
              </div>
              {j.notes.map((n, i) => (
                <div key={i} className="status-line">
                  {n}
                </div>
              ))}
              {j.tasks.length > 0 && (
                <div className="tasks">
                  {j.tasks.map((t) => (
                    <button key={t.id} className={`task task-${t.status}`} onClick={() => onOpenSession(t.sessionId)} title={t.instruction}>
                      <span className="task-icon">{TASK_ICON[t.status]}</span>
                      <span className="task-title">{t.title}</span>
                      {t.after.length > 0 && <span className="task-dep">← {t.after.map((a) => j.tasks[a]?.title).join(', ')}</span>}
                    </button>
                  ))}
                </div>
              )}
              {j.answer ? <Markdown text={j.answer} /> : null}
            </div>
          </div>
        ))}
        <div ref={end} />
      </div>
      <div className="chat-input">
        <textarea
          data-testid="chat-input"
          value={text}
          placeholder="JARVIS 에게 요청 (Enter 전송, Shift+Enter 줄바꿈)"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
          rows={2}
        />
        <div className="chat-btns">
          <button className="btn btn-primary" data-testid="chat-send" onClick={submit} disabled={!text.trim()}>
            전송
          </button>
          {running && (
            <button className="btn btn-danger btn-xs" onClick={onStop}>
              전체 중지
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
