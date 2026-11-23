import { useEffect, useState, type ReactNode } from 'react'
import type { AuditEntry } from '../../../shared/types'

const ACTION_LABEL: Record<string, string> = {
  'auth.login': '로그인',
  'auth.logout': '로그아웃',
  'auth.apikey.set': 'API 키 등록',
  'auth.apikey.clear': 'API 키 삭제',
  'project.open': '프로젝트 열기',
  'file.modified': '파일 수정',
  'git.stage': '스테이징',
  'git.unstage': '스테이징 해제',
  'git.commit': '커밋',
  'git.push': '푸시',
  'approval.requested': '승인 요청',
  'approval.approved': '승인',
  'approval.denied': '거부',
  'agent.prompt': '명령',
  'agent.interrupt': '작업 중지',
  'settings.changed': '설정 변경',
  'system.app.open': '앱 실행',
  'system.app.quit': '앱 종료',
  'system.url.open': '웹 열기',
  'system.path.open': '폴더/파일 열기',
  'system.screenshot': '스크린샷',
  'system.clipboard.write': '클립보드 복사'
}

const FILTERS: Array<[string, string]> = [
  ['', '전체'],
  ['git', 'Git'],
  ['file', '파일'],
  ['approval', '승인'],
  ['auth', '인증'],
  ['agent', '명령'],
  ['system', '시스템']
]

function summary(e: AuditEntry): string {
  const d = e.detail ?? {}
  if (e.action === 'agent.prompt') return String(d.prompt ?? '')
  if (e.action === 'agent.interrupt') return `${d.via === 'voice' ? `🎙 "${String(d.transcript ?? '')}"` : '중지 버튼'} · 실행 중 ${String(d.running ?? 0)}개`
  if (e.action === 'git.commit') return `${String(d.message ?? '').split('\n')[0]} ${e.target ? `(${e.target.slice(0, 7)})` : ''}${d.unapproved ? ' ⚠ 미승인' : ''}`
  if (e.action.startsWith('approval') && d.via === 'voice') return `${String(d.title ?? '')} · 🎙 "${String(d.transcript ?? '')}"`
  if (e.action.startsWith('approval')) return String(d.title ?? e.target ?? '')
  if (e.action === 'auth.login') return d.success ? '성공' : '실패'
  return e.target ?? (d.paths ? String(d.paths) : '')
}

export function HistoryPanel({ refreshKey }: { refreshKey: number }): ReactNode {
  const [items, setItems] = useState<AuditEntry[]>([])
  const [filter, setFilter] = useState('')
  const [path, setPath] = useState('')
  useEffect(() => {
    void window.jarvis.audit.list({ limit: 300, action: filter || undefined }).then(setItems)
    void window.jarvis.audit.path().then(setPath)
  }, [filter, refreshKey])
  return (
    <div className="history">
      <div className="history-filters">
        {FILTERS.map(([k, l]) => (
          <button key={k} className={`chip ${filter === k ? 'chip-on' : ''}`} onClick={() => setFilter(k)}>
            {l}
          </button>
        ))}
      </div>
      <div className="history-list" data-testid="history-list">
        {items.length === 0 && <div className="muted panel-pad">이력이 없습니다.</div>}
        {items.map((e) => (
          <div key={e.id} className={`hist hist-${e.action.split('.')[0]} ${e.action === 'approval.denied' ? 'hist-denied' : ''}`}>
            <div className="hist-top">
              <span className="hist-action">{ACTION_LABEL[e.action] ?? e.action}</span>
              {e.provider && <span className="hist-prov">{e.provider}</span>}
              <span className="hist-ts">{new Date(e.ts).toLocaleString('ko-KR')}</span>
            </div>
            <div className="hist-sum">{summary(e)}</div>
            {e.project && <div className="hist-proj">{e.project}</div>}
          </div>
        ))}
      </div>
      <div className="muted history-path">저장 위치: {path}</div>
    </div>
  )
}
