// 학습형 기록: 모든 대화를 남기고(conversations.jsonl), 대화에서 사용자 선호·사실을 추출해 기억(memory.json)하며,
// 승인 대답 표현을 학습(approval-lexicon.json)한다. 기억은 모든 세션의 시스템 프롬프트에 주입된다.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { normPhrase, type ApprovalDecision } from '../shared/approval'
import type { JobInfo, LexiconEntry, MemoryItem } from '../shared/types'

function readJson<T>(file: string, fallback: T): T {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : fallback
  } catch {
    return fallback
  }
}

function writeJson(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
}

// ── 대화 기록 (append-only) ──
export type ConversationRecord =
  | { type: 'job'; ts: string; jobId: string; provider: string; via: 'voice' | 'text'; prompt: string; answer: string; status: string; tasks: Array<{ title: string; sessionId: string; status: string; instruction: string }> }
  | { type: 'turn'; ts: string; sessionId: string; title: string; provider: string; project: string | null; jobId?: string; prompt: string; answer: string; isError: boolean }
  | { type: 'approval-utterance'; ts: string; title: string; utterance: string; decision: ApprovalDecision | 'unclear'; source: string }

export class ConversationLog {
  constructor(private readonly file: string) {
    mkdirSync(dirname(file), { recursive: true })
  }
  get path(): string {
    return this.file
  }
  record(r: ConversationRecord): void {
    appendFileSync(this.file, JSON.stringify(r) + '\n', 'utf8')
  }
  /** 최근 기록 (오래된 → 최신 순) */
  recent(type: ConversationRecord['type'], limit = 50): ConversationRecord[] {
    if (!existsSync(this.file)) return []
    const lines = readFileSync(this.file, 'utf8').split('\n').filter(Boolean)
    const out: ConversationRecord[] = []
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        const r = JSON.parse(lines[i]) as ConversationRecord
        if (r.type === type) out.push(r)
      } catch {
        /* skip */
      }
    }
    return out.reverse()
  }
  count(): number {
    return existsSync(this.file) ? readFileSync(this.file, 'utf8').split('\n').filter(Boolean).length : 0
  }
}

export function jobToRecord(job: JobInfo, provider: string, via: 'voice' | 'text'): ConversationRecord {
  return {
    type: 'job',
    ts: new Date().toISOString(),
    jobId: job.id,
    provider,
    via,
    prompt: job.prompt,
    answer: job.answer ?? '',
    status: job.status,
    tasks: job.tasks.map((t) => ({ title: t.title, sessionId: t.sessionId, status: t.status, instruction: t.instruction }))
  }
}

