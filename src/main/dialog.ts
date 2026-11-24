// 대화 흐름 이어 주기 — 빠른 대화 모델과 에이전트 세션은 각자 자기가 답한 것만 기억한다.
// 다른 경로(목소리 바꾸기·질문·다른 세션)로 오간 말을 다음 요청 앞에 붙여 "그거", "그렇게 해줘"를 이해하게 한다.
export interface DialogEntry {
  user: string
  jarvis: string
  /** 누가 답했는지: 'fast' | 'agent:<프로젝트|general>' | 'local' */
  lane: string
}

export class DialogContext {
  private entries: DialogEntry[] = []
  private seen = new Map<string, number>()
  constructor(private readonly max = 12) {}

  add(e: DialogEntry): void {
    this.entries.push({ ...e, jarvis: e.jarvis.slice(0, 600) })
    while (this.entries.length > this.max) {
      this.entries.shift()
      for (const [k, v] of this.seen) this.seen.set(k, Math.max(0, v - 1))
    }
  }

  /** 최근 n 개를 글로 (문맥 보정용) */
  recentText(n: number, name: string): string {
    return this.entries
      .slice(-n)
      .map((d) => `사용자: ${d.user}\n${name}: ${d.jarvis.slice(0, 200)}`)
      .join('\n')
  }

  last(): DialogEntry | null {
    return [...this.entries].reverse().find((d) => d.jarvis.trim()) ?? null
  }

  /** lane 이 아직 모르는(자기가 답하지 않은) 최근 대화 최대 4개를 앞에 붙인다 */
  wrap(text: string, lane: string, name: string): string {
    const unseen = this.entries
      .slice(this.seen.get(lane) ?? 0)
      .filter((d) => d.lane !== lane && (d.jarvis || d.user))
      .slice(-4)
    this.seen.set(lane, this.entries.length)
    if (!unseen.length) return text
    const lines = unseen.map((d) => `사용자: ${d.user}\n${name}: ${d.jarvis || '(처리 중이었음)'}`).join('\n')
    return `[참고: 방금까지 주고받은 대화 — "그거", "그렇게 해줘" 같은 말은 이 흐름을 이어서 이해한다]\n${lines}\n\n[지금 사용자 말]\n${text}`
  }
}
