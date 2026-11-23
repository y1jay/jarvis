// 의존성 없는 최소 마크다운 렌더러 (코드블록 / 인라인코드 / 굵게 / 제목 / 목록). HTML 은 렌더링하지 않는다.
import { Fragment, type ReactNode } from 'react'

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const t = m[0]
    if (t.startsWith('`')) out.push(<code key={`${key}-${i++}`}>{t.slice(1, -1)}</code>)
    else out.push(<strong key={`${key}-${i++}`}>{t.slice(2, -2)}</strong>)
    last = m.index + t.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export function Markdown({ text }: { text: string }): ReactNode {
  const parts = text.split(/(```[\s\S]*?(?:```|$))/g)
  return (
    <div className="md">
      {parts.map((p, pi) => {
        if (p.startsWith('```')) {
          const body = p.replace(/^```[^\n]*\n?/, '').replace(/```$/, '')
          const lang = /^```(\S*)/.exec(p)?.[1]
          return (
            <pre key={pi} data-lang={lang || undefined}>
              <code>{body}</code>
            </pre>
          )
        }
        const lines = p.split('\n')
        return (
          <Fragment key={pi}>
            {lines.map((l, li) => {
              const k = `${pi}-${li}`
              if (!l.trim()) return <div key={k} className="md-gap" />
              const h = /^(#{1,4})\s+(.*)$/.exec(l)
              if (h) return <div key={k} className={`md-h md-h${h[1].length}`}>{inline(h[2], k)}</div>
              const li_ = /^\s*([-*+]|\d+\.)\s+(.*)$/.exec(l)
              if (li_) return <div key={k} className="md-li"><span className="md-bullet">{/\d/.test(li_[1]) ? li_[1] : '▸'}</span><span className="md-li-body">{inline(li_[2], k)}</span></div>
              return <div key={k} className="md-p">{inline(l, k)}</div>
            })}
          </Fragment>
        )
      })}
    </div>
  )
}
