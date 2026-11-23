// 승인 창에 대한 자연어 대답 판정 (규칙 기반 1단계). 애매하면 null → AI 판정 → 학습 사전에 기록.

export type ApprovalDecision = 'approve' | 'deny'

export function normPhrase(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFC')
    .replace(/^(자비스|쟈비스|jarvis)[\s,.!~]*/i, '')
    .replace(/[\s.,!~…"'`]/g, '')
    .replace(/(요|용)$/, '')
}

/** 되묻기/질문: 승인으로 보면 안 됨 */
export function isQuestion(t: string): boolean {
  const s = t.trim()
  return /\?$|？$/.test(s) || /(뭐|왜|어떻게|무슨|뭔데|어디|언제|누가|어느|뭘|얼마나)/.test(s)
}

const DENY = [
  /거부/, /거절/, /취소/, /안\s*돼/, /안\s*된다/, /안\s*해/, /안\s*할래/, /하지\s*마/, /하지\s*말/, /말아/, /말고/, /안\s*좋/, /중지/, /멈춰/, /그만/, /반려/, /불허/,
  /잠깐/, /잠시만/, /기다려/, /보류/, /나중에/, /싫어/, /됐어/, /됐고/, /노노/, /^노$/, /^아니/, /아니요/, /아뇨/, /아냐/, /놉/,
  /\bno\b/i, /\bnope\b/i, /\bdeny\b/i, /\bcancel\b/i, /\breject\b/i, /\bstop\b/i, /\bwait\b/i, /\bdon'?t\b/i
]

const APPROVE = [
  /승인/, /허가/, /허락/, /허용/, /진행/, /실행해/, /커밋해/, /푸시해/, /올려/, /해도\s*돼/, /해도\s*좋/, /좋아/, /좋습니다/, /오케이/, /콜$/, /^콜/,
  /그래/, /그렇게\s*해/, /그렇게\s*하자/, /그러자/, /그러세요/, /그러시죠/, /가자/, /고고/, /ㄱㄱ/, /^고$/, /당연/, /물론/, /맞아/, /부탁/,
  /^응+$/, /^웅$/, /^어+$/, /^네+$/, /^넵$/, /^예$/, /^옙$/, /^ㅇㅇ$/, /^해$/, /^해줘$/, /^해라$/, /^하자$/, /^ㅇㅋ$/,
  /\bok(ay)?\b/i, /\byes\b/i, /\byep\b/i, /\bsure\b/i, /\bapprove\b/i, /go\s*ahead/i, /\bconfirm\b/i, /\bdo\s*it\b/i
]

/** 규칙으로 판정. 확신이 없으면 null (→ AI 판정) */
export function ruleApproval(transcript: string): ApprovalDecision | null {
  const raw = transcript.trim().replace(/^(자비스|쟈비스|jarvis)[\s,.!~]*/i, '')
  if (!raw) return null
  if (isQuestion(raw)) return null
  const t = raw.replace(/[.!~…]+$/, '').trim()
  const c = t.replace(/\s/g, '')
  if (DENY.some((r) => r.test(t) || r.test(c))) return 'deny'
  if (APPROVE.some((r) => r.test(t) || r.test(c))) return 'approve'
  return null
}

export function classifyApprovalPrompt(title: string, detail: string, utterance: string): string {
  return [
    'JARVIS 가 사용자에게 아래 작업의 승인 여부를 물었고, 사용자가 음성으로 대답했다.',
    `작업: ${title}`,
    `내용: ${detail.slice(0, 600)}`,
    `사용자 대답: "${utterance}"`,
    '',
    '사용자 의도가 명확한 승인이면 approve, 명확한 거부/보류/대기면 deny, 질문이거나 판단 불가면 unclear.',
    '음성 인식 오류로 보이는 의미 없는 말(존재하지 않는 단어, 소리만 비슷한 말)은 추측하지 말고 unclear. 확신이 없으면 unclear.',
    '반드시 approve / deny / unclear 중 한 단어만 출력.'
  ].join('\n')
}

export function parseClassification(raw: string): ApprovalDecision | null {
  const s = raw.trim().toLowerCase()
  if (/^\W*approve/.test(s)) return 'approve'
  if (/^\W*deny/.test(s)) return 'deny'
  return null
}
