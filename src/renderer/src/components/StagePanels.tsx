// 홀로그램 위에 떠 있는 팝업 창: JARVIS 내장 브라우저 / 테스트 기기(아이폰 시뮬레이터·안드로이드 에뮬레이터)
// 끌어서 이동, 모서리로 크기 조절, 닫기. 위치/크기는 기억한다.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

export type PopupKind = 'browser' | 'device'
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

const DEFAULTS: Record<PopupKind, Rect> = {
  browser: { x: 290, y: 70, w: 760, h: 620 },
  device: { x: 640, y: 60, w: 380, h: 760 }
}

export function loadRect(kind: PopupKind): Rect {
  try {
    const r = JSON.parse(localStorage.getItem(`jarvis.popup.${kind}`) ?? 'null') as Rect | null
    if (r && r.w > 200 && r.h > 200) return r
  } catch {
    /* ignore */
  }
  return DEFAULTS[kind]
}

/** 두 사각형이 겹치는지 */
export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

export function FloatingWindow({
  kind,
  title,
  rect,
  z,
  onRect,
  onFocus,
  onClose,
  children,
  testid
}: {
  kind: PopupKind
  title: ReactNode
  rect: Rect
  z: number
  onRect: (r: Rect) => void
  onFocus: () => void
  onClose: () => void
  children: ReactNode
  testid: string
}): ReactNode {
  const drag = useRef<{ mode: 'move' | 'resize'; sx: number; sy: number; r: Rect } | null>(null)
  const begin = (mode: 'move' | 'resize') => (e: React.MouseEvent): void => {
    e.preventDefault()
    onFocus()
    drag.current = { mode, sx: e.clientX, sy: e.clientY, r: rect }
    const move = (ev: MouseEvent): void => {
      const d = drag.current
      if (!d) return
      const dx = ev.clientX - d.sx
      const dy = ev.clientY - d.sy
      const W = window.innerWidth
      const H = window.innerHeight
      if (d.mode === 'move') onRect({ ...d.r, x: Math.min(Math.max(0, d.r.x + dx), W - 120), y: Math.min(Math.max(36, d.r.y + dy), H - 60) })
      else onRect({ ...d.r, w: Math.max(260, d.r.w + dx), h: Math.max(260, d.r.h + dy) })
    }
    const up = (): void => {
      drag.current = null
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      localStorage.setItem(`jarvis.popup.${kind}`, JSON.stringify(rectRef.current))
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  const rectRef = useRef(rect)
  rectRef.current = rect
  return (
    <div className="popup" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, zIndex: z }} onMouseDown={onFocus} data-testid={testid}>
      <div className="popup-head" onMouseDown={begin('move')}>
        <span className="popup-title">{title}</span>
        <button className="popup-x" onMouseDown={(e) => e.stopPropagation()} onClick={onClose} title="닫기" data-testid={`${testid}-close`}>
          ✕
        </button>
      </div>
      <div className="popup-body">{children}</div>
      <div className="popup-resize" onMouseDown={begin('resize')} />
    </div>
  )
}

type BState = { open: boolean; url: string; title: string; canGoBack: boolean; canGoForward: boolean; loading: boolean }

/** 브라우저 팝업 — 네이티브 WebContentsView 가 본문 영역에 겹쳐진다. hidden 이면 뷰를 숨긴다 (모달/다른 팝업에 가릴 때) */
export function BrowserPopup({ rect, z, hidden, onRect, onFocus, onClose }: { rect: Rect; z: number; hidden: boolean; onRect: (r: Rect) => void; onFocus: () => void; onClose: () => void }): ReactNode {
  const host = useRef<HTMLDivElement>(null)
  const [st, setSt] = useState<BState>({ open: false, url: '', title: '', canGoBack: false, canGoForward: false, loading: false })
  const [url, setUrl] = useState('')
  useEffect(() => {
    void window.jarvis.browser.state().then(setSt)
    return window.jarvis.browser.onState((s) => {
      setSt(s)
      setUrl(s.url)
    })
  }, [])
  const report = useCallback(() => {
    const el = host.current
    if (hidden || !el || !st.open) return void window.jarvis.browser.setBounds(null)
    const r = el.getBoundingClientRect()
    void window.jarvis.browser.setBounds({ x: r.left, y: r.top, width: r.width, height: r.height })
  }, [hidden, st.open])
  useEffect(() => {
    report()
  }, [report, rect])
  useEffect(() => {
    window.addEventListener('resize', report)
    return () => {
      window.removeEventListener('resize', report)
      void window.jarvis.browser.setBounds(null)
    }
  }, [report])

  return (
    <FloatingWindow kind="browser" testid="browser-panel" title={<>🌐 {st.title || 'JARVIS 브라우저'}</>} rect={rect} z={z} onRect={onRect} onFocus={onFocus} onClose={onClose}>
      <div className="bbar">
        <button className="btn btn-ghost btn-xs" disabled={!st.canGoBack} onClick={() => void window.jarvis.browser.back()}>
          ←
        </button>
        <button className="btn btn-ghost btn-xs" disabled={!st.canGoForward} onClick={() => void window.jarvis.browser.forward()}>
          →
        </button>
        <button className="btn btn-ghost btn-xs" onClick={() => void window.jarvis.browser.reload()}>
          {st.loading ? '…' : '⟳'}
        </button>
        <input
          className="burl"
          value={url}
          placeholder="주소 입력"
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void window.jarvis.browser.navigate(url)
          }}
        />
      </div>
      <div ref={host} className="bview">
        {!st.open && <div className="bempty">주소를 입력하거나 "깃허브 열어줘"라고 말씀하세요.</div>}
      </div>
    </FloatingWindow>
  )
}

