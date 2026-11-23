import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { ApprovalRequest, JarvisSettings, JobInfo, SessionInfo } from '../../shared/types'
import { PROVIDER_LABEL } from '../../shared/types'
import { applyEvent, assistantTurn, userTurn, type Turn } from './lib/chat'
import { HologramScene } from './hologram/HologramScene'
import { HandTracker } from './vision/handTracker'
import type { HandState } from './vision/gestures'
import { VoiceEngine, type VoicePhase } from './voice/VoiceEngine'
import { matchWakeWord } from './voice/text'
import { ChatPanel } from './components/ChatPanel'
import { JarvisThread } from './components/JarvisThread'
import { SessionList } from './components/SessionList'
import { MemoryPanel } from './components/MemoryPanel'
import { GitPanel } from './components/GitPanel'
import { HistoryPanel } from './components/HistoryPanel'
import { ProviderPanel } from './components/ProviderPanel'
import { SettingsPanel } from './components/SettingsPanel'
import { ApprovalModal } from './components/ApprovalModal'
import { QuestionCard, type Q } from './components/QuestionCard'
import { BrowserPopup, DevicePopup, loadRect, overlaps, type PopupKind, type Rect } from './components/StagePanels'

type Tab = 'chat' | 'git' | 'history' | 'memory' | 'settings'

const PHASE_TEXT: Record<VoicePhase, string> = {
  off: '음성 꺼짐',
  loading: '음성 시스템 준비 중',
  sleeping: '"자비스" 대기 중',
  awake: '듣고 있습니다',
  recording: '듣고 있습니다',
  transcribing: '인식 중',
  speaking: '말하는 중'
}

/** 스피커로 나간 JARVIS 자기 음성(질문)을 다시 들은 경우 — 절대 승인으로 처리하면 안 됨 */
const SELF_ECHO = /(하시겠습니까|할까요|말씀해|말씀하세요|승인 요청)/

function useClock(): string {
  const [t, setT] = useState(() => new Date())
  useEffect(() => {
    const i = setInterval(() => setT(new Date()), 1000)
    return () => clearInterval(i)
  }, [])
  return t.toLocaleTimeString('ko-KR', { hour12: false })
}

