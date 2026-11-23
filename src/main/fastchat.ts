// 빠른 대화 경로: 도구가 필요 없는 질문·대화는 가벼운 모델(Sonnet)로 바로 답한다 (첫 글자 약 1초).
// 도구(파일·앱·웹·git 등)가 필요하다고 판단하면 [[AGENT]] 만 답하고 → 전체 에이전트로 넘긴다.
import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { claudeBinary } from './cli'

export const AGENT_TOKEN = '[[AGENT]]'

/** 분명히 도구가 필요한 요청 (빠른 경로를 건너뛰고 바로 에이전트로) */
const ACTION = /(파일|폴더|프로젝트|코드|함수|버그|에러|오류|테스트|빌드|배포|출시|커밋|푸시|브랜치|깃|git|PR|풀\s*리퀘|레포|저장소|설치|실행해|돌려|열어|닫아|켜|꺼|띄워|보내|전송|메시지|카톡|슬랙|메일|로그인|검색해|찾아|확인해|조회|수정해|고쳐|만들어|작성해|추가해|삭제|지워|바꿔|변경해|정리해|읽어|요약해|분석해|스크린샷|화면|클릭|입력해|다운로드|업로드|브라우저|사이트|웹|앱|에뮬|시뮬|터미널|명령|스크립트|README|\.(ts|js|py|md|json|tsx))/i

export function needsAgent(text: string): boolean {
  return ACTION.test(text)
}

const SYSTEM = (name: string, extra: string): string =>
  [
    `너는 ${name}, 사용자의 데스크톱 음성 비서다. 사용자는 말로 묻고 너는 소리 내어 답한다.`,
    '한국어로 1~3문장, 귀로 듣기 좋게 짧고 자연스럽게 답한다. 마크다운·목록·코드블록을 쓰지 않는다.',
    `파일/폴더/코드/앱/웹사이트/메시지 전송/검색 등 컴퓨터에서 실제로 무언가를 해야 하는 요청이면 다른 말 없이 정확히 ${AGENT_TOKEN} 만 출력한다.`,
    '최신 정보(날씨, 뉴스, 시세 등)가 필요한 질문도 정확히 ' + AGENT_TOKEN + ' 만 출력한다.',
    extra
  ]
    .filter(Boolean)
    .join('\n')

class Queue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = []
  private wake: ((r: IteratorResult<SDKUserMessage>) => void) | null = null
  push(m: SDKUserMessage): void {
    if (this.wake) {
      const w = this.wake
      this.wake = null
      w({ value: m, done: false })
    } else this.items.push(m)
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return { next: () => (this.items.length ? Promise.resolve({ value: this.items.shift()!, done: false }) : new Promise((r) => (this.wake = r))) }
  }
}

export class FastChat {
  private q: Query | null = null
  private it: AsyncIterator<unknown> | null = null
  private input: Queue | null = null
  private key = ''
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly opts: { env: () => NodeJS.ProcessEnv; name: () => string; memory: () => string; model: () => string; cwd: () => string }) {}

  private ensure(): void {
    const key = JSON.stringify([this.opts.name(), this.opts.memory(), this.opts.model(), this.opts.env().ANTHROPIC_API_KEY ? 'k' : 'l'])
    if (this.q && this.key === key) return
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
        includePartialMessages: true,
        systemPrompt: SYSTEM(this.opts.name(), this.opts.memory()),
        pathToClaudeCodeExecutable: claudeBinary(),
        env: { ...process.env, ...this.opts.env() }
      }
    })
    this.it = this.q[Symbol.asyncIterator]()
    this.key = key
  }

  /** 앱 시작 시 미리 프로세스를 띄워 첫 대답 지연을 줄인다 */
  warm(): void {
    try {
      this.ensure()
    } catch {
      /* 로그인 전 등 — 첫 질문 때 다시 시도 */
    }
  }

  close(): void {
    try {
      this.q?.close?.()
    } catch {
      /* ignore */
    }
    this.q = null
    this.it = null
    this.input = null
  }

  /**
   * 질문 → 스트리밍 답변. 첫 글자들이 AGENT_TOKEN 이면 null 반환 (에이전트로 넘김).
   * onDelta 는 토큰이 아님이 확정된 뒤부터 호출된다.
   */
  ask(text: string, onDelta: (t: string) => void): Promise<string | null> {
    const run = async (): Promise<string | null> => {
      this.ensure()
      this.input!.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null } as SDKUserMessage)
      let buf = ''
      let decided: 'agent' | 'chat' | null = null
      for (;;) {
        const { value, done } = await this.it!.next()
        if (done) {
          this.close()
          throw new Error('빠른 대화 경로가 종료되었습니다')
        }
        const m = value as { type: string; event?: { type: string; delta?: { type: string; text?: string } }; subtype?: string; result?: string; errors?: string[] }
        if (m.type === 'stream_event' && m.event?.type === 'content_block_delta' && m.event.delta?.type === 'text_delta') {
          buf += m.event.delta.text ?? ''
          if (!decided) {
            const t = buf.trimStart()
            if (t.startsWith(AGENT_TOKEN)) decided = 'agent'
            else if (!AGENT_TOKEN.startsWith(t.slice(0, AGENT_TOKEN.length))) {
              decided = 'chat'
              onDelta(buf)
            }
          } else if (decided === 'chat') onDelta(m.event.delta.text ?? '')
        }
        if (m.type === 'result') {
          if (m.subtype !== 'success') throw new Error((m.errors ?? []).join('\n') || String(m.subtype))
          const final = (m.result ?? buf).trim()
          if (decided === 'agent' || final.startsWith(AGENT_TOKEN)) return null
          if (!decided) onDelta(final)
          return final
        }
      }
    }
    const next = this.chain.then(run, run)
    this.chain = next.catch(() => undefined)
    return next
  }
}
