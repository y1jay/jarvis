import { useEffect, useState, type ReactNode } from 'react'
import { PROVIDER_LABEL, type AuthStatus, type JarvisSettings, type ProviderId } from '../../../shared/types'

const IDS: ProviderId[] = ['claude', 'gpt', 'gemini']
const LOGIN_HINT: Record<ProviderId, string> = {
  claude: 'Claude.ai 계정 (Pro/Max) 브라우저 로그인',
  gpt: 'ChatGPT 계정 브라우저 로그인',
  gemini: 'Google 계정 브라우저 로그인'
}
const LOGOUT_WARN: Record<ProviderId, string> = {
  claude: 'Claude Code CLI 전체에서 로그아웃됩니다 (이 컴퓨터의 다른 Claude Code 세션 포함). 계속할까요?',
  gpt: 'Codex CLI 전체에서 로그아웃됩니다. 계속할까요?',
  gemini: 'JARVIS 에서 Google 로그인 연결만 해제합니다 (Gemini CLI 자격증명 파일은 유지). 계속할까요?'
}

export function ProviderPanel({ settings, onSettings, notify }: { settings: JarvisSettings; onSettings: (s: JarvisSettings) => void; notify: (m: string, err?: boolean) => void }): ReactNode {
  const [status, setStatus] = useState<Partial<Record<ProviderId, AuthStatus>>>({})
  const [busy, setBusy] = useState<ProviderId | null>(null)
  const [log, setLog] = useState<string[]>([])
  const [keyFor, setKeyFor] = useState<ProviderId | null>(null)
  const [key, setKey] = useState('')
  const [sites, setSites] = useState<Array<{ key: string; name: string; domain: string; connectedAt: string }>>([])
  const [siteQ, setSiteQ] = useState('')
  const [siteBusy, setSiteBusy] = useState(false)

  useEffect(() => {
    for (const p of IDS) void window.jarvis.auth.status(p).then((s) => setStatus((o) => ({ ...o, [p]: s })))
    void window.jarvis.sites.list().then(setSites)
    const offs = [
      window.jarvis.auth.onLog(({ line }) => setLog((l) => [...l.slice(-6), line])),
      // JARVIS 가 스스로 로그인/전환한 결과도 반영
      window.jarvis.auth.onChanged((s) => setStatus((o) => ({ ...o, [s.provider]: s }))),
      window.jarvis.sites.onChanged(setSites)
    ]
    return () => offs.forEach((f) => f())
  }, [])

  const act = async (p: ProviderId, fn: () => Promise<AuthStatus>): Promise<void> => {
    setBusy(p)
    setLog([])
    try {
      const s = await fn()
      setStatus((o) => ({ ...o, [p]: s }))
    } catch (e) {
      notify((e as Error).message, true)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="providers">
      <div className="side-title">AI 연결</div>
      {IDS.map((p) => {
        const s = status[p]
        const active = settings.provider === p
        return (
          <div key={p} className={`prov ${active ? 'prov-active' : ''}`} data-testid={`provider-${p}`}>
            <button className="prov-main" onClick={async () => onSettings(await window.jarvis.settings.update({ provider: p }))}>
              <span className={`prov-led ${s?.loggedIn ? 'led-on' : s ? 'led-off' : ''}`} />
              <span className="prov-name">{PROVIDER_LABEL[p]}</span>
              {active && <span className="prov-tag">사용 중</span>}
            </button>
            <div className="prov-sub">{s ? (s.loggedIn ? `${s.method === 'apiKey' ? 'API 키' : '로그인'}${s.account ? ` · ${s.account}` : ''}${s.detail && s.method !== 'apiKey' ? ` · ${s.detail}` : ''}` : '미연결') : '확인 중…'}</div>
            <div className="prov-actions">
              {s?.loggedIn && s.method === 'login' ? (
                <button className="btn btn-ghost btn-xs" disabled={!!busy} onClick={() => confirm(LOGOUT_WARN[p]) && act(p, () => window.jarvis.auth.logout(p))}>
                  로그아웃
                </button>
              ) : (
                <button className="btn btn-xs" disabled={!!busy} title={LOGIN_HINT[p]} onClick={() => act(p, () => window.jarvis.auth.login(p))}>
                  {busy === p ? '브라우저에서 로그인…' : '로그인'}
                </button>
              )}
              {s?.method === 'apiKey' ? (
                <button className="btn btn-ghost btn-xs" disabled={!!busy} onClick={() => act(p, () => window.jarvis.auth.clearKey(p))}>
                  키 삭제
                </button>
              ) : (
                <button className="btn btn-ghost btn-xs" onClick={() => setKeyFor(keyFor === p ? null : p)}>
                  API 키
                </button>
              )}
            </div>
            {keyFor === p && (
              <div className="prov-key">
                <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={p === 'claude' ? 'sk-ant-…' : p === 'gpt' ? 'sk-…' : 'AIza…'} />
                <button
                  className="btn btn-xs btn-primary"
                  disabled={!key.trim()}
                  onClick={() =>
                    act(p, async () => {
                      const s = await window.jarvis.auth.setKey(p, key)
                      setKey('')
                      setKeyFor(null)
                      return s
                    })
                  }
                >
                  저장
                </button>
              </div>
            )}
          </div>
        )
      })}
      <div className="side-title">웹 연결</div>
      <div className="sites" data-testid="sites">
        {sites.map((x) => (
          <div key={x.key} className="sess">
            <span className="sess-main">
              <span className="sess-led led-idle" />
              <span className="sess-title">{x.name}</span>
            </span>
            <button className="sess-x" title="연동 해제" onClick={async () => setSites(await window.jarvis.sites.logout(x.key))}>
              ×
            </button>
          </div>
        ))}
        <div className="row prov-key">
          <input value={siteQ} onChange={(e) => setSiteQ(e.target.value)} placeholder="깃허브, 노션, example.com…" />
          <button
            className="btn btn-xs"
            disabled={!siteQ.trim() || siteBusy}
            onClick={async () => {
              setSiteBusy(true)
              try {
                notify(await window.jarvis.sites.login(siteQ.trim()))
                setSiteQ('')
              } finally {
                setSiteBusy(false)
              }
            }}
          >
            {siteBusy ? '로그인 대기…' : '연결'}
          </button>
        </div>
      </div>
      {busy && log.length > 0 && (
        <div className="auth-log">
          {log.map((l, i) => (
            <div key={i}>{/https?:\/\/\S+/.test(l) ? <a href={l.match(/https?:\/\/\S+/)![0]} target="_blank" rel="noreferrer">{l}</a> : l}</div>
          ))}
        </div>
      )}
    </div>
  )
}
