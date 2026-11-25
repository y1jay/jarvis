// 문맥 보정: 음성 인식기가 발음이 비슷한 다른 말로 받아 적은 것을 대화 흐름·선택지·자주 쓰는 말로 바로잡는다.
// ("유난한 건 없어" → "유나 말곤 없어", "자이스 지금 역시야" → "자비스 지금 몇 시야")
// 가벼운 모델을 미리 띄워 두고(첫 대답 지연 없음) 문장만 고쳐 받는다. 시간이 넘거나 이상하면 원래 문장 그대로.
import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { claudeBinary } from './cli'
import { Queue } from './fastchat'
import { editDistance, soundKey } from '../renderer/src/voice/text'

/** 이보다 확신이 낮으면(더 음수면) 문맥 보정을 한다 — 실측: 맞게 받아 적은 문장 -0.00~-0.14, 틀린 문장 -0.14~-0.24. 맞는 말을 바꾸는 쪽이 더 해로워서 보수적으로 */
export const CORRECT_BELOW_LOGPROB = -0.16

export interface CorrectionContext {
  /** 사용자가 바로 앞에 한 명령 (그대로 반복으로 바꾸지 않게) */
  lastCommand?: string
  /** 최근 대화 ("사용자: …\nJARVIS: …") */
  recent: string
  /** 지금 묻고 있는 질문의 선택지 */
  options?: string[]
  /** 사용자가 자주 쓰는 말, 프로젝트·앱 이름 등 */
  words: string[]
  /** 호출 이름 */
  name: string
}

const SYSTEM = [
  '너는 한국어 음성 인식 결과를 바로잡는 교정기다.',
  '[받아 적은 문장]은 음성 인식기(Whisper)가 사용자의 말을 받아 적은 것이다. 블루투스 마이크·잡음 때문에 발음이 비슷한 엉뚱한 단어로 자주 틀린다.',
  '대화 맥락에 비춰 문장이 어색하거나 말이 안 되면, 발음이 비슷하면서 맥락에 맞는 말로 과감히 바로잡는다. 특히 바로 앞에서 JARVIS 가 물은 것에 대한 대답일 가능성을 먼저 생각한다.',
  '지금 묻고 있는 선택지가 있으면, 발음이 비슷한 선택지를 고른 말일 가능성이 높다.',
  '맞게 적힌 자연스러운 문장은 한 글자도 바꾸지 않는다. 말을 덧붙이거나 다듬거나 존댓말로 바꾸지 않는다.',
  '',
  '흔한 오인식 예:',
  '- "자빗스 볼륨 줄여" → "자비스 볼륨 줄여"',
  '- "시뮬래이터 키워줘" → "시뮬레이터 띄워줘"',
  '- (JARVIS: 어떤 브라우저로 열까요? 선택지: 크롬, 사파리) "크롭으로" → "크롬으로"',
  '- (JARVIS: 슬랙으로 보낼까요?) "그래 보내 줘" → "그래 보내 줘" (맞으니 그대로)',
  '- "지금 몇 실까" → "지금 몇 시야"',
  '- (JARVIS: 사진 폴더만 있어요) "사진 발고 없어?" → "사진 말고 없어?"',
  '- (JARVIS: 슬랙을 열었어요) "슬랙 가자" → "슬랙 닫아" (방금 연 걸 또 열라는 말이 아니라 발음이 가장 가까운 "닫아")',
  '열기/닫기처럼 반대되는 명령은 발음으로 가린다 (방금 연 것을 또 열라는 말로 단정하지 않는다).',
  '누가 하는지(내가/네가·니가)와 하지 말라는 말(~지 마, ~말라, 안 해)은 절대 바꾸거나 새로 넣지 않는다. "니가"는 "네가"(JARVIS 보고 하라는 말)다.',
  '들리지 않은 내용(브랜치 이름, 대상, 조건)을 대화 맥락에서 지어내 넣지 않는다. 확실하지 않으면 받아 적은 그대로 둔다.',
  '',
  '출력: 바로잡은 문장 한 줄만. 따옴표, 설명, 접두어 금지.'
].join('\n')

export function correctionPrompt(raw: string, c: CorrectionContext): string {
  return [
    c.recent ? `[대화 맥락]\n${c.recent}` : '',
    c.options?.length ? `[지금 묻고 있는 선택지] ${c.options.join(', ')}` : '',
    c.words.length ? `[사용자가 자주 쓰는 말] ${c.words.slice(0, 40).join(', ')}` : '',
    `[호출 이름] ${c.name}`,
    `[받아 적은 문장] ${raw}`
  ]
    .filter(Boolean)
    .join('\n')
}

