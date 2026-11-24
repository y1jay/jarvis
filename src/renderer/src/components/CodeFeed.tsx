// 코드 흐름: JARVIS 가 코드를 고칠 때 바뀌는 코드만 홀로그램 위에 터미널처럼 줄줄이 흘려 보여 준다.
//   ─ 파일 이름 ─
//   - 지워진 줄 (빨강)
//   + 새로 쓴 줄 (초록)
import { useEffect, useRef, type ReactNode } from 'react'

export interface FeedLine {
  kind: 'file' | 'del' | 'add' | 'ctx' | 'more'
  text: string
  /** 화면에 붙일 때 매기는 번호 (새 줄만 올라오는 효과가 나도록) */
  id?: number
}

const MAX_PER_CHANGE = 160

function lines(s: unknown): string[] {
  return typeof s === 'string' ? s.replace(/\r\n/g, '\n').split('\n') : []
}

/** 바꾼 부분만: 앞뒤로 같은 줄은 빼고 달라진 줄만 */
function diff(oldS: unknown, newS: unknown): FeedLine[] {
  const a = lines(oldS)
  const b = lines(newS)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let ea = a.length - 1
  let eb = b.length - 1
  while (ea >= start && eb >= start && a[ea] === b[eb]) {
    ea--
    eb--
  }
  const out: FeedLine[] = []
  for (let i = start; i <= ea; i++) out.push({ kind: 'del', text: a[i] })
  for (let i = start; i <= eb; i++) out.push({ kind: 'add', text: b[i] })
  return out
}

function cap(l: FeedLine[]): FeedLine[] {
  return l.length > MAX_PER_CHANGE ? [...l.slice(0, MAX_PER_CHANGE), { kind: 'more', text: `… ${l.length - MAX_PER_CHANGE}줄 더` }] : l
}

const short = (p: unknown): string => String(p ?? '').split(/[\\/]/).slice(-3).join('/')

/** 도구 사용 → 보여 줄 코드 줄들 (코드 수정이 아니면 빈 배열) */
export function toFeedLines(tool: string, input: unknown): FeedLine[] {
  const i = (input ?? {}) as Record<string, unknown>
  if (tool === 'Edit') return [{ kind: 'file', text: short(i.file_path) }, ...cap(diff(i.old_string, i.new_string))]
  if (tool === 'MultiEdit') {
    const edits = Array.isArray(i.edits) ? (i.edits as Array<Record<string, unknown>>) : []
    return [{ kind: 'file', text: short(i.file_path) }, ...cap(edits.flatMap((e) => diff(e.old_string, e.new_string)))]
  }
  if (tool === 'Write') return [{ kind: 'file', text: `${short(i.file_path)} (새로 씀)` }, ...cap(lines(i.content).map((t) => ({ kind: 'add' as const, text: t })))]
  return []
}

export function CodeFeed({ lines: feed }: { lines: FeedLine[] }): ReactNode {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = box.current
    if (el) el.scrollTop = el.scrollHeight
  }, [feed.length])
  // 창 없이 글자만: 아래에서 올라오고 위로 갈수록 흐려진다 (홀로그램은 그대로 만질 수 있게 마우스는 통과)
  return (
    <div className="code-rain" data-testid="code-feed" ref={box}>
      <div className="code-rain-lines">
        {feed.map((l, i) => (
          <div key={l.id ?? i} className={`cf-${l.kind}`}>
            {l.kind === 'file' ? `── ${l.text} ──` : l.kind === 'del' ? `- ${l.text}` : l.kind === 'add' ? `+ ${l.text}` : l.text}
          </div>
        ))}
      </div>
    </div>
  )
}
