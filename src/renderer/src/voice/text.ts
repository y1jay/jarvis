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
/** 이름 앞에 올 수 있는 부르는 말 ("헤이 자비스", "야 자비스", "저기 자비스") */
const CALL_PREFIX = /^(헤이|hey|hay|heyy|에이|해이|오케이|ok|okay|야|어|음|저기|저|아|자|이봐)?$/

export function matchWakeWord(transcript: string, wakeWords: string[]): WakeMatch {
  const raw = transcript.trim()
  if (!raw) return { matched: false, command: '' }
  const lower = raw.toLowerCase()
  for (const w of wakeWords) {
    const wl = w.toLowerCase()
    const idx = lower.indexOf(wl)
    // 항상 듣기 중 일상 대화로 깨어나지 않도록: 이름 앞에는 부르는 말만 허용
    if (idx >= 0 && CALL_PREFIX.test(normalize(raw.slice(0, idx)))) {
      const rest = raw.slice(idx + w.length).replace(/^[\s,.!?~·…:;-]+/, '').replace(/^(야|아|님)(?=[\s,.!?]|$)[\s,.!?]*/, '')
      return { matched: true, command: rest.trim() }
    }
  }
  // 띄어쓰기/구두점이 섞인 경우 ("자 비스", "헤이자비스")
  const n = normalize(raw)
  for (const w of wakeWords) {
    const nw = normalize(w)
    const i = n.indexOf(nw)
    if (i >= 0 && CALL_PREFIX.test(n.slice(0, i)) && n.length - i - nw.length <= 1) return { matched: true, command: '' }
  }
  // 발음이 흐려 글자가 조금 다르게 인식된 경우 ("자빗스", "차비스", "재비스", "자비쓰")
  return fuzzyWake(raw, wakeWords)
}

// ── 흐린 발음 허용 (자모 단위 유사도) ─────────────────────────────
const L = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ']
const V = ['ㅏ', 'ㅐ', 'ㅑ', 'ㅒ', 'ㅓ', 'ㅔ', 'ㅕ', 'ㅖ', 'ㅗ', 'ㅘ', 'ㅙ', 'ㅚ', 'ㅛ', 'ㅜ', 'ㅝ', 'ㅞ', 'ㅟ', 'ㅠ', 'ㅡ', 'ㅢ', 'ㅣ']
const T = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ']
/** 소리가 비슷해 흔히 헷갈려 인식되는 자모를 한 그룹으로 */
const SOUND: Record<string, string> = {
  ㄲ: 'ㄱ', ㅋ: 'ㄱ', ㄸ: 'ㄷ', ㅌ: 'ㄷ', ㅃ: 'ㅂ', ㅍ: 'ㅂ', ㅆ: 'ㅅ', ㅉ: 'ㅈ', ㅊ: 'ㅈ',
  ㅐ: 'ㅔ', ㅒ: 'ㅔ', ㅖ: 'ㅔ', ㅑ: 'ㅏ', ㅕ: 'ㅓ', ㅛ: 'ㅗ', ㅠ: 'ㅜ', ㅙ: 'ㅞ', ㅚ: 'ㅞ'
}

/** 한글 → 소리 그룹으로 정규화한 자모열 (영문은 소문자 그대로) */
export function soundKey(s: string): string {
  let out = ''
  for (const ch of s.toLowerCase().normalize('NFC')) {
    const c = ch.charCodeAt(0) - 0xac00
    if (c >= 0 && c < 11172) {
      const parts = [L[Math.floor(c / 588)], V[Math.floor((c % 588) / 28)], T[c % 28]]
      for (const j of parts) if (j) out += SOUND[j] ?? j
    } else if (/[a-z0-9]/.test(ch)) out += ch
  }
  return out
}

export function editDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[n]
}

/** 이름 길이에 따라 허용 오차: 짧은 이름은 정확해야 하고, 길수록 조금 더 너그럽게 */
function allowedDistance(len: number): number {
  return len >= 7 ? 2 : len >= 5 ? 1 : 0
}

/** 호출어 뒤 "야/아/님" 같은 부르는 말 꼬리 제거 */
const VOCATIVE = /(야|아|님|씨)$/