/** 모델 출력이 '교정'으로 볼 만한지 — 너무 길어지거나 설명이 붙으면 버린다 */
export function acceptCorrection(raw: string, out: string, lastCommand?: string): string {
  const t = out.trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').split('\n')[0].trim()
  if (!t) return raw
  if (t.length > raw.length * 1.6 + 8) return raw
  if (/^(교정|수정|바로잡|정정|결과)\s*[:：]/.test(t)) return raw
  // 방금 한 명령을 그대로 반복한 것으로 바꾸면 버린다 ("슬랙 닫아"가 "슬랙 열어"로 바뀐 일이 있었다)
  const n = (x: string): string => x.replace(/[\s.,!?]/g, '')
  if (lastCommand && n(t) === n(lastCommand) && n(raw) !== n(lastCommand)) return raw
  // 잘못 들은 말은 원래 말과 발음이 비슷해야 한다 — 전혀 다른 문장으로 바꾸면 버린다 ("나쁜 거야?" → "말투가 어때?")
  const a = soundKey(raw)
  const b = soundKey(t)
  if (a.length >= 4 && b.length && 1 - editDistance(a, b) / Math.max(a.length, b.length) < 0.35) return raw
  // 사용자 말의 뜻을 뒤집으면 버린다 — "…네가 직접 해"가 "…내가 직접 해"로 바뀐 일이 있었다
  if (meaningFlipped(raw, t)) return raw
  return t
}

/** 누가 하는지(나/너), 하지 말라는 말이 바뀌었는지 */
export function meaningFlipped(raw: string, fixed: string): boolean {
  const who = (x: string): Set<string> => {
    const s = new Set<string>()
    if (/(^|\s)(내가|제가|나는|저는|내\s가)/.test(x)) s.add('me')
    if (/(^|\s)(네가|니가|너가|너는|네\s가)/.test(x)) s.add('you')
    return s
  }
  const wa = who(raw)
  const wb = who(fixed)
  for (const k of wb) if (!wa.has(k)) return true
  for (const k of wa) if (!wb.has(k)) return true
  const neg = (x: string): number => (x.match(/(지\s*마|지\s*말|말라|말아|않|안\s*해|안\s*돼|못\s*해)/g) ?? []).length
  return neg(raw) !== neg(fixed)
}

export class SpeechCorrector {
  private q: Query | null = null
  private it: AsyncIterator<unknown> | null = null
  private input: Queue | null = null
  private used = 0
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly opts: { env: () => NodeJS.ProcessEnv; model: () => string; cwd: () => string; timeoutMs?: number }) {}

  private ensure(): void {
    // 대화가 길어지면 느려지므로 일정 횟수마다 새로
    if (this.q && this.used < 30) return
    this.close()
    this.input = new Queue()
    this.q = query({
      prompt: this.input,
      options: {
        cwd: this.opts.cwd(),
        model: this.opts.model(),
        tools: [],
        settingSources: [],
        persistSession: false,
        systemPrompt: SYSTEM,
        pathToClaudeCodeExecutable: claudeBinary(),
        env: { ...process.env, ...this.opts.env() }
      }
    })
    this.it = this.q[Symbol.asyncIterator]()
    this.used = 0
  }

  warm(): void {
    try {
      this.ensure()
    } catch {
      /* 첫 교정 때 다시 */
    }
  }

  close(): void {
    this.q?.close?.()
    this.q = null
    this.it = null
    this.input = null
  }

  /** 교정된 문장 (실패·시간 초과면 원래 문장) */
  correct(raw: string, ctx: CorrectionContext): Promise<string> {
    const run = async (): Promise<string> => {
      this.ensure()
      this.used++
      this.input!.push({ type: 'user', message: { role: 'user', content: correctionPrompt(raw, ctx) }, parent_tool_use_id: null } as SDKUserMessage)
      for (;;) {
        const { value, done } = await this.it!.next()
        if (done) {
          this.close()
          return raw
        }
        const m = value as { type: string; subtype?: string; result?: string }
        if (m.type === 'result') return m.subtype === 'success' ? acceptCorrection(raw, m.result ?? '', ctx.lastCommand) : raw
      }
    }
    const job = this.chain.then(run, run)
    this.chain = job.catch(() => undefined)
    const limit = this.opts.timeoutMs ?? 2500
    return Promise.race([job.catch(() => raw), new Promise<string>((r) => setTimeout(() => r(raw), limit))])
  }
}
