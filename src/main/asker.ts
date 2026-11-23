// JARVIS 가 작업 도중 사용자에게 되묻기 (선택지 / 자유 답변 / 비밀값).
// 비밀값(비밀번호, 인증번호)은 AI 에게 전달되지 않고, 이력에도 남지 않는다.
import { randomUUID } from 'node:crypto'

export type QuestionKind = 'choice' | 'text' | 'secret' | 'code'

export interface Question {
  id: string
  text: string
  kind: QuestionKind
  options?: string[]
  /** 어느 세션/작업에서 물었는지 */
  from?: string
  createdAt: number
}

export interface AskerHost {
  show: (q: Question) => boolean
  hide: (id: string) => void
  audit: (asked: Question, answer: string | null) => void
}

export class Asker {
  private pending = new Map<string, { q: Question; resolve: (v: string | null) => void; timer: NodeJS.Timeout }>()
  constructor(private readonly host: AskerHost) {}

  ask(text: string, opts: { kind?: QuestionKind; options?: string[]; from?: string; timeoutMs?: number } = {}): Promise<string | null> {
    const q: Question = { id: randomUUID(), text, kind: opts.kind ?? (opts.options?.length ? 'choice' : 'text'), options: opts.options, from: opts.from, createdAt: Date.now() }
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.answer(q.id, null), opts.timeoutMs ?? 15 * 60_000)
      this.pending.set(q.id, { q, resolve, timer })
      if (!this.host.show(q)) this.answer(q.id, null)
    })
  }

  answer(id: string, value: string | null): boolean {
    const p = this.pending.get(id)
    if (!p) return false
    clearTimeout(p.timer)
    this.pending.delete(id)
    this.host.hide(id)
    this.host.audit(p.q, value)
    p.resolve(value)
    return true
  }

  cancelAll(): void {
    for (const id of [...this.pending.keys()]) this.answer(id, null)
  }

  list(): Question[] {
    return [...this.pending.values()].map((p) => p.q)
  }
}

/** 선택지 질문의 답 해석: "2번", "두 번째", 옵션 이름 일부, 숫자 */
export function resolveChoice(answer: string, options: string[]): string | null {
  const a = answer.trim().toLowerCase().replace(/[.!?。]+$/, '')
  if (!a) return null
  const ordinals: Record<string, number> = { 첫: 1, 하나: 1, 일: 1, 두: 2, 둘: 2, 이: 2, 세: 3, 셋: 3, 삼: 3, 네: 4, 넷: 4, 사: 4, 다섯: 5, 오: 5, 여섯: 6, 육: 6 }
  const num = /(\d+)\s*(번|번째)?/.exec(a)
  if (num && /^(\d+)\s*(번|번째)?(으로|로|요|이요|이에요)?$/.test(a.replace(/\s/g, '')) && Number(num[1]) >= 1 && Number(num[1]) <= options.length) return options[Number(num[1]) - 1]
  const ord = /^(첫|하나|두|둘|세|셋|네|넷|다섯|여섯|일|이|삼|사|오|육)\s*(번째|번)/.exec(a)
  if (ord && ordinals[ord[1]] <= options.length) return options[ordinals[ord[1]] - 1]
  const n = (s: string): string => s.toLowerCase().replace(/[\s\-_.()]/g, '')
  const exact = options.find((o) => n(o) === n(a))
  if (exact) return exact
  const contains = options.filter((o) => n(a).includes(n(o)) || n(o).includes(n(a)))
  return contains.length === 1 ? contains[0] : null
}

/** 음성으로 불러준 인증번호 정규화: "일 이 삼 사 오 육" / "123 456" → "123456" */
export function normalizeCode(answer: string): string {
  const map: Record<string, string> = { 공: '0', 영: '0', 빵: '0', 일: '1', 이: '2', 삼: '3', 사: '4', 오: '5', 육: '6', 륙: '6', 칠: '7', 팔: '8', 구: '9', 하나: '1', 둘: '2', 셋: '3', 넷: '4', 다섯: '5', 여섯: '6', 일곱: '7', 여덟: '8', 아홉: '9' }
  let s = answer.replace(/(인증\s*번호는?|코드는?|번호는?|입니다|이에요|예요|요)/g, ' ')
  for (const k of Object.keys(map).sort((a, b) => b.length - a.length)) s = s.split(k).join(map[k])
  return s.replace(/[^0-9A-Za-z]/g, '')
}
