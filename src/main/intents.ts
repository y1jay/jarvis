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
  const about = /(목소리|음성|보이스|voice|말투|말\s*속도|말하는\s*속도)/i.test(t) || /말\s*(을\s*)?(좀\s*)?(더\s*)?(빠르게|빨리|천천히|느리게)/.test(t)
  if (!about) return null
  // 찾아보기·검색·설치·만들기 같은 다른 일은 에이전트가 ("목소리를 오픈소스에서 찾아봐", "음성 인식 코드 고쳐줘")
  if (/(찾아|검색|알아봐|알아봐|조사|오픈\s*소스|인터넷|웹에서|사이트|만들어|코드|구현|엔진|모델|API|학습|인식|녹음|마이크)/i.test(t)) return null
  if (/(다운로드|더\s*많은|추가|설치)/.test(t)) return { action: 'more' }
  if (/(원래대로|기본으로|초기화|리셋)/.test(t)) return { action: 'reset' }
  if (/(빠르게|빨리|빠른)/.test(t)) return { action: 'faster' }
  if (/(느리게|천천히|느린)/.test(t)) return { action: 'slower' }
  if (/(낮게|낮은|굵게|중후)/.test(t)) return { action: 'lower' }
  if (/(높게|높은|밝게|가늘게)/.test(t)) return { action: 'higher' }
  if (/(바꿔|바꾸|변경|다른\s*목소리|고를|선택|골라|change)/i.test(t)) return { action: 'choose' }
  return null
}

/** "다시 말해줘", "뭐라고?", "방금 뭐라고 했어" */
export function isRepeatRequest(t: string): boolean {
  const s = t.trim().replace(/[?.!]+$/, '')
  return /^(다시|한\s*번\s*더)\s*(말해|얘기해|말씀해|읽어)\s*(봐|줘|주세요|줄래|봐줘|줄래요)?$/.test(s) || /^(뭐라고|뭐라구|네\??\s*뭐라고)(요|했어|하셨어요|했지)?$/.test(s) || /^(방금|아까)\s*(뭐라고|뭐라)\s*(했어|했지|하셨어요|그랬어)?$/.test(s)
}

/** 음성 학습 / 기억 백업·복원 명령 */
export function parseVoiceLearnIntent(t: string): 'setup' | 'status' | 'backup' | 'clear' | 'restore' | 'train' | 'revert' | null {
  const s = t.replace(/\s+/g, ' ').trim()
  // "목소리 학습해줘", "내 목소리로 학습시켜", "음성 학습 돌려줘" — 모인 말소리로 맞춤 학습
  if (/(목소리|음성|말소리)/.test(s) && /(학습\s*(시켜|돌려|진행|해\s*줘|해|하자|좀)|학습을?\s*(시작|돌려|해))/.test(s) && !/(암호|비밀번호|패스워드|상태|백업|지워|삭제|복원)/.test(s)) return 'train'
  // "목소리 학습 되돌려", "맞춤 모델 빼줘"
  if (/(목소리\s*학습|맞춤\s*모델|학습한\s*모델)/.test(s) && /(되돌려|원래대로|빼|취소|끄)/.test(s)) return 'revert'
  // "기억 백업해줘", "기억 전부 복원해줘", "백업 복원해줘", "자비스 데이터 가져와"
  if (/(기억|백업|학습|자비스\s*데이터)/.test(s) && /(복원|되살려|가져와|불러와|내려받아)/.test(s) && !/(파일|폴더|프로젝트|코드)/.test(s)) return 'restore'
  if (/^(기억|전부|모두|자비스\s*데이터)\s*(전부|다|모두)?\s*(깃에|깃허브에|git 에|git에)?\s*(백업|올려)/.test(s)) return 'backup'
  if (!/(음성|목소리|말소리|말투)\s*학습/.test(s)) return null
  if (/(암호|비밀번호|패스워드|키)/.test(s) && /(정해|설정|만들|바꿔|등록)/.test(s)) return 'setup'
  if (/(백업|깃|git|저장소|올려|푸시)/.test(s)) return 'backup'
  if (/(지워|삭제|비워|초기화)/.test(s)) return 'clear'
  if (/(상태|얼마나|몇\s*개|확인|보여|알려)/.test(s)) return 'status'
  if (/켜/.test(s)) return 'setup'
  return null
}