// ── 기억 ──
const keyOf = (s: string): string => s.toLowerCase().replace(/[\s.,!?~"'`]/g, '')

export class MemoryStore {
  private items: MemoryItem[]
  constructor(private readonly file: string) {
    this.items = readJson<MemoryItem[]>(file, [])
  }
  list(): MemoryItem[] {
    return this.items.map((i) => ({ ...i }))
  }
  /** 중복(정규화 동일) 제외하고 추가된 것만 반환 */
  add(items: Array<{ text: string; category?: MemoryItem['category'] }>, source: string): MemoryItem[] {
    const added: MemoryItem[] = []
    for (const it of items) {
      const text = it.text?.trim()
      if (!text || text.length > 300) continue
      if (this.items.some((x) => keyOf(x.text) === keyOf(text))) continue
      const m: MemoryItem = { id: randomUUID(), text, category: it.category ?? 'fact', source, createdAt: new Date().toISOString() }
      this.items.push(m)
      added.push(m)
    }
    if (added.length) writeJson(this.file, this.items)
    return added
  }
  remove(id: string): MemoryItem | null {
    const i = this.items.findIndex((x) => x.id === id)
    if (i < 0) return null
    const [m] = this.items.splice(i, 1)
    writeJson(this.file, this.items)
    return m
  }
  /** 시스템 프롬프트에 넣을 텍스트 (최신 80개) */
  asPrompt(): string {
    if (!this.items.length) return ''
    const lines = this.items.slice(-80).map((m) => `- [${m.category}] ${m.text}`)
    return ['[JARVIS 기억 — 이전 대화에서 학습한 사용자 정보. 참고하되, 현재 지시가 우선]', ...lines].join('\n')
  }
}

export function extractMemoryPrompt(prompt: string, answer: string, existing: MemoryItem[]): string {
  return [
    '너는 JARVIS 의 기억 관리자다. 아래 대화에서 앞으로도 유용한 "사용자에 대한 지속적인 정보"만 뽑는다.',
    '대상: 사용자 선호(언어/스타일/도구/커밋 습관), 반복되는 작업 방식, 프로젝트에 대한 사실(역할, 스택, 경로, 관계), 사용자가 명시적으로 기억하라고 한 것.',
    '제외: 일회성 요청 내용, 이미 기억에 있는 것, 비밀번호/토큰/개인 식별 민감정보, 추측.',
    '출력은 JSON 하나만: {"add":[{"text":"한국어 한 문장","category":"preference|habit|project|fact"}]} — 없으면 {"add":[]}',
    '',
    '[이미 기억하는 것]',
    ...existing.slice(-60).map((m) => `- ${m.text}`),
    '',
    `[사용자] ${prompt.slice(0, 3000)}`,
    `[JARVIS] ${answer.slice(0, 3000)}`
  ].join('\n')
}

export function parseMemoryExtraction(raw: string): Array<{ text: string; category: MemoryItem['category'] }> {
  const m = /\{[\s\S]*\}/.exec(raw)
  if (!m) return []
  try {
    const j = JSON.parse(m[0]) as { add?: Array<{ text?: unknown; category?: unknown }> }
    const cats = ['preference', 'habit', 'project', 'fact'] as const
    return (j.add ?? [])
      .filter((x) => typeof x.text === 'string' && x.text.trim())
      .slice(0, 10)
      .map((x) => ({ text: String(x.text).trim(), category: (cats as readonly string[]).includes(String(x.category)) ? (x.category as MemoryItem['category']) : 'fact' }))
  } catch {
    return []
  }
}

// ── 승인 표현 학습 사전 ──
export class ApprovalLexicon {
  private entries: LexiconEntry[]
  constructor(private readonly file: string) {
    this.entries = readJson<LexiconEntry[]>(file, [])
  }
  list(): LexiconEntry[] {
    return this.entries.map((e) => ({ ...e }))
  }
  lookup(utterance: string): LexiconEntry | null {
    const k = normPhrase(utterance)
    return this.entries.find((e) => e.phrase === k) ?? null
  }
  /** 학습. 사용자가 직접 정한 것(user)은 AI 판정보다 우선. 반환: 새로 배웠거나 바뀐 항목 */
  learn(utterance: string, decision: ApprovalDecision, source: LexiconEntry['source']): LexiconEntry | null {
    const k = normPhrase(utterance)
    if (!k || k.length > 40) return null
    const e = this.entries.find((x) => x.phrase === k)
    const now = new Date().toISOString()
    if (e) {
      if (e.source === 'user' && source !== 'user' && e.decision !== decision) return null
      const changed = e.decision !== decision
      e.decision = decision
      e.count++
      e.source = source === 'user' ? 'user' : e.source
      e.updatedAt = now
      writeJson(this.file, this.entries)
      return changed ? { ...e } : null
    }
    const n: LexiconEntry = { phrase: k, example: utterance.trim(), decision, source, count: 1, updatedAt: now }
    this.entries.push(n)
    writeJson(this.file, this.entries)
    return { ...n }
  }
  remove(phrase: string): boolean {
    const i = this.entries.findIndex((e) => e.phrase === phrase)
    if (i < 0) return false
    this.entries.splice(i, 1)
    writeJson(this.file, this.entries)
    return true
  }
}
