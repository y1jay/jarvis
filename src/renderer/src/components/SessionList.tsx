import type { ReactNode } from 'react'
import { PROVIDER_LABEL, type SessionInfo } from '../../../shared/types'

export function SessionList({ sessions, focused, viewing, onView, onNew, onClose }: { sessions: SessionInfo[]; focused: string | null; viewing: string | null; onView: (id: string) => void; onNew: () => void; onClose: (id: string) => void }): ReactNode {
  return (
    <div className="sessions" data-testid="session-list">
      <div className="side-title">
        세션 <span className="count">{sessions.length}</span>
        <button className="btn btn-ghost btn-xs side-add" onClick={onNew} title="새 세션">
          ＋
        </button>
      </div>
      {sessions.length === 0 && <div className="muted small">세션 없음</div>}
      {sessions.map((s) => (
        <div key={s.id} className={`sess ${s.id === viewing ? 'sess-view' : ''} ${s.id === focused ? 'sess-focus' : ''}`} data-testid="session-item" data-status={s.status}>
          <button className="sess-main" onClick={() => onView(s.id)} title={s.projectDir ?? '일반 대화'}>
            <span className={`sess-led led-${s.status}`} />
            <span className="sess-title">{s.title}</span>
            <span className="sess-prov">{PROVIDER_LABEL[s.provider].split(' ')[0]}</span>
          </button>
          <button className="sess-x" onClick={() => onClose(s.id)} title="세션 닫기">
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
