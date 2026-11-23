// AI 없이 JARVIS 가 직접 처리하는 명령 파서 (순수 함수)
import type { ProviderId } from '../shared/types'

const PROVIDER_ALIASES: Array<[RegExp, ProviderId]> = [
  [/(클로드|클라우드|claude|앤트로픽|anthropic)/i, 'claude'],
  [/(지피티|쥐피티|gpt|챗\s*지피티|chat\s*gpt|코덱스|codex|오픈\s*ai|openai)/i, 'gpt'],
  [/(제미나이|제미니|재미나이|gemini|바드)/i, 'gemini']
]

export function providerFromText(t: string): ProviderId | null {
  for (const [re, p] of PROVIDER_ALIASES) if (re.test(t)) return p
  return null
}

export interface ProviderIntent {
  action: 'login' | 'logout' | 'switch' | 'status'
  provider: ProviderId | null
  rest: string
}

/**
 * "클로드 연결해줘" → login / "지피티로 바꿔줘" → switch / "제미나이 연결 끊어" → logout / "모델 연결 상태 알려줘" → status
 * "지피티로 바꿔서 README 요약해줘" → switch + rest
 */
export function parseProviderIntent(text: string): ProviderIntent | null {
  const t = text
    .trim()
    .replace(/[.!?]+$/, '')
    .replace(/^((자비스|jarvis)[,\s]*|그럼\s+|이제\s+|지금\s+|일단\s+)+/i, '')
  const provider = providerFromText(t)
  const generic = /(모델|ai|에이아이|인공지능)/i.test(t)
  if (!provider && !generic) return null
  // 대상이 모델이어야 함: 공급자 이름이 문장 앞쪽에
  let provEnd = 0
  if (provider) {
    const m = PROVIDER_ALIASES.find(([, p]) => p === provider)![0].exec(t)!
    if (m.index > 0) return null
    provEnd = m.index + m[0].length
  }
  if (/(연결\s*(을\s*)?(끊|해제)|로그아웃|logout|log\s*out|disconnect)/i.test(t)) return { action: 'logout', provider, rest: '' }
  // 전환 동사는 모델 이름 바로 뒤에 와야 한다 ("지피티로 바꿔", "제미나이 써줘")
  const after = t.slice(provEnd)
  const sw = /^\s*(?:으?로\s*(?:바꿔|바꾸|전환|변경|갈아타|스위치|해\s*줘$|하자$|가자$|써|사용)[가-힣]*|\s*(?:써\s*줘|쓰자|써$|사용해\s*줘?|사용하자))/.exec(after)
  if (sw && provider) {
    const rest = after.slice(sw[0].length).replace(/^[\s,]*(서|고|그리고)?[\s,]*/, '').trim()
    return { action: 'switch', provider, rest }
  }
  if (/(연결|로그인|접속|연동|붙여|login|connect)/i.test(t) && !/(상태|됐어|되어\s*있|되있|확인)/.test(t)) return { action: 'login', provider, rest: '' }
  if (/(상태|됐어|되어\s*있|되있|확인|status)/i.test(t) && /(연결|로그인|모델)/.test(t)) return { action: 'status', provider, rest: '' }
  return null
}

export interface SiteLoginIntent {
  site: string
  action: 'login' | 'logout'
}

/** "깃허브 로그인해줘" / "노션 연결해줘" / "슬랙 로그아웃" (AI 모델 이름은 제외) */
export function parseSiteLoginIntent(text: string): SiteLoginIntent | null {
  const t = text.trim().replace(/[.!?]+$/, '')
  const m = /^(.+?)\s*(?:에|에서|계정|사이트)?\s*(?:을|를|좀)?\s*(로그인|연동|연결|로그아웃|연결\s*끊|연동\s*해제)/.exec(t)
  if (!m) return null
  const site = m[1].replace(/^(지금|그럼|이제)\s+/, '').trim()
  if (!site || site.length > 30) return null
  if (providerFromText(site) && !/웹/.test(site)) return null
  return { site, action: /(로그아웃|끊|해제)/.test(m[2]) ? 'logout' : 'login' }
}

/** "xcroll-be랑 xcroll-app" → ['xcroll-be', 'xcroll-app'] */
export function splitTargets(query: string): string[] {
  return query
    .split(/\s*,\s*|\s*(?:이랑|랑|하고|와|과)\s+|\s+(?:그리고|및|and|&)\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 모델 인증 실패로 보이는 오류 */
export function isAuthError(msg: string): boolean {
  return /(not logged in|login required|please (log|sign) ?in|unauthori[sz]ed|\b401\b|authentication (failed|error|required)|invalid (api|x-api) key|oauth token|credentials|로그인이 필요|로그인되어 있지 않|인증)/i.test(msg)
}

export interface VoiceIntent {
  action: 'choose' | 'faster' | 'slower' | 'lower' | 'higher' | 'reset' | 'more'
}

/** "목소리 바꿔줘" / "말 좀 빠르게" / "목소리 더 낮게" / "다른 목소리 다운로드" */
export function parseVoiceIntent(text: string): VoiceIntent | null {
  const t = text.trim().replace(/[.!?]+$/, '')
  const about = /(목소리|음성|보이스|voice|말투|말\s*속도|말하는\s*속도|말\s*좀|말을)/i.test(t)
  if (!about) return null
  if (/(다운로드|더\s*많은|추가|설치)/.test(t)) return { action: 'more' }
  if (/(원래대로|기본으로|초기화|리셋)/.test(t)) return { action: 'reset' }
  if (/(빠르게|빨리|빠른)/.test(t)) return { action: 'faster' }
  if (/(느리게|천천히|느린)/.test(t)) return { action: 'slower' }
  if (/(낮게|낮은|굵게|중후)/.test(t)) return { action: 'lower' }
  if (/(높게|높은|밝게|가늘게)/.test(t)) return { action: 'higher' }
  if (/(바꿔|바꾸|변경|다른|고를|선택|골라|change)/i.test(t)) return { action: 'choose' }
  return null
}
