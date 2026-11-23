import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ApprovalRequest } from '../../../shared/types'

const KIND_LABEL: Record<ApprovalRequest['kind'], string> = {
  'git-commit': 'GIT COMMIT',
  'git-push': 'GIT PUSH',
  destructive: '위험 명령',
  tool: '도구 실행'
}

/** 실수로 Enter 한 번에 승인되지 않도록, 승인 버튼은 0.8초 후 활성화 */
export function ApprovalModal({ req, voice, onRespond }: { req: ApprovalRequest; voice?: boolean; onRespond: (approved: boolean, reason?: string) => void }): ReactNode {
  const [armed, setArmed] = useState(false)
  const [reason, setReason] = useState('')
  const denyRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    setArmed(false)
    const t = setTimeout(() => setArmed(true), 800)
    denyRef.current?.focus()
    return () => clearTimeout(t)
  }, [req.id])
  const danger = req.kind === 'destructive' || req.kind === 'git-push'
  return (
    <div className="modal-back" data-testid="approval-modal">
      <div className={`modal ${danger ? 'modal-danger' : ''}`}>
        <div className="modal-kind">{KIND_LABEL[req.kind]}</div>
        <div className="modal-title">{req.title}</div>
        <div className="modal-from">요청: {req.provider === 'jarvis' ? 'JARVIS Git 패널' : req.provider}</div>
        <pre className="modal-detail">{req.detail}</pre>
        {req.image && <img className="modal-image" src={req.image} alt="현재 화면" data-testid="approval-image" />}
        {voice && <div className="modal-voice" data-testid="approval-voice-hint">🎙 음성으로 “승인” 또는 “거부”라고 말씀하세요</div>}
        <input className="modal-reason" placeholder="거부 사유 (선택, AI 에게 전달됨)" value={reason} onChange={(e) => setReason(e.target.value)} />
        <div className="row modal-actions">
          <button ref={denyRef} className="btn" data-testid="approval-deny" onClick={() => onRespond(false, reason || undefined)}>
            거부
          </button>
          <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} data-testid="approval-approve" disabled={!armed} onClick={() => onRespond(true)}>
            승인
          </button>
        </div>
      </div>
    </div>
  )
}