type DStatus = { platform: 'ios' | 'android' | null; state: 'booting' | 'running' | 'stopped' | 'error'; name?: string; log?: string }

export function DevicePopup({ rect, z, onRect, onFocus, onClose }: { rect: Rect; z: number; onRect: (r: Rect) => void; onFocus: () => void; onClose: () => void }): ReactNode {
  const [frame, setFrame] = useState<string | null>(null)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const [status, setStatus] = useState<DStatus>({ platform: null, state: 'stopped' })
  const [choices, setChoices] = useState<Array<{ platform: 'ios' | 'android'; id: string; label: string }>>([])
  const [txt, setTxt] = useState('')
  const img = useRef<HTMLImageElement>(null)
  const drag = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    void window.jarvis.device.choices().then(setChoices)
    const a = window.jarvis.device.onFrame((f) => {
      setFrame(`data:image/png;base64,${f.data}`)
      if (f.size) setSize(f.size)
    })
    const b = window.jarvis.device.onStatus((s) => {
      setStatus(s)
      if (s.state === 'stopped') setFrame(null)
    })
    // 팝업이 열려 있는 동안만 스트리밍
    void window.jarvis.device.stream(true)
    return () => {
      a()
      b()
      void window.jarvis.device.stream(false)
    }
  }, [])

  const toDevice = (cx: number, cy: number): { x: number; y: number } | null => {
    const el = img.current
    if (!el || !size) return null
    const r = el.getBoundingClientRect()
    const scale = Math.min(r.width / size.width, r.height / size.height)
    const ox = r.left + (r.width - size.width * scale) / 2
    const oy = r.top + (r.height - size.height * scale) / 2
    const x = (cx - ox) / scale
    const y = (cy - oy) / scale
    return x < 0 || y < 0 || x > size.width || y > size.height ? null : { x, y }
  }
  const running = status.state === 'running'
  const label = status.platform === 'ios' ? '아이폰' : status.platform === 'android' ? '안드로이드' : '기기'

  return (
    <FloatingWindow kind="device" testid="device-panel" title={<>📱 {status.name ?? '테스트 기기'}</>} rect={rect} z={z} onRect={onRect} onFocus={onFocus} onClose={onClose}>
      <div className="bbar">
        <span className="muted small">{running ? `${label} 실행 중` : status.state === 'booting' ? `부팅 중… ${status.log ?? ''}` : status.state === 'error' ? status.log : '꺼짐'}</span>
        <span style={{ flex: 1 }} />
        {running && (
          <>
            {status.platform === 'android' && (
              <button className="btn btn-ghost btn-xs" onClick={() => void window.jarvis.device.key('back')}>
                ◁
              </button>
            )}
            <button className="btn btn-ghost btn-xs" data-testid="device-home" onClick={() => void window.jarvis.device.key('home')}>
              ○
            </button>
            <button className="btn btn-ghost btn-xs" onClick={() => void window.jarvis.device.stop()}>
              끄기
            </button>
          </>
        )}
      </div>
      <div className="eview" data-state={status.state}>
        {frame ? (
          <img
            ref={img}
            src={frame}
            data-testid="device-screen"
            draggable={false}
            onMouseDown={(e) => {
              e.stopPropagation()
              drag.current = { x: e.clientX, y: e.clientY }
            }}
            onMouseUp={(e) => {
              const d = drag.current
              drag.current = null
              if (!d) return
              const a = toDevice(d.x, d.y)
              const b = toDevice(e.clientX, e.clientY)
              if (!a || !b) return
              if (Math.hypot(b.x - a.x, b.y - a.y) < 15) void window.jarvis.device.tap(b.x, b.y)
              else void window.jarvis.device.swipe(a.x, a.y, b.x, b.y)
            }}
          />
        ) : status.state === 'booting' ? (
          <div className="bempty">부팅 중…</div>
        ) : (
          <div className="dchoices">
            <div className="muted small">띄울 기기를 고르거나 "아이폰 시뮬레이터 띄워줘"라고 말씀하세요.</div>
            {choices.map((c) => (
              <button key={`${c.platform}:${c.id}`} className="btn btn-xs" onClick={() => void window.jarvis.device.startChoice(c.platform, c.id)}>
                {c.platform === 'ios' ? '' : '🤖 '}
                {c.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {running && (
        <div className="row etext">
          <input
            value={txt}
            onChange={(e) => setTxt(e.target.value)}
            placeholder="기기에 텍스트 입력"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && txt) {
                void window.jarvis.device.text(txt)
                setTxt('')
              }
            }}
          />
        </div>
      )}
    </FloatingWindow>
  )
}
