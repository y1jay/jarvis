import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { ApprovalRequest, JarvisSettings, JobInfo, SessionInfo } from '../../shared/types'
import { PROVIDER_LABEL } from '../../shared/types'
import { applyEvent, assistantTurn, userTurn, type Turn } from './lib/chat'
import { HologramScene } from './hologram/HologramScene'
import { HandTracker } from './vision/handTracker'
import type { HandState } from './vision/gestures'
import { VoiceEngine, type VoicePhase } from './voice/VoiceEngine'
import { isStopCommand, matchWakeWord, takeSentences } from './voice/text'
import { brandName, effectiveWakeWords, shortName } from '../../shared/wake'
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
import { CodeFeed, toFeedLines, type FeedLine } from './components/CodeFeed'
import { AppMirrorPopup, BrowserPopup, DevicePopup, loadRect, overlaps, type PopupKind, type Rect } from './components/StagePanels'

type Tab = 'chat' | 'git' | 'history' | 'memory' | 'settings'

const PHASE_TEXT: Record<VoicePhase, string> = {
  off: '음성 꺼짐',
  loading: '음성 시스템 준비 중',
  sleeping: '"헤이 자비스" 대기 중',
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
  const [toast, setToast] = useState<{ m: string; err?: boolean } | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [cameraOn, setCameraOn] = useState(false)
  const [hands, setHands] = useState<HandState[]>([])
  const [voiceProgress, setVoiceProgress] = useState('')
  const [micLevel, setMicLevel] = useState(0)
  const [platform, setPlatform] = useState('')
  const [questions, setQuestions] = useState<Q[]>([])
  // 대화창 열기/닫기 (화면 설정이라 이 기기에만 기억)
  const [panelOpen, setPanelOpen] = useState(() => localStorage.getItem('jarvis.panelOpen') !== '0')
  useEffect(() => localStorage.setItem('jarvis.panelOpen', panelOpen ? '1' : '0'), [panelOpen])
  useEffect(() => window.jarvis.app.onPanel((open) => setPanelOpen(open)), [])
  // 왼쪽 AI 연결·프로젝트 창 열기/닫기
  const [sideOpen, setSideOpen] = useState(() => localStorage.getItem('jarvis.sideOpen') !== '0')
  useEffect(() => localStorage.setItem('jarvis.sideOpen', sideOpen ? '1' : '0'), [sideOpen])
  useEffect(() => window.jarvis.app.onSide((open) => setSideOpen(open)), [])
  useEffect(() => window.jarvis.app.onTab((t) => setTab(t as Tab)), [])
  // 이름을 바꾸면 창 제목도
  useEffect(() => {
    if (settings) document.title = brandName(settings.assistantName)
  }, [settings?.assistantName])
  // 목소리 엔진 설치·준비 상태 알림
  useEffect(
    () =>
      window.jarvis.tts.onState((st) => {
        if (st.state === 'installing' && st.message) setVoiceProgress(st.message)
        else if (st.state === 'ready') setVoiceProgress('')
        else if (st.state === 'error' && st.message) notify(st.message, true)
      }),
    []
  )
  // 닫혀 있을 때 JARVIS 가 뭔가 물으면 놓치지 않게 연다
  useEffect(() => {
    if (questions.length) setPanelOpen(true)
  }, [questions.length])
  // 홀로그램은 항상 기본 화면. 웹/기기는 그 위에 뜨는 팝업
  const [popups, setPopups] = useState<Record<PopupKind, boolean>>({ browser: false, device: false, app: false })
  const [rects, setRects] = useState<Record<PopupKind, Rect>>(() => ({ browser: loadRect('browser'), device: loadRect('device'), app: loadRect('app') }))
  // 비춰 보는 앱 (카카오톡 등)
  const [mirrorApp, setMirrorApp] = useState<string | null>(null)
  // 코드 흐름 (JARVIS 가 고치는 코드만 터미널처럼)
  const [feed, setFeed] = useState<FeedLine[]>([])
  const [feedOpen, setFeedOpen] = useState(false)
  const feedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const feedSeq = useRef(0)
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

  // 항상 듣기: 앱이 켜지면 바로 호출어 대기 (창이 숨겨져 있어도 계속 듣는다)
  const autoStarted = useRef(false)
  useEffect(() => {
    if (!settings || autoStarted.current || !settings.alwaysListen) return
    autoStarted.current = true
    void toggleVoice()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings])
  // 트레이 메뉴의 듣기 켜기/끄기
  useEffect(() => window.jarvis.app.onToggleListen(() => void toggleVoice()), [])

  // 맥북 덮개 닫힘 감지 (닫히면 내장 마이크가 꺼짐 → 외장 마이크 우선) + 잠자기/잠금 해제 후 마이크 재연결
  useEffect(() => {
    let last: boolean | null = null
    const check = async (): Promise<void> => {
      const { clamshell } = await window.jarvis.power.status()
      if (clamshell === last) return
      last = clamshell
      voice.current?.updateOptions({ clamshell })
      if (voice.current?.enabled) voice.current.scheduleRestart('devicechange', 300)
    }
    void check()
    const t = setInterval(() => void check(), 20_000)
    const off = window.jarvis.power.onVoiceRestart(({ reason }) => voice.current?.scheduleRestart(reason, 500))
    return () => {
      clearInterval(t)
      off()
    }
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
    // 작업이 도는 동안은 말하기·듣기 중에도 '일하는 중' 표시를 계속
    h.setWorking(busy)
  }, [busy])

  const speak = useCallback((text: string, followUp = false) => {
    const v = voice.current
    if (!v || !settingsRef.current?.voice.ttsEnabled) return
    holo.current?.setState('speaking')
    void v.speak(text).then(() => {
      if (holo.current?.getState() === 'speaking') holo.current?.setState('idle')
      // 대답한 뒤 몇 초간은 호출어 없이 이어서 말할 수 있게
      if (followUp) v.keepAwake(20000)
    })
  }, [])

  // ── 스트리밍 답변을 문장 단위로 바로 읽기 ──
  const jobsRef = useRef<JobInfo[]>([])
  jobsRef.current = jobs
  const streamBuf = useRef(new Map<string, string>())
  const streamed = useRef(new Set<string>())
  const wantsVoice = (jobId: string): boolean => {
    const j = jobsRef.current.find((x) => x.id === jobId)
    return !!settingsRef.current?.voice.ttsEnabled && !!voice.current && (j?.via === 'voice' || phaseRef.current !== 'off')
  }

  // ── main 이벤트 ──
  useEffect(() => {
    const offs = [
      window.jarvis.agent.onTurnStart(({ turnId, sessionId, provider, prompt }) =>
        setSessionTurns((m) => ({ ...m, [sessionId]: [...(m[sessionId] ?? []), userTurn(turnId, provider, prompt), assistantTurn(turnId, provider)] }))
      ),
      window.jarvis.agent.onEvent(({ turnId, sessionId, event }) => {
        if (event.kind === 'file-change') setRefreshKey((k) => k + 1)
        if (event.kind === 'tool-use') {
          const add = toFeedLines(event.name, event.input)
          if (add.length) {
            setFeed((f) => [...f, ...add.map((l) => ({ ...l, id: ++feedSeq.current }))].slice(-800))
            setFeedOpen(true)
            // 30초 동안 새 코드가 없으면 저절로 사라진다 (</> 로 다시 볼 수 있음)
            if (feedTimer.current) clearTimeout(feedTimer.current)
            feedTimer.current = setTimeout(() => setFeedOpen(false), 30_000)
          }
        }
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
        const v = voice.current
        if (streamed.current.has(j.id) && v) {
          // 이미 문장 단위로 읽는 중 → 남은 꼬리만 읽고, 끝나면 이어 말하기 대기
          const rest = (streamBuf.current.get(j.id) ?? '').trim()
          streamBuf.current.delete(j.id)
          streamed.current.delete(j.id)
          if (rest) v.enqueue(rest)
          void v.whenIdle().then(() => {
            if (holo.current?.getState() === 'speaking') holo.current?.setState('idle')
            if (j.via === 'voice') v.keepAwake(20000)
          })
        } else if (j.answer && (j.via === 'voice' || phaseRef.current !== 'off')) speak(j.answer, j.via === 'voice')
      }),
      window.jarvis.jarvis.onJobDelta(({ jobId, text }) => {
        // 화면에도 실시간으로
        setJobs((js) => js.map((x) => (x.id === jobId && x.status !== 'done' ? { ...x, answer: (x.answer ?? '') + text } : x)))
        if (!wantsVoice(jobId)) return
        const buf = (streamBuf.current.get(jobId) ?? '') + text
        const { sentences, rest } = takeSentences(buf)
        streamBuf.current.set(jobId, rest)
        if (!sentences.length) return
        streamed.current.add(jobId)
        holo.current?.setState('speaking')
        for (const sentence of sentences) voice.current?.enqueue(sentence)
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
      window.jarvis.mirror.onOpen(({ app }) => {
        setMirrorApp(app)
        openPopup('app')
      }),
      window.jarvis.popup.onClose((k) => setPopups((p) => (k === 'all' ? { browser: false, device: false, app: false } : { ...p, [k]: false }))),
      window.jarvis.mirror.onClose((app) => setMirrorApp((cur) => {
        if (cur === app) setPopups((p) => ({ ...p, app: false }))
        return cur
      })),
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
      { model: s.voice.sttModel, language: s.voice.language, wakeWords: effectiveWakeWords(s.assistantName, s.voice.wakeWords), wakeWordEnabled: s.voice.wakeWordEnabled, ttsVoice: s.voice.ttsVoice, ttsRate: s.voice.ttsRate, ttsPitch: s.voice.ttsPitch, inputDeviceId: s.voice.inputDeviceId, bargeIn: s.voice.bargeIn, neural: s.voice.ttsVoiceId !== 'system', voiceKey: s.voice.ttsVoiceId },
      {
        onPhase: (p) => {
          setPhase(p)
          if (p === 'awake' || p === 'recording') holo.current?.setState('listening')
          else if (p === 'transcribing') holo.current?.setState('thinking')
          else if ((p === 'sleeping' || p === 'off') && !['thinking', 'speaking'].includes(holo.current?.getState() ?? '')) holo.current?.setState('idle')
        },
        onLevel: (v) => {
          holo.current?.setLevel(v)
          setMicLevel((p) => (Math.abs(p - v) > 0.03 ? v : p))
        },
        onTranscript: () => {}, // 내 말은 화면에 글자로 띄우지 않는다
        onCommand: (t) => {
          void window.jarvis.win.summon()
          // "멈춰/그만" — 하던 작업을 모두 멈추고 다음 말을 기다린다
          if (isStopCommand(t)) {
            voice.current?.stopSpeaking()
            void window.jarvis.agent
              .interrupt('voice', t)
              .then(() => voice.current?.speak('멈췄습니다. 말씀하세요.'))
              .then(() => voice.current?.keepAwake())
            return
          }
          void sendRef.current(t, 'voice')
        },
        onBargeIn: () => {},
        onWake: () => {
          void window.jarvis.win.summon()
          void voice.current?.speak('네?')
        },
        onProgress: (m) => setVoiceProgress(m),
        onError: (m) => {
          notify(m, true)
          // 마이크가 끊긴 경우엔 화면을 안 보고 있을 수 있으니 소리로도 알린다
          if (/덮개|소리가 전혀/.test(m)) speak(m.split('.')[0] + '.')
        }
      }
    )
    await voice.current.start()
  }
  const lastMic = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    if (!settings || !voice.current) return
    // 마이크 장치를 바꾸면 바로 다시 연결
    const mic = settings.voice.inputDeviceId
    if (lastMic.current !== undefined && lastMic.current !== mic && voice.current.enabled) {
      voice.current.updateOptions({ inputDeviceId: mic })
      voice.current.stop()
      void voice.current.start()
    }
    lastMic.current = mic
    voice.current.updateOptions({ wakeWords: effectiveWakeWords(settings.assistantName, settings.voice.wakeWords), wakeWordEnabled: settings.voice.wakeWordEnabled, ttsVoice: settings.voice.ttsVoice, ttsRate: settings.voice.ttsRate, ttsPitch: settings.voice.ttsPitch, bargeIn: settings.voice.bargeIn, neural: settings.voice.ttsVoiceId !== 'system', voiceKey: settings.voice.ttsVoiceId })
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
      const w = matchWakeWord(raw, effectiveWakeWords(settingsRef.current?.assistantName ?? '자비스', settingsRef.current?.voice.wakeWords ?? []))
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
      const w = matchWakeWord(raw, effectiveWakeWords(settingsRef.current?.assistantName ?? '자비스', settingsRef.current?.voice.wakeWords ?? []))
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

  const sleepingLabel = `"헤이 ${settings.assistantName}" 대기 중`
  const holoLabel = !busy && phase === 'sleeping' ? sleepingLabel : busy ? `처리 중${sessions.filter((x) => x.status === 'running').length > 1 ? ` · 세션 ${sessions.filter((x) => x.status === 'running').length}개 동시 작업` : ''}` : PHASE_TEXT[phase]
  const viewingSession = viewing ? sessions.find((x) => x.id === viewing) ?? null : null
  const projectName = settings.projectDir ? settings.projectDir.split(/[\\/]/).pop() : '프로젝트 없음'

  return (
    <div className={`app plat-${platform}`}>
      <div className="titlebar">
        <button className="side-toggle" data-testid="toggle-side" onClick={() => setSideOpen((v) => !v)} title={sideOpen ? 'AI 연결 창 닫기' : 'AI 연결 창 열기'}>
          {sideOpen ? '⟨' : '☰'}
        </button>
        <div className="brand">
          <span className="brand-mark">◉</span> {brandName(settings.assistantName)}
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

      <div className={`body ${panelOpen ? '' : 'panel-closed'} ${sideOpen ? '' : 'side-closed'}`}>
        <aside className="side" hidden={!sideOpen}>
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
            {voiceProgress && phase !== 'off' && <div className="holo-progress">{voiceProgress}</div>}
            {phase !== 'off' && phase !== 'speaking' && (
              <div className="mic-meter" title="마이크 입력 크기" data-testid="mic-meter">
                <div style={{ width: `${Math.round(micLevel * 100)}%` }} />
              </div>
            )}
          </div>
          {feedOpen && feed.length > 0 && <CodeFeed lines={feed.slice(-120)} />}
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
            <button className={`orb ${feedOpen ? 'orb-on' : ''}`} data-testid="toggle-feed" onClick={() => setFeedOpen((v) => !v)} title={feedOpen ? '코드 흐름 닫기' : '코드 흐름 보기 (JARVIS 가 고친 코드)'}>
              <span className="orb-code">{'</>'}</span>
            </button>
            <button className={`orb ${panelOpen ? 'orb-on' : ''}`} data-testid="toggle-panel" onClick={() => setPanelOpen((v) => !v)} title={panelOpen ? '대화창 닫기' : '대화창 열기'}>
              💬
            </button>
          </div>
          {cameraOn && (
            <div className="gesture-help">
              ✋ 손바닥: 홀로그램을 손 위로 · 🤏 집고 움직이기: 회전 · 🤏🤏 양손 집기: 확대/축소 · ✊ 주먹 유지: 자비스 호출
            </div>
          )}
        </main>

        <section className="panel" hidden={!panelOpen}>
          <div className="tabs">
            <button className="tab panel-close" data-testid="close-panel" onClick={() => setPanelOpen(false)} title="대화창 닫기">
              ›
            </button>
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
              <JarvisThread name={shortName(settings.assistantName)} jobs={jobs} onSend={(t) => void send(t)} onStop={() => void window.jarvis.agent.interrupt()} onOpenSession={viewSession} />
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
          hidden={approvals.length > 0 || (popups.device && front === 'device' && overlaps(rects.browser, rects.device)) || (popups.app && front === 'app' && overlaps(rects.browser, rects.app))}
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
      {popups.app && mirrorApp && (
        <AppMirrorPopup
          key={mirrorApp}
          app={mirrorApp}
          rect={rects.app}
          z={front === 'app' ? 60 : 50}
          onRect={(r) => setRects((x) => ({ ...x, app: r }))}
          onFocus={() => setFront('app')}
          onClose={() => setPopups((p) => ({ ...p, app: false }))}
        />
      )}
      {approvals[0] && <ApprovalModal req={approvals[0]} voice={phase !== 'off'} onRespond={(ok, reason) => respond(ok, reason)} />}
      {toast && <div className={`toast ${toast.err ? 'toast-err' : ''}`}>{toast.m}</div>}
    </div>
  )
}
