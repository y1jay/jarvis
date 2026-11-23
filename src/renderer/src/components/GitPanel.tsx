import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { GitCommitInfo, GitStatus } from '../../../shared/types'

const label = (f: { index: string; worktree: string }): string => {
  if (f.index === '?') return 'U'
  const c = f.index !== '.' ? f.index : f.worktree
  return c === '.' ? '' : c
}

export function GitPanel({ refreshKey, notify }: { refreshKey: number; notify: (m: string, err?: boolean) => void }): ReactNode {
  const [st, setSt] = useState<GitStatus | null>(null)
  const [log, setLog] = useState<GitCommitInfo[]>([])
  const [diff, setDiff] = useState<{ path: string; text: string } | null>(null)
  const [msg, setMsg] = useState('')
  const [working, setWorking] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const [s, l] = await Promise.all([window.jarvis.git.status(), window.jarvis.git.log(15)])
    setSt(s)
    setLog(l)
  }, [])
  useEffect(() => {
    void refresh()
  }, [refresh, refreshKey])

  if (!st) return <div className="panel-pad">불러오는 중…</div>
  if (!st.isRepo) return <div className="panel-pad muted">현재 폴더는 Git 저장소가 아닙니다. 왼쪽에서 프로젝트를 여세요.</div>

  const staged = st.files.filter((f) => f.index !== '.' && f.index !== '?')
  const unstaged = st.files.filter((f) => f.worktree !== '.' || f.index === '?')

  const run = async (name: string, fn: () => Promise<void>): Promise<void> => {
    setWorking(name)
    try {
      await fn()
    } catch (e) {
      notify((e as Error).message, true)
    } finally {
      setWorking(null)
      void refresh()
    }
  }

  const showDiff = async (path: string, staged: boolean): Promise<void> => setDiff({ path, text: await window.jarvis.git.diff({ path, staged }) })

  return (
    <div className="git">
      <div className="git-head">
        <span className="git-branch">⎇ {st.branch}</span>
        {st.upstream && (
          <span className="muted">
            {st.upstream} ↑{st.ahead} ↓{st.behind}
          </span>
        )}
        <button className="btn btn-ghost btn-xs" onClick={() => void refresh()}>
          새로고침
        </button>
      </div>

      <div className="git-section">
        <div className="git-title">
          스테이징됨 ({staged.length})
          {staged.length > 0 && (
            <button className="btn btn-ghost btn-xs" onClick={() => run('unstage', async () => void (await window.jarvis.git.unstage(staged.map((f) => f.path))))}>
              전체 내리기
            </button>
          )}
        </div>
        {staged.map((f) => (
          <div key={'s' + f.path} className="git-file">
            <span className={`git-badge b-${label(f)}`}>{label(f)}</span>
            <button className="git-path" onClick={() => void showDiff(f.path, true)}>{f.path}</button>
            <button className="btn btn-ghost btn-xs" onClick={() => run('unstage', async () => void (await window.jarvis.git.unstage([f.path])))}>−</button>
          </div>
        ))}
      </div>

      <div className="git-section">
        <div className="git-title">
          변경됨 ({unstaged.length})
          {unstaged.length > 0 && (
            <button className="btn btn-ghost btn-xs" onClick={() => run('stage', async () => void (await window.jarvis.git.stage(unstaged.map((f) => f.path))))}>
              전체 올리기
            </button>
          )}
        </div>
        {unstaged.map((f) => (
          <div key={'u' + f.path} className="git-file">
            <span className={`git-badge b-${f.index === '?' ? 'U' : f.worktree}`}>{f.index === '?' ? 'U' : f.worktree}</span>
            <button className="git-path" onClick={() => void showDiff(f.path, false)}>{f.path}</button>
            <button className="btn btn-ghost btn-xs" onClick={() => run('stage', async () => void (await window.jarvis.git.stage([f.path])))}>+</button>
          </div>
        ))}
      </div>

      <div className="git-commit">
        <textarea value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="커밋 메시지" rows={3} data-testid="commit-msg" />
        <div className="row">
          <button
            className="btn btn-ghost"
            disabled={!!working}
            onClick={() =>
              run('suggest', async () => {
                setMsg(await window.jarvis.git.suggestMessage())
              })
            }
          >
            {working === 'suggest' ? 'AI 작성 중…' : '✦ AI 메시지'}
          </button>
          <button
            className="btn btn-primary"
            data-testid="commit-btn"
            disabled={!!working || !msg.trim() || staged.length === 0}
            onClick={() =>
              run('commit', async () => {
                const r = await window.jarvis.git.commit(msg)
                if (r.code === 0) {
                  notify(`커밋 완료 ${r.hash?.slice(0, 7) ?? ''}`)
                  setMsg('')
                } else notify(r.stderr || '커밋 실패', true)
              })
            }
          >
            커밋 (확인)
          </button>
          <button
            className="btn"
            disabled={!!working}
            onClick={() =>
              run('push', async () => {
                const r = await window.jarvis.git.push()
                if (r.code === 0) notify('푸시 완료')
                else notify(r.stderr || '푸시 실패', true)
              })
            }
          >
            {working === 'push' ? '푸시 중…' : '푸시 (확인)'}
          </button>
        </div>
      </div>

      {diff && (
        <div className="git-diff">
          <div className="git-title">
            {diff.path}
            <button className="btn btn-ghost btn-xs" onClick={() => setDiff(null)}>닫기</button>
          </div>
          <pre>
            {diff.text.split('\n').map((l, i) => (
              <div key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'd-add' : l.startsWith('-') && !l.startsWith('---') ? 'd-del' : l.startsWith('@@') ? 'd-hunk' : ''}>
                {l || ' '}
              </div>
            ))}
          </pre>
        </div>
      )}

      <div className="git-section">
        <div className="git-title">최근 커밋</div>
        {log.map((c) => (
          <div key={c.hash} className="git-log">
            <span className="git-hash">{c.hash.slice(0, 7)}</span>
            <span className="git-subj">{c.subject}</span>
            <span className="muted">{c.author}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
