// 호출어 감지 + TTS 용 텍스트 정리 (순수 함수)

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFC')
    .replace(/[\s.,!?~'"`·…\-_:;()[\]{}]/g, '')
}

export interface WakeMatch {
  matched: boolean
  /** 호출어 뒤에 이어진 명령 (없으면 '') */
  command: string
}

/**
 * "자비스, 오늘 일정 알려줘" → { matched: true, command: "오늘 일정 알려줘" }
 * 호출어는 문장 앞쪽(처음 12자 안)에 있어야 인정 — 대화 중 우연히 나온 단어로 깨어나지 않게.
 */
export function matchWakeWord(transcript: string, wakeWords: string[]): WakeMatch {
  const raw = transcript.trim()
  if (!raw) return { matched: false, command: '' }
  const lower = raw.toLowerCase()
  for (const w of wakeWords) {
    const wl = w.toLowerCase()
    const idx = lower.indexOf(wl)
    if (idx >= 0 && normalize(raw.slice(0, idx)).length <= 6) {
      const rest = raw.slice(idx + w.length).replace(/^[\s,.!?~·…:;-]+/, '').replace(/^(야|아|님)(?=[\s,.!?]|$)[\s,.!?]*/, '')
      return { matched: true, command: rest.trim() }
    }
  }
  // 띄어쓰기/구두점이 섞인 경우 ("자 비스")
  const n = normalize(raw)
  for (const w of wakeWords) {
    const nw = normalize(w)
    if (n.startsWith(nw) || n.slice(0, 10).includes(nw)) return { matched: true, command: '' }
  }
  return { matched: false, command: '' }
}

/** Whisper 가 무음에서 자주 뱉는 환각 문구 */
const HALLUCINATIONS = [/^시청해\s*주셔서\s*감사합니다/, /^구독과\s*좋아요/, /^감사합니다\.?$/, /^\(.*\)$/, /^\[.*\]$/, /^MBC\s*뉴스/, /^thank you\.?$/i, /^you$/i, /^\.+$/]

export function isLikelyHallucination(t: string): boolean {
  const s = t.trim()
  if (s.length < 2) return true
  return HALLUCINATIONS.some((r) => r.test(s))
}

/** 마크다운/코드 제거 후 앞부분만 읽는다 */
export function speakableText(md: string, maxChars = 420): string {
  let s = md
    .replace(/```[\s\S]*?```/g, ' (코드는 화면을 확인해 주세요) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '링크')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/[*_~>|]/g, '')
    .replace(/\n{2,}/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim()
  if (s.length > maxChars) {
    const cut = s.slice(0, maxChars)
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('다.'), cut.lastIndexOf('요.'), cut.lastIndexOf('\n'))
    s = (end > maxChars * 0.4 ? cut.slice(0, end + 2) : cut).trim() + ' … 나머지는 화면에 표시했습니다.'
  }
  return s
}

export type ApprovalVoice = 'approve' | 'deny' | null
export { ruleApproval as matchApproval } from '../../../shared/approval'
