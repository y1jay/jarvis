// 호출어: "자비스"(항상) + 사용자가 정한 이름 + 추가 호출어. "헤이 ○○" 처럼 앞에 붙는 말은 matchWakeWord 가 허용한다.

export const DEFAULT_NAME = '자비스'
export const JARVIS_VARIANTS = ['자비스', '쟈비스', '자비쓰', '재비스', 'jarvis', 'javis']

const n = (s: string): string => s.toLowerCase().replace(/\s/g, '')

export function effectiveWakeWords(name: string, extras: string[] = []): string[] {
  const out: string[] = []
  const add = (w: string): void => {
    const t = w.trim()
    if (t && !out.some((x) => n(x) === n(t))) out.push(t)
  }
  for (const w of JARVIS_VARIANTS) add(w)
  add(name)
  for (const w of extras) add(w)
  // 긴 것부터 매칭해야 "자비스" 가 "자비" 같은 짧은 별칭보다 먼저 잡힌다
  return out.sort((a, b) => b.length - a.length)
}

/**
 * "이제부터 네 이름은 프라이데이야" / "너 이름 프라이데이로 해" / "앞으로 너를 헤이 금요일로 부를게"
 * → '프라이데이'
 */
export function parseRenameIntent(text: string): string | null {
  if (/\?\s*$/.test(text.trim()) || /(뭐야|뭐니|뭐였|누구|무엇|뭔데|기억나|알아)/.test(text)) return null
  const t = text.trim().replace(/[.!?。]+$/, '')
  // 이름은 길게 잡고(greedy), 받침 뒤에 붙는 '이/으'(카렌이야, 카렌으로)는 떼어 낸다
  const pats = [
    /(?:너|네|니|당신)(?:의)?\s*이름(?:은|을|이)?\s*(?:이제(?:부터)?|앞으로)?\s*["'“]?(.+)["'”]?\s*(?:로)\s*(?:해|하자|할게|바꿔|바꾸자|변경)/,
    /(?:너|네|니|당신)(?:의)?\s*이름(?:은|을|이)?\s*(?:이제(?:부터)?|앞으로)?\s*["'“]?(.+?)["'”]?\s*(?:야|이다|다|입니다|에요|예요|라고\s*할게)$/,
    /(?:너를|널|너)\s*["'“]?(.+)["'”]?\s*(?:라고|로)\s*(?:부를게|부를\s*거야|부르겠|할게)/,
    /이름(?:을)?\s*["'“]?(.+)["'”]?\s*(?:로)\s*바꿔/
  ]
  const hasBatchim = (ch: string): boolean => {
    const c = ch.charCodeAt(0) - 0xac00
    return c >= 0 && c < 11172 && c % 28 !== 0
  }
  for (const p of pats) {
    const m = p.exec(t.replace(/^(이제부터|앞으로|지금부터)\s+/, ''))
    if (!m) continue
    let name = m[1].replace(/^(헤이|hey)\s+/i, '').replace(/["'“”]/g, '').trim()
    // "카렌이"(야) / "카렌으"(로) / "금요일이"(라고) → 받침 뒤 조사 앞부분 제거
    if (name.length >= 2 && /[이으]$/.test(name) && hasBatchim(name[name.length - 2])) name = name.slice(0, -1)
    if (name && name.length <= 12 && !/\s{2,}/.test(name) && !/^(뭐|누구|무엇)$/.test(name)) return name
  }
  return null
}