/** "왼쪽 창 닫아", "AI 연결창 열어", "사이드바 숨겨" */
export function parseSideIntent(t: string): boolean | null {
  const s = t.replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '')
  if (!/^(왼쪽\s*창|왼쪽\s*패널|사이드\s*바|사이드\s*창|AI\s*연결\s*창|에이아이\s*연결\s*창|연결\s*창|프로젝트\s*창)\s*(을|를|좀)?\s*/i.test(s)) return null
  if (/(닫아|숨겨|접어|치워|꺼)/.test(s)) return false
  if (/(열어|보여|펼쳐|켜|띄워)/.test(s)) return true
  return null
}

/** "대화창 닫아/열어/숨겨/보여줘" */
export function parsePanelIntent(t: string): boolean | null {
  const s = t.replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '')
  if (!/^(대화\s*창|채팅\s*창|대화\s*패널|오른쪽\s*창)\s*(을|를|좀)?\s*/.test(s)) return null
  if (/(닫아|숨겨|접어|치워|꺼)/.test(s)) return false
  if (/(열어|보여|펼쳐|켜|띄워)/.test(s)) return true
  return null
}

/**
 * 선택지 질문에 대한 대답이 '고르기'가 아니라 다른 요청인지 ("그거 말고 인터넷에서 찾아봐", "유나 말곤 없어?", "그냥 됐어")
 * 짧거나 알아듣기 힘든 말(인식 실수)은 다시 묻고, 분명히 다른 말을 하면 새 요청으로 처리한다
 */
export function isOtherRequest(answer: string): boolean {
  const s = answer.trim().replace(/[.!]+$/, '')
  const hangul = (s.match(/[가-힣]/g) ?? []).length
  if (hangul < 4) return false
  return /(말고|대신|아니|없어|없나|있어\?|있을까|찾아|검색|알아봐|해줘|해 줘|줄래|보여|알려|어떻게|뭐가|왜|됐어|그만|취소|나중에|\?)/.test(s)
}

/** "지금 몇 시야", "오늘 며칠이야", "무슨 요일이야" — AI 를 거치지 않고 시계로 바로 */
export function timeAnswer(t: string, now = new Date()): string | null {
  const s = t.replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '')
  if (s.length > 25) return null
  const wantTime = /(몇\s*시|지금\s*시간|시간\s*(좀|알려|몇)|몇\s*신지)/.test(s)
  const wantDate = /(며칠|몇\s*일|날짜|무슨\s*요일|몇\s*요일|오늘\s*요일)/.test(s)
  if (!wantTime && !wantDate) return null
  const days = ['일', '월', '화', '수', '목', '금', '토']
  const h = now.getHours()
  const m = now.getMinutes()
  const time = `${h < 12 ? '오전' : '오후'} ${h % 12 === 0 ? 12 : h % 12}시${m ? ` ${m}분` : ''}`
  const date = `${now.getMonth() + 1}월 ${now.getDate()}일 ${days[now.getDay()]}요일`
  // 받침 있으면 "이에요", 없으면 "예요" (35분이에요 / 4시예요 / 화요일이에요)
  const ida = (w: string): string => {
    const c = w.charCodeAt(w.length - 1) - 0xac00
    return c >= 0 && c < 11172 && c % 28 !== 0 ? `${w}이에요` : `${w}예요`
  }
  if (wantTime && wantDate) return `오늘은 ${date}, 지금은 ${ida(time)}.`
  return wantTime ? `지금은 ${ida(time)}.` : `오늘은 ${ida(date)}.`
}

/**
 * 앞 요청에 이어 붙는 말인지 ("…안 나오게 돼" + "해달라는 거야", "…열어줘" + "그리고 테스트도")
 * 혼자서는 뜻이 안 되는 꼬리말·접속어로 시작하거나, 한두 단어짜리 조각
 */
export function isContinuation(t: string): boolean {
  const s = t.trim().replace(/[.!?]+$/, '')
  if (!s) return false
  if (/^(해\s*달라|해\s*줘|해\s*주|하라|라고|이라고|다고|라는|는\s*거|거야|도록|하고|그리고|그래서|근데|그러니까|그런데|아니\s*그|이랑|하고서|해서)/.test(s)) return true
  const hangul = (s.match(/[가-힣]/g) ?? []).length
  return hangul > 0 && hangul <= 3 && !/(응|네|아니|그래|좋아|싫어|멈춰|그만|취소|고마워)/.test(s)
}