function fuzzyWake(raw: string, wakeWords: string[]): WakeMatch {
  const tokens = raw
    .replace(/[,.!?~·…:;]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  // 시작 위치: 맨 앞, 그리고 앞이 부르는 말("헤이", "야", "저기")이면 그 다음 — "자 빗스" 처럼 '자'가 이름의 일부일 수도 있어 둘 다 본다
  const starts = [0]
  if (tokens.length > 1 && normalize(tokens[0]) && CALL_PREFIX.test(normalize(tokens[0]))) starts.push(1)
  const keys = wakeWords.map((w) => ({ w, k: soundKey(w) })).filter((x) => x.k.length >= 5)
  for (const i of starts) {
    // 첫 단어 하나, 또는 띄어져 인식된 첫 두 단어("자 비스")
    const cands: Array<{ text: string; used: number }> = [{ text: tokens[i], used: 1 }]
    if (i + 1 < tokens.length) cands.push({ text: tokens[i] + tokens[i + 1], used: 2 })
    for (const c of cands) {
      for (const variant of [c.text, c.text.replace(VOCATIVE, '')]) {
        const ck = soundKey(variant)
        if (!ck) continue
        for (const { k } of keys) {
          if (ck[0] !== k[0]) continue // 첫 소리는 같아야 (서비스 ≠ 자비스)
          if (Math.abs(ck.length - k.length) > allowedDistance(k.length)) continue
          if (editDistance(ck, k) <= allowedDistance(k.length)) {
            return { matched: true, command: tokens.slice(i + c.used).join(' ').trim() }
          }
        }
      }
    }
  }
  return { matched: false, command: '' }
}

/** Whisper 가 무음에서 자주 뱉는 환각 문구 */
// 소리가 거의 없을 때 인식 엔진이 지어내는 말 (영상 자막 학습 흔적)
const HALLUCINATIONS = [/^시청해\s*주셔서\s*감사합니다/, /시청해\s*주셔서/, /^구독과\s*좋아요/, /구독.*(좋아요|알림)/, /^감사합니다\.?$/, /자막\s*(제공|by|제작)/i, /광고를\s*포함/, /^\(.*\)$/, /^\[.*\]$/, /^MBC\s*뉴스/, /^thank you\.?$/i, /^you$/i, /^\.+$/, /^(음+|어+|아+|흠+)[.!?]*$/]

/**
 * 말이 아직 안 끝난 것 같은지 — 문장 중간에 잠깐 쉰 경우 ("오늘 일정 정리해서…", "엄마한테…", "커밋은…").
 * 이럴 땐 바로 실행하지 않고 이어지는 말을 잠깐 기다렸다가 합쳐서 다시 인식한다.
 * 한국어 문장 끝맺음(~줘/~해/~야/~요/~다/~까 …)으로 끝나면 끝난 말로 본다.
 */
const FINISHED_END = /(줘|해|워|돼|대|내|해라|하자|봐|라|요|야|다|까|냐|니|지|죠|래|려|자|네|어|아|여|군|걸|셈|음|함|게요|세요|십시오|습니다|ㅂ니다)$/
export function looksUnfinished(t: string): boolean {
  const s = t.trim().replace(/[\s.,…~·"'”’)\]]+$/u, '')
  if (!s) return false
  if (/[?!？！]$/.test(t.trim())) return false
  const last = s.split(/\s+/).pop() ?? ''
  if (!/[가-힣]/.test(last)) return false // 영어/숫자로 끝나면 판단하지 않음
  return !FINISHED_END.test(last)
}

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

/** "멈춰", "그만해", "작업 중지" 같은 순수 정지 명령인지 (다른 요청이 섞이면 아님) */
const STOP_COMMAND = /^(다|일단|잠깐|잠깐만|지금|하던거|작업|전부|모두)?(멈춰|멈춰줘|멈춰봐|멈추세요|멈춰주세요|그만|그만해|그만해줘|그만둬|그만하세요|중지|중지해|중지해줘|중단|중단해|중단해줘|스톱|스탑|stop)(요|해요)?$/i

export function isStopCommand(t: string): boolean {
  return STOP_COMMAND.test(normalize(t))
}

function bigrams(s: string): Set<string> {
  const out = new Set<string>()
  for (let i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2))
  return out
}

/**
 * 끼어들기로 받은 말이 사실 스피커로 나간 JARVIS 자기 목소리인지.
 * 인식문 글자쌍 대부분이 방금 읽던 문장에 들어 있으면 메아리로 본다.
 */
export function isEchoOf(transcript: string, spoken: string): boolean {
  const t = normalize(transcript)
  const s = normalize(spoken)
  if (!t || !s) return false
  if (s.includes(t)) return true
  const tb = bigrams(t)
  if (tb.size < 3) return false
  const sb = bigrams(s)
  let hit = 0
  for (const b of tb) if (sb.has(b)) hit++
  return hit / tb.size >= 0.6
}

/**
 * 스트리밍으로 들어오는 답변에서 "다 끝난 문장"만 떼어 낸다 → 바로 읽기 시작.
 * 너무 짧은 조각(예: "네.")은 다음 문장과 합쳐 끊김 없이 읽는다.
 */
export function takeSentences(buf: string, minLen = 6): { sentences: string[]; rest: string } {
  const sentences: string[] = []
  let rest = buf
  let pending = ''
  const re = /([.!?。！？](?=\s|$)|\n+)/
  for (;;) {
    const m = re.exec(rest)
    if (!m) break
    const end = m.index + m[0].length
    // 문장 끝 표시가 버퍼 맨 끝이면 아직 뒤에 더 올 수 있다 ("3.5" 같은 숫자 등) → 다음 조각을 기다림
    if (end >= rest.length && m[0] !== '\n') break
    const piece = (pending + rest.slice(0, end)).replace(/\s+/g, ' ').trim()
    rest = rest.slice(end)
    if (piece.length < minLen) {
      pending = piece + ' '
      continue
    }
    pending = ''
    sentences.push(piece)
  }
  return { sentences, rest: pending + rest }
}
