import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ApprovalRequest } from '../../../shared/types'

const KIND_LABEL: Record<ApprovalRequest['kind'], string> = {
  'git-commit': 'GIT COMMIT',
  'git-push': 'GIT PUSH',
  destructive: '위험 명령',
  tool: '도구 실행'
}

export interface StageRect {
  left: number
  top: number
  width: number
  height: number
}

/**
 * 승인 요청 — 화면을 덮는 상자 없이 홀로그램 위에 빛나는 글자로 띄운다 (홀로그램은 뒤에서 계속 보인다).
 * stage 가 있으면 홀로그램 무대 위에만, 없으면 창 전체 가운데.
 * 실수로 Enter 한 번에 승인되지 않도록, 승인 버튼은 0.8초 후 활성화
 */
export function ApprovalModal({ req, voice, stage, onRespond }: { req: ApprovalRequest; voice?: boolean; stage?: StageRect | null; onRespond: (approved: boolean, reason?: string) => void }): ReactNode {
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
    <div className="holo-ask-back" data-testid="approval-modal" style={stage ? { left: stage.left, top: stage.top, width: stage.width, height: stage.height } : undefined}>
      <div className={`holo-ask ${danger ? 'holo-ask-danger' : ''}`}>
        <div className="holo-ask-kind">{KIND_LABEL[req.kind]}</div>
        <div className="holo-ask-title">{req.title}</div>
        <div className="holo-ask-from">요청: {req.provider === 'jarvis' ? 'JARVIS Git 패널' : req.provider}</div>
        <pre className="holo-ask-detail">{req.detail}</pre>
        {req.image && <img className="holo-ask-image" src={req.image} alt="현재 화면" data-testid="approval-image" />}
        {voice && <div className="modal-voice" data-testid="approval-voice-hint">🎙 음성으로 “승인” 또는 “거부”라고 말씀하세요</div>}
        <input className="holo-ask-reason" placeholder="거부 사유 (선택, AI 에게 전달됨)" value={reason} onChange={(e) => setReason(e.target.value)} />
        <div className="holo-ask-actions">
          <button ref={denyRef} className="holo-ask-btn" data-testid="approval-deny" onClick={() => onRespond(false, reason || undefined)}>
            거부
          </button>
          <button className={`holo-ask-btn holo-ask-ok ${danger ? 'holo-ask-ok-danger' : ''}`} data-testid="approval-approve" disabled={!armed} onClick={() => onRespond(true)}>
            승인
          </button>
        </div>
      </div>
    </div>
  )
}