export function App(): ReactNode {
  const [settings, setSettings] = useState<JarvisSettings | null>(null)
  const [jobs, setJobs] = useState<JobInfo[]>([])
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [focused, setFocused] = useState<string | null>(null)
  const [viewing, setViewing] = useState<string | null>(null)
  const [sessionTurns, setSessionTurns] = useState<Record<string, Turn[]>>({})
  const [tab, setTab] = useState<Tab>('chat')
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([])
  const [phase, setPhase] = useState<VoicePhase>('off')
  const [transcript, setTranscript] = useState('')
  const [toast, setToast] = useState<{ m: string; err?: boolean } | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [cameraOn, setCameraOn] = useState(false)
  const [hands, setHands] = useState<HandState[]>([])
  const [voiceProgress, setVoiceProgress] = useState('')
  const [platform, setPlatform] = useState('')
  const [questions, setQuestions] = useState<Q[]>([])
  // 홀로그램은 항상 기본 화면. 웹/기기는 그 위에 뜨는 팝업
  const [popups, setPopups] = useState<Record<PopupKind, boolean>>({ browser: false, device: false })
  const [rects, setRects] = useState<Record<PopupKind, Rect>>(() => ({ browser: loadRect('browser'), device: loadRect('device') }))
  const [front, setFront] = useState<PopupKind>('browser')
  const openPopup = useCallback((k: PopupKind) => {
    setPopups((p) => ({ ...p, [k]: true }))
    setFront(k)
  }, [])
  const clock = useClock()

  const stageRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const holo = useRef<HologramScene | null>(null)
  const tracker = useRef<HandTracker | null>(null)
  const voice = useRef<VoiceEngine | null>(null)
  const settingsRef = useRef<JarvisSettings | null>(null)
  settingsRef.current = settings
  const phaseRef = useRef<VoicePhase>('off')
  phaseRef.current = phase
  /** 음성 승인에서 애매했던 마지막 대답 — 이후 버튼으로 결정하면 그 표현을 학습 */
  const unclearUtterance = useRef<string | null>(null)

  const notify = useCallback((m: string, err?: boolean) => {
    setToast({ m, err })
    setTimeout(() => setToast(null), 4500)
  }, [])

  const busy = jobs.some((j) => j.status !== 'done' && j.status !== 'error') || sessions.some((s) => s.status === 'running')

  // ── 초기화 ──
  useEffect(() => {
    void window.jarvis.settings.get().then(setSettings)
    void window.jarvis.app.info().then((i) => setPlatform(i.platform))
    void window.jarvis.session.list().then(({ sessions, focused }) => {
      setSessions(sessions)
      setFocused(focused)
    })
    // 사용 가능한 TTS 목소리를 main 에 알려 둔다 ("목소리 바꿔줘" 용)
    const reportVoices = (): void => void window.jarvis.voice.report(speechSynthesis.getVoices().map((v) => ({ name: v.name, lang: v.lang })))
    reportVoices()
    speechSynthesis.addEventListener('voiceschanged', reportVoices)
    setTimeout(reportVoices, 1500)
    void window.jarvis.question.list().then(setQuestions)
    // 이전 대화 복원
    void window.jarvis.jarvis.history(30).then((h) =>
      setJobs(h.map((r) => ({ id: r.jobId, prompt: r.prompt, answer: r.answer, status: r.status === 'error' ? 'error' : 'done', tasks: r.tasks.map((t, i) => ({ id: `${r.jobId}-${i}`, sessionId: t.sessionId, title: t.title, instruction: t.instruction, status: t.status as 'done', after: [] })), notes: [], via: r.via === 'voice' ? 'voice' : 'text', createdAt: Date.parse(r.ts) })))
    )
  }, [])

  // 홀로그램은 스테이지 DOM 이 생긴 뒤(설정 로드 후) 생성
  const ready = !!settings
  useEffect(() => {
    if (!ready || !stageRef.current || holo.current) return
    holo.current = new HologramScene(stageRef.current)
    return () => {
      holo.current?.dispose()
      holo.current = null
    }
  }, [ready])

  // 작업 중이면 홀로그램 '생각' 상태
  useEffect(() => {
    const h = holo.current
    if (!h) return
    const st = h.getState()
    if (busy && (st === 'idle' || st === 'error')) h.setState('thinking')
    if (!busy && st === 'thinking') h.setState('idle')
  }, [busy])

  const speak = useCallback((text: string) => {
    const v = voice.current
    if (!v || !settingsRef.current?.voice.ttsEnabled) return
    holo.current?.setState('speaking')
    void v.speak(text).then(() => holo.current?.getState() === 'speaking' && holo.current?.setState('idle'))
  }, [])

  // ── main 이벤트 ──
  useEffect(() => {
    const offs = [
      window.jarvis.agent.onTurnStart(({ turnId, sessionId, provider, prompt }) =>
        setSessionTurns((m) => ({ ...m, [sessionId]: [...(m[sessionId] ?? []), userTurn(turnId, provider, prompt), assistantTurn(turnId, provider)] }))
      ),
      window.jarvis.agent.onEvent(({ turnId, sessionId, event }) => {
        if (event.kind === 'file-change') setRefreshKey((k) => k + 1)
        setSessionTurns((m) => ({ ...m, [sessionId]: (m[sessionId] ?? []).map((t) => (t.id === turnId ? applyEvent(t, event) : t)) }))
      }),
      window.jarvis.agent.onDone(({ turnId, sessionId }) => {
        setRefreshKey((k) => k + 1)
        setSessionTurns((m) => ({ ...m, [sessionId]: (m[sessionId] ?? []).map((t) => (t.id === turnId && !t.done ? { ...t, done: true } : t)) }))
      }),
      window.jarvis.jarvis.onJob((j) => setJobs((js) => (js.some((x) => x.id === j.id) ? js.map((x) => (x.id === j.id ? j : x)) : [...js, j]))),
      window.jarvis.jarvis.onJobDone((j) => {
        setJobs((js) => js.map((x) => (x.id === j.id ? j : x)))
        if (j.status === 'error') {
          holo.current?.setState('error')
          setTimeout(() => holo.current?.getState() === 'error' && holo.current?.setState('idle'), 2500)
        }
        if (j.answer && (j.via === 'voice' || phaseRef.current !== 'off')) speak(j.answer)
      }),
      window.jarvis.jarvis.onSpeak((t) => phaseRef.current !== 'off' && speak(t)),
      window.jarvis.session.onList(({ sessions, focused }) => {
        setSessions(sessions)
        setFocused(focused)
        setViewing((v) => (v && !sessions.some((s) => s.id === v) ? null : v))
      }),
      window.jarvis.approval.onRequest((r) => setApprovals((a) => [...a, r])),
      window.jarvis.question.onAsk((q) => setQuestions((qs) => (qs.some((x) => x.id === q.id) ? qs : [...qs, q]))),
      window.jarvis.question.onDone((id) => setQuestions((qs) => qs.filter((x) => x.id !== id))),
      window.jarvis.popup.onOpen((k) => openPopup(k)),
      window.jarvis.app.onSummon(() => void voice.current?.wake()),
      window.jarvis.settings.onChanged((s) => {
        setSettings(s)
        setRefreshKey((k) => k + 1)
      })
    ]
    return () => offs.forEach((f) => f())
  }, [speak, openPopup])

  const questionsRef = useRef<Q[]>([])
  questionsRef.current = questions
  const send = useCallback(
    async (text: string, via: 'voice' | 'text' = 'text') => {
      // JARVIS 가 질문 중이면 이 입력이 답이다 (보안 입력은 전용 칸으로만)
      const pq = questionsRef.current[0]
      if (pq && pq.kind !== 'secret') {
        await window.jarvis.question.answer(pq.id, text)
        return
      }
      setTab('chat')
      setViewing(null)
      holo.current?.setState('thinking')
      try {
        await window.jarvis.agent.send(text, via)
      } catch (e) {
        holo.current?.setState('error')
        notify((e as Error).message, true)
      }
    },
    [notify]
  )
  const sendRef = useRef(send)
  sendRef.current = send

  // ── 음성 ──
  const toggleVoice = async (): Promise<void> => {
    const s = settingsRef.current
    if (!s) return
    if (voice.current && voice.current.current !== 'off') {
      voice.current.stop()
      return
    }
    voice.current ??= new VoiceEngine(
      { model: s.voice.sttModel, language: s.voice.language, wakeWords: s.voice.wakeWords, wakeWordEnabled: s.voice.wakeWordEnabled, ttsVoice: s.voice.ttsVoice, ttsRate: s.voice.ttsRate, ttsPitch: s.voice.ttsPitch },
      {
        onPhase: (p) => {
          setPhase(p)
          if (p === 'awake' || p === 'recording') holo.current?.setState('listening')
          else if (p === 'transcribing') holo.current?.setState('thinking')
          else if ((p === 'sleeping' || p === 'off') && !['thinking', 'speaking'].includes(holo.current?.getState() ?? '')) holo.current?.setState('idle')
        },
        onLevel: (v) => holo.current?.setLevel(v),
        onTranscript: (t) => setTranscript(t),
        onCommand: (t) => void sendRef.current(t, 'voice'),
        onWake: () => {
          setTranscript('')
          void voice.current?.speak('네, 말씀하세요.')
        },
        onProgress: (m) => setVoiceProgress(m),
        onError: (m) => notify(m, true)
      }
    )
    await voice.current.start()
  }
  useEffect(() => {
    if (!settings || !voice.current) return
    voice.current.updateOptions({ wakeWords: settings.voice.wakeWords, wakeWordEnabled: settings.voice.wakeWordEnabled, ttsVoice: settings.voice.ttsVoice, ttsRate: settings.voice.ttsRate, ttsPitch: settings.voice.ttsPitch })
  }, [settings])

  // ── 카메라 + 손 추적 ──
  const toggleCamera = async (): Promise<void> => {
    if (cameraOn) {
      tracker.current?.stop()
      tracker.current = null
      const v = videoRef.current
      ;(v?.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop())
      if (v) v.srcObject = null
      holo.current?.setAnchor(null)
      setCameraOn(false)
      setHands([])
      return
    }
    try {
      await window.jarvis.media.request('camera')
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, facingMode: 'user' } })
      const v = videoRef.current!
      v.srcObject = stream
      await v.play()
      setCameraOn(true)
      const t = new HandTracker(v, overlayRef.current!, (g, hs) => {
        if (g.rotate) holo.current?.rotateBy(g.rotate.dx, g.rotate.dy)
        if (g.scale) holo.current?.scaleBy(g.scale)
        if (g.anchor !== undefined) holo.current?.setAnchor(g.anchor ? t.toContainer(g.anchor) : null)
        if (g.summon) void (voice.current ? voice.current.wake() : toggleVoice().then(() => voice.current?.wake()))
        setHands((prev) => (prev.length === hs.length && prev.every((p, i) => p.pose === hs[i].pose) ? prev : hs))
      })
      tracker.current = t
      await t.init()
      t.start()
    } catch (e) {
      notify(`카메라를 사용할 수 없습니다: ${(e as Error).message}`, true)
      setCameraOn(false)
    }
  }

  // ── 승인 (클릭 / 음성) ──
  const approvalsRef = useRef<ApprovalRequest[]>([])
  approvalsRef.current = approvals
  const respond = useCallback((approved: boolean, reason?: string, via: 'click' | 'voice' = 'click', transcript?: string): void => {
    const r = approvalsRef.current[0]
    if (!r) return
    approvalsRef.current = approvalsRef.current.slice(1)
    voice.current?.clearApproval()
    // 음성이 애매해서 버튼으로 결정했다면 → 그 표현을 학습
    if (via === 'click' && unclearUtterance.current) void window.jarvis.voice.learnApproval(unclearUtterance.current, approved ? 'approve' : 'deny')
    unclearUtterance.current = null
    void window.jarvis.approval.respond({ id: r.id, approved, reason, via, transcript })
    setApprovals((a) => a.filter((x) => x.id !== r.id))
    setRefreshKey((k) => k + 1)
  }, [])

  const pendingId = approvals[0]?.id
  useEffect(() => {
    const req = approvalsRef.current[0]
    const v = voice.current
    if (!req || !v || !v.listening) return
    const shownAt = performance.now()
    unclearUtterance.current = null
    let deciding = false
    const token = v.listenFor(async (raw) => {
      if (deciding) return
      const w = matchWakeWord(raw, settingsRef.current?.voice.wakeWords ?? [])
      const text = (w.matched ? w.command || raw : raw).trim()
      if (!text || SELF_ECHO.test(text)) return
      deciding = true
      const { decision, source } = await window.jarvis.voice.classifyApproval(text, req.title, req.detail)
      deciding = false
      if (approvalsRef.current[0]?.id !== req.id) return
      // 푸시/위험 명령은 AI 추정만으로 승인하지 않는다 → 명확한 말로 한 번 더 확인
      const risky = req.kind === 'git-push' || req.kind === 'destructive'
      if (decision === 'approve' && risky && source === 'ai') {
        unclearUtterance.current = text
        void v.speak('확인을 위해 한 번 더, 진행이면 "응", 취소면 "하지 마"라고 말씀해 주세요.')
        return
      }
      if (decision === 'approve' && performance.now() - shownAt > 800) {
        respond(true, undefined, 'voice', raw)
        void v.speak('진행하겠습니다.')
      } else if (decision === 'deny') {
        respond(false, `음성으로 거부: ${raw}`, 'voice', raw)
        void v.speak('취소했습니다.')
      } else {
        unclearUtterance.current = text
        void v.speak('잘 못 알아들었습니다. 진행이면 "응", 취소면 "하지 마"라고 해 주세요.')
      }
    })
    void v.speak(`${req.title.replace(/^\[[^\]]+\]\s*/, '')}. ${req.kind === 'tool' ? '허용하시겠습니까?' : '진행하시겠습니까?'}`)
    return () => v.release(token)
  }, [pendingId, respond])

  // ── 질문에 음성으로 답하기 (승인 창이 없을 때) ──
  const qid = questions[0]?.id
  useEffect(() => {
    const q = questionsRef.current[0]
    const v = voice.current
    if (!q || !v || !v.listening || approvalsRef.current.length || q.kind === 'secret') return
    const token = v.listenFor((raw) => {
      const w = matchWakeWord(raw, settingsRef.current?.voice.wakeWords ?? [])
      const text = (w.matched ? w.command || raw : raw).trim()
      if (!text || SELF_ECHO.test(text) || questionsRef.current[0]?.id !== q.id) return
      void window.jarvis.question.answer(q.id, text)
    })
    return () => v.release(token)
  }, [qid, approvals.length])

  const viewSession = (id: string): void => {
    setViewing(id)
    setTab('chat')
    void window.jarvis.session.focus(id)
  }

  if (!settings) return <div className="boot">J.A.R.V.I.S. 초기화 중…</div>

  const holoLabel = busy ? `처리 중${sessions.filter((x) => x.status === 'running').length > 1 ? ` · 세션 ${sessions.filter((x) => x.status === 'running').length}개 동시 작업` : ''}` : PHASE_TEXT[phase]
  const viewingSession = viewing ? sessions.find((x) => x.id === viewing) ?? null : null
  const projectName = settings.projectDir ? settings.projectDir.split(/[\\/]/).pop() : '프로젝트 없음'

  return (
    <div className={`app plat-${platform}`}>
      <div className="titlebar">
        <div className="brand">
          <span className="brand-mark">◉</span> J.A.R.V.I.S.
        </div>
        <div className="titlebar-mid">
          {PROVIDER_LABEL[settings.provider]} · {projectName}
        </div>
        {platform !== 'darwin' && platform !== 'win32' && (
          <div className="winctl">
            <button onClick={() => void window.jarvis.win.minimize()}>—</button>
            <button onClick={() => void window.jarvis.win.toggleMaximize()}>□</button>
            <button onClick={() => void window.jarvis.win.close()}>×</button>
          </div>
        )}
      </div>

      <div className="body">
        <aside className="side">
          <ProviderPanel settings={settings} onSettings={setSettings} notify={notify} />
          <div className="side-title">프로젝트</div>
          <div className="project">
            <div className="project-path" title={settings.projectDir ?? ''}>
              {settings.projectDir ?? '열린 프로젝트 없음 (일반 대화 모드)'}
            </div>
            <div className="row">
              <button className="btn btn-xs" data-testid="open-project" onClick={async () => setSettings(await window.jarvis.project.choose())}>
                폴더 열기
              </button>
              {settings.projectDir && (
                <button className="btn btn-ghost btn-xs" onClick={async () => setSettings(await window.jarvis.project.set(null))}>
                  닫기
                </button>
              )}
              <button
                className="btn btn-ghost btn-xs"
                onClick={() => {
                  void window.jarvis.agent.reset()
                  setJobs([])
                  setSessionTurns({})
                  setViewing(null)
                }}
              >
                새 대화
              </button>
            </div>
            {settings.recentProjects.length > 0 && (
              <div className="recent">
                {settings.recentProjects
                  .filter((d) => d !== settings.projectDir)
                  .slice(0, 5)
                  .map((d) => (
                    <button key={d} className="recent-item" title={d} onClick={async () => setSettings(await window.jarvis.project.set(d))}>
                      {d.split(/[\\/]/).pop()}
                    </button>
                  ))}
              </div>
            )}
          </div>
          <SessionList
            sessions={sessions}
            focused={focused}
            viewing={viewing}
            onView={viewSession}
            onNew={async () => viewSession((await window.jarvis.session.create()).id)}
            onClose={(id) => void window.jarvis.session.close(id)}
          />
        </aside>

        <main className="stage-wrap">
          <video ref={videoRef} className={`cam ${cameraOn ? 'cam-on' : ''}`} muted playsInline />
          <div className="scanlines" />
          <div ref={stageRef} className="stage" />
          <canvas ref={overlayRef} className="hand-overlay" />

          <div className="hud hud-tl">
            <div className="hud-k">SYSTEM</div>
            <div className="hud-v">{clock}</div>
            <div className="hud-k">{PROVIDER_LABEL[settings.provider].toUpperCase()}</div>
          </div>
          <div className="hud hud-tr">
            <div className="hud-k">VISION</div>
            <div className="hud-v">{cameraOn ? `${hands.length} HAND${hands.length === 1 ? '' : 'S'}` : 'OFFLINE'}</div>
            {cameraOn && <div className="hud-k">{hands.map((h) => h.pose.toUpperCase()).join(' · ') || '—'}</div>}
          </div>
          <div className="holo-label" data-testid="holo-label">
            <div className="holo-phase">{holoLabel}</div>
            {transcript && <div className="holo-transcript">“{transcript}”</div>}
            {voiceProgress && phase !== 'off' && <div className="holo-progress">{voiceProgress}</div>}
          </div>
          <div className="stage-controls">
            <button className={`orb ${phase !== 'off' ? 'orb-on' : ''}`} data-testid="mic-toggle" onClick={() => void toggleVoice()} title="음성 켜기/끄기">
              🎙
            </button>
            <button className="orb orb-big" onClick={() => void (voice.current ? voice.current.wake() : toggleVoice().then(() => voice.current?.wake()))} title="지금 말하기 (⌘/Ctrl+Shift+J)">
              ◉
            </button>
            <button className={`orb ${cameraOn ? 'orb-on' : ''}`} data-testid="camera-toggle" onClick={() => void toggleCamera()} title="카메라 / 손 제스처">
              ◎
            </button>
            <button className={`orb ${popups.browser ? 'orb-on' : ''}`} data-testid="open-browser" onClick={() => openPopup('browser')} title="웹 (JARVIS 브라우저)">
              🌐
            </button>
            <button className={`orb ${popups.device ? 'orb-on' : ''}`} data-testid="open-device" onClick={() => openPopup('device')} title="테스트 기기 (아이폰 시뮬레이터 / 안드로이드)">
              📱
            </button>
          </div>
          {cameraOn && (
            <div className="gesture-help">
              ✋ 손바닥: 홀로그램을 손 위로 · 🤏 집고 움직이기: 회전 · 🤏🤏 양손 집기: 확대/축소 · ✊ 주먹 유지: 자비스 호출
            </div>
          )}
        </main>

        <section className="panel">
          <div className="tabs">
            {(
              [
                ['chat', '대화'],
                ['git', 'Git'],
                ['history', '이력'],
                ['memory', '기억'],
                ['settings', '설정']
              ] as Array<[Tab, string]>
            ).map(([k, l]) => (
              <button key={k} className={`tab ${tab === k ? 'tab-on' : ''}`} data-testid={`tab-${k}`} onClick={() => setTab(k)}>
                {l}
              </button>
            ))}
          </div>
          <div className="panel-body">
            {questions[0] && <QuestionCard q={questions[0]} voice={phase !== 'off'} onAnswer={(v) => void window.jarvis.question.answer(questions[0].id, v)} />}
            {tab === 'chat' && !viewingSession && (
              <JarvisThread jobs={jobs} onSend={(t) => void send(t)} onStop={() => void window.jarvis.agent.interrupt()} onOpenSession={viewSession} />
            )}
            {tab === 'chat' && viewingSession && (
              <div className="session-view" data-testid="session-view">
                <div className="session-head">
                  <button className="btn btn-ghost btn-xs" onClick={() => setViewing(null)}>
                    ← JARVIS
                  </button>
                  <span className="session-name">{viewingSession.title}</span>
                  <span className="muted small">{PROVIDER_LABEL[viewingSession.provider]} · {viewingSession.projectDir ?? '일반'}</span>
                </div>
                <ChatPanel
                  turns={sessionTurns[viewingSession.id] ?? []}
                  busy={viewingSession.status === 'running'}
                  onSend={(t) => void window.jarvis.session.send(viewingSession.id, t)}
                  onStop={() => void window.jarvis.agent.interrupt()}
                />
              </div>
            )}
            {tab === 'memory' && (
              <MemoryPanel learning={settings.learning.enabled} onToggle={async (on) => setSettings(await window.jarvis.settings.update({ learning: { enabled: on } }))} />
            )}
            {tab === 'git' && <GitPanel refreshKey={refreshKey} notify={notify} />}
            {tab === 'history' && <HistoryPanel refreshKey={refreshKey} />}
            {tab === 'settings' && <SettingsPanel settings={settings} onSettings={setSettings} />}
          </div>
        </section>
      </div>

      {popups.browser && (
        <BrowserPopup
          rect={rects.browser}
          z={front === 'browser' ? 60 : 50}
          // 네이티브 웹 뷰는 HTML 위에 그려지므로: 승인 창이 떠 있거나, 기기 팝업이 앞에서 겹치면 숨긴다
          hidden={approvals.length > 0 || (popups.device && front === 'device' && overlaps(rects.browser, rects.device))}
          onRect={(r) => setRects((x) => ({ ...x, browser: r }))}
          onFocus={() => setFront('browser')}
          onClose={() => {
            setPopups((p) => ({ ...p, browser: false }))
            void window.jarvis.browser.close()
          }}
        />
      )}
      {popups.device && (
        <DevicePopup
          rect={rects.device}
          z={front === 'device' ? 60 : 50}
          onRect={(r) => setRects((x) => ({ ...x, device: r }))}
          onFocus={() => setFront('device')}
          onClose={() => setPopups((p) => ({ ...p, device: false }))}
        />
      )}
      {approvals[0] && <ApprovalModal req={approvals[0]} voice={phase !== 'off'} onRespond={(ok, reason) => respond(ok, reason)} />}
      {toast && <div className={`toast ${toast.err ? 'toast-err' : ''}`}>{toast.m}</div>}
    </div>
  )
}
