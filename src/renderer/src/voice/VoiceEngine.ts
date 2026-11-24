// 마이크 → VAD(발화 구간 검출) → Whisper → 호출어/명령 판정, 그리고 TTS.
import { isEchoOf, isLikelyHallucination, looksUnfinished, matchWakeWord, speakableText } from './text'
import { encodeOpus } from './opus'
import { analyzeFrame, MAX_SPEECH_BURST, MAX_SPEECH_CREST, VoicedWindow } from './vad'

export type VoicePhase = 'off' | 'loading' | 'sleeping' | 'awake' | 'recording' | 'transcribing' | 'speaking'

export interface VoiceOptions {
  model: string
  language: string
  wakeWords: string[]
  wakeWordEnabled: boolean
  ttsVoice: string | null
  ttsRate: number
  ttsPitch?: number
  /** 사용할 마이크 (없으면 시스템 기본) */
  inputDeviceId?: string | null
  /** JARVIS 가 말하는 중에도 사용자가 말하면 즉시 멈추고 듣기 (기본 켬) */
  bargeIn?: boolean
  /** 맥북 덮개가 닫혀 있음 → 내장 마이크는 하드웨어적으로 꺼져 있으므로 외장 마이크를 우선 */
  clamshell?: boolean
  /** 사람 같은 목소리 엔진 사용 (Qwen3/Supertonic) — main 이 문장을 소리로 만들어 준다. 실패하면 운영체제 목소리 */
  neural?: boolean
  /** 지금 목소리 (바뀌면 "네, 잠깐만요" 같은 맞장구를 새 목소리로 다시 만들어 둔다) */
  voiceKey?: string
  /** 대답이 늦을 때 먼저 "네, 잠깐만요" 하기 (기본 켬) */
  fillers?: boolean
}

export interface VoiceCallbacks {
  onPhase: (p: VoicePhase) => void
  onLevel: (v: number) => void
  onTranscript: (text: string, final: boolean) => void
  onCommand: (text: string) => void
  onWake: () => void
  onProgress: (msg: string) => void
  onError: (msg: string) => void
  /** 사용자가 말을 끊고 들어왔을 때 (TTS 중단됨) */
  onBargeIn?: () => void
}

/** 녹음 시작: 최근 3 프레임(≈190ms) 중 목소리 2 프레임 */
/**
 * 말 끝 판정 (튜닝값 — tests/live/stt-accuracy 로 실제 인식률을 재고 정한다)
 * - endSilenceMs: 이만큼 조용하면 말이 끝난 것으로 본다. 너무 짧으면 문장 중간 쉼에서 잘려 조각만 인식된다.
 * - continueOnEnergy: 말하는 도중엔 '목소리 떨림'이 없어도(ㅅ·ㅊ·ㅎ 같은 자음, 숨) 소리가 있으면 이어지는 말로 본다.
 */
export const VAD_TUNING = { endSilenceMs: 800, continueOnEnergy: true, holdUnfinishedMs: 1300, noiseRatio: 2, legacyNoise: false, conversationMs: 45000, wakeWindowMs: 20000 }
const START_VOICED = 2
/** 끼어들기: 최근 6 프레임(≈380ms) 중 목소리 4 프레임 — 짧은 기침·타건으로 말을 끊지 않게 */
const BARGE_VOICED = 4
/** 이보다 목소리 프레임이 적은 녹음은 버린다 (타건/잡음만 있던 구간 → Whisper 환각 방지) */
const MIN_UTTERANCE_VOICED = 3

const SR = 16000

export class VoiceEngine {
  private worker: Worker | null = null
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private node: ScriptProcessorNode | null = null
  private phase: VoicePhase = 'off'
  private chunks: Float32Array[] = []
  /** 발화 시작 직전 오디오(약 400ms) — 첫 음절("자비스") 잘림 방지 */
  private preroll: Float32Array[] = []
  /** TTS 종료 시각 — 직후 잔향을 사용자 발화로 오인하지 않게 */
  private speakEndedAt = 0
  private startWin = new VoicedWindow(3)
  private bargeWin = new VoicedWindow(6)
  /** 이번 녹음에서 목소리로 판정된 프레임 수 */
  private voicedFrames = 0
  /** 마지막 목소리 프레임 이후 경과(ms) — 타건음은 이 타이머를 되살리지 않는다 */
  private silenceMs = 0
  /** 말하던 중 끼어들어 시작된 녹음 (호출어 없이 명령으로 받는다) */
  private bargedIn = false
  /** 지금/방금 읽던 문장 — 끼어든 소리가 자기 목소리 메아리인지 확인용 */
  private spokenText = ''
  private recording = false
  private noise = 0.008
  private awakeUntil = 0
  private reqId = 0
  private pending = new Map<number, (t: string) => void>()
  private ready = false
  /** 네이티브 음성 인식(whisper.cpp) 사용 여부 — 없으면 브라우저 내 엔진 */
  private native = false
  private nativeOff: (() => void) | null = null
  private loadAttempts = 0
  /** 말할 문장 대기열 (스트리밍 답변을 문장 단위로 바로 읽기) */
  private queue: string[] = []
  private queueRunning = false
  /** 입력이 완전히 0 인(끊긴) 프레임 연속 수 — 덮개 닫힘·장치 분리 감지 */
  private deadFrames = 0
  /** 소리가 전혀 안 들어온 장치 (다시 고르지 않음) */
  private deadDevices = new Set<string>()
  private currentDevice: string | undefined
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private warnedDead = new Set<string>()
  /** 사용자가 듣기를 켜 둔 상태 — 연결이 잠깐 실패해도 이 동안은 계속 다시 시도한다 */
  private wanted = false
  private retryCount = 0
  /** 마지막으로 본 입력 장치 목록 — 블루투스 통화 모드 전환처럼 '출력'만 바뀐 이벤트는 무시하려고 */
  private inputSig = ''
  /** 마이크를 연 뒤 지난 프레임 수 — 블루투스는 붙는 순간 1~2초간 0 이 들어와서 그동안은 끊김 판정 안 함 */
  private framesSinceOpen = 0
  private lastError = ''
  private onDeviceChange = (): void => void this.handleDeviceChange()
  /** 승인 대기 중이면 발화를 명령 대신 여기로 보낸다 (호출어 불필요) */
  private approvalHandler: ((text: string) => void) | null = null
  /** 버튼으로 켠 대화 모드: 호출어 없이 바로 명령 */
  private conversation = false

  constructor(
    private opts: VoiceOptions,
    private readonly cb: VoiceCallbacks
  ) {}

  updateOptions(o: Partial<VoiceOptions>): void {
    const voiceChanged = (o.voiceKey !== undefined && o.voiceKey !== this.opts.voiceKey) || (o.neural !== undefined && o.neural !== this.opts.neural)
    this.opts = { ...this.opts, ...o }
    if (voiceChanged) {
      this.fillerCache.clear()
      this.prefetchFillers()
    }
  }

  /** 대답이 늦을 때 먼저 하는 말 */
  static readonly FILLERS = { quick: '네, 잠깐만요.', long: '확인하고 있어요. 조금만 기다려 주세요.' }

  /** 맞장구를 지금 목소리로 미리 만들어 둔다 */
  prefetchFillers(): void {
    if (!this.opts.neural || typeof window === 'undefined' || !window.jarvis?.tts) return
    for (const t of Object.values(VoiceEngine.FILLERS)) if (!this.fillerCache.has(t)) this.fillerCache.set(t, window.jarvis.tts.speak(t).catch(() => null))
  }

  /**
   * 명령을 받았다 — 대답이 바로 시작되지 않으면 먼저 "네, 잠깐만요" 라고 말하고, 오래 걸리면 한 번 더 알린다.
   * 진짜 대답(speak/enqueue)이 시작되면 취소된다.
   */
  expectReply(): void {
    this.clearReplyTimers()
    if (this.opts.fillers === false) return
    this.replyTimers.push(setTimeout(() => this.playFiller(VoiceEngine.FILLERS.quick), 600))
    this.replyTimers.push(setTimeout(() => this.playFiller(VoiceEngine.FILLERS.long), 5000))
  }

  private clearReplyTimers(): void {
    for (const t of this.replyTimers) clearTimeout(t)
    this.replyTimers = []
  }

  private playFiller(text: string): void {
    // 사용자가 말하는 중이거나 이미 뭔가 말하는 중이면 끼어들지 않는다
    if (this.recording || this.phase === 'speaking' || this.queueRunning || !this.stream) return
    const cached = this.fillerCache.get(text)
    if (cached) this.synthCache.set(text, cached)
    void this.say(text, false)
  }

  get current(): VoicePhase {
    return this.phase
  }

  private setPhase(p: VoicePhase): void {
    this.phase = p
    this.cb.onPhase(p)
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const w = new Worker(new URL('./stt.worker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (ev) => {
      const m = ev.data
      if (m.type === 'progress') {
        if (m.status === 'progress' && m.file) this.cb.onProgress(`처음 한 번 음성 인식 모델을 받는 중 ${Math.round(m.progress ?? 0)}% — 받는 동안은 호출을 못 들어요`)
      } else if (m.type === 'ready') {
        this.ready = true
        this.cb.onProgress(`음성 인식 준비 완료 (${m.device}) — 이제 부르시면 됩니다`)
      } else if (m.type === 'result') {
        this.pending.get(m.id)?.(m.text)
        this.pending.delete(m.id)
      } else if (m.type === 'error') {
        if (m.id !== undefined) {
          this.pending.get(m.id)?.('')
          this.pending.delete(m.id)
        } else if (!this.ready && this.loadAttempts < 4) {
          // 모델 다운로드 실패(일시적 서버 오류 등) → 잠시 후 다시 받기. 그 전에는 영영 못 듣던 문제 수정
          this.loadAttempts++
          this.cb.onProgress(`음성 모델을 받지 못했습니다 — ${this.loadAttempts}번째 다시 시도 중…`)
          setTimeout(() => this.postLoad(), 2000 * this.loadAttempts)
          return
        }
        this.cb.onError(`음성 인식 오류: ${m.message}`)
      }
    }
    this.worker = w
    this.postLoad()
    return w
  }

  private postLoad(): void {
    this.worker?.postMessage({ type: 'load', model: this.opts.model, ortBase: new URL('./ort/', window.location.href).href })
  }

  /** 네이티브 엔진이 있으면 그걸 쓴다 (문장당 약 0.3초). 없거나 실패하면 브라우저 내 엔진으로 */
  private async initRecognizer(): Promise<void> {
    try {
      const st = await window.jarvis.stt.status()
      if (st.available) {
        this.native = true
        this.nativeOff?.()
        this.nativeOff = window.jarvis.stt.onState((x) => this.onNativeState(x))
        this.onNativeState(st)
        void window.jarvis.stt.start()
        return
      }
    } catch {
      /* 네이티브 없음 */
    }
    this.native = false
    this.ensureWorker()
  }

  private onNativeState(x: { available: boolean; state: string; progress?: number; message?: string; model?: string }): void {
    if (x.state === 'ready') {
      this.ready = true
      this.cb.onProgress(`음성 인식 준비 완료 (${x.model ?? '네이티브'}) — 이제 부르시면 됩니다`)
    } else if (x.state === 'downloading') {
      this.ready = false
      this.cb.onProgress(x.message ?? `처음 한 번 음성 인식 모델을 받는 중 ${x.progress ?? 0}% — 받는 동안은 호출을 못 들어요`)
    } else if (x.state === 'starting') {
      this.cb.onProgress('음성 인식 엔진을 켜는 중…')
    } else if (x.state === 'error' || x.state === 'missing-binary') {
      // 네이티브가 안 되면 브라우저 내 엔진으로 전환
      this.ready = false
      this.native = false
      this.cb.onProgress(`${x.message ?? '네이티브 음성 엔진 오류'} — 기본 엔진으로 전환합니다`)
      this.ensureWorker()
    }
  }

  /** 마이크를 켠다. wakeWordEnabled 면 호출어(헤이 자비스 등) 대기, 아니면 대화 모드 */
  async start(): Promise<void> {
    if (this.stream || this.opening) return
    this.wanted = true
    this.opening = true
    try {
      await this.open()
    } finally {
      this.opening = false
    }
  }

  private opening = false

  private async open(): Promise<void> {
    this.setPhase('loading')
    await this.initRecognizer()
    // 장치가 빠지거나(블루투스 끊김) 새로 꽂히면 자동으로 다시 연결 — 연결 실패 중에도 듣고 있어야 새 장치를 잡는다
    navigator.mediaDevices.removeEventListener?.('devicechange', this.onDeviceChange)
    navigator.mediaDevices.addEventListener?.('devicechange', this.onDeviceChange)
    let stream: MediaStream
    try {
      const granted = await window.jarvis.media.request('microphone')
      if (granted === false) throw Object.assign(new Error('permission'), { name: 'NotAllowedError' })
      // 브라우저 잡음 제거/자동 음량은 통화용이라 자음을 뭉개 음성 인식을 망친다 → 끈다 (음량은 인식 직전에 따로 맞춘다).
      // 메아리 제거는 유지 (JARVIS 가 말하는 소리가 다시 들어오지 않게 — 끼어들기에 필요)
      const audio: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: false, autoGainControl: false, channelCount: 1 }
      const dev = await this.pickDevice()
      if (dev) audio.deviceId = { exact: dev }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio })
      } catch (e) {
        // 고른 마이크가 사라졌으면(블루투스 해제 등) 기본 마이크로
        if (!audio.deviceId || (e as Error).name === 'NotAllowedError') throw e
        delete audio.deviceId
        stream = await navigator.mediaDevices.getUserMedia({ audio })
      }
    } catch (e) {
      this.failed(e as Error)
      return
    }
    if (!this.wanted) {
      // 여는 사이에 사용자가 껐다
      stream.getTracks().forEach((t) => t.stop())
      return
    }
    this.stream = stream
    this.retryCount = 0
    this.lastError = ''
    this.inputSig = await this.inputSignature()
    const track = stream.getAudioTracks()[0]
    this.currentDevice = track?.getSettings().deviceId
    this.deadFrames = 0
    this.framesSinceOpen = 0
    if (track) track.onended = () => this.scheduleRestart('ended')
    this.ctx = new AudioContext({ sampleRate: SR })
    await this.ctx.resume().catch(() => undefined)
    console.debug(`[voice] mic started sr=${this.ctx.sampleRate} state=${this.ctx.state} track=${track?.label}`)
    const src = this.ctx.createMediaStreamSource(stream)
    this.node = this.ctx.createScriptProcessor(1024, 1, 1)
    this.node.onaudioprocess = (e) => this.onAudio(e.inputBuffer.getChannelData(0))
    src.connect(this.node)
    this.node.connect(this.ctx.destination)
    this.conversation = !this.opts.wakeWordEnabled
    this.setPhase(this.conversation ? 'awake' : 'sleeping')
    this.prefetchFillers()
  }

  /** 마이크 열기 실패 — 원인별로 한 번만 안내하고, 듣기가 켜져 있는 동안 점점 간격을 늘려 다시 시도 */
  private failed(e: Error): void {
    this.setPhase('off')
    const msg = micErrorMessage(e, !!this.opts.clamshell)
    if (msg !== this.lastError) {
      this.lastError = msg
      this.cb.onError(msg)
    }
    if (!this.wanted) return
    const delay = Math.min(15000, 2000 * 2 ** this.retryCount)
    this.retryCount++
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.wanted && !this.stream) void this.start()
    }, delay)
  }

  /** 마이크 입력 장치 목록 (id+이름) — 바뀌었는지 비교용 */
  private async inputSignature(): Promise<string> {
    try {
      const list = await navigator.mediaDevices.enumerateDevices()
      return list
        .filter((d) => d.kind === 'audioinput')
        .map((d) => `${d.deviceId}|${d.label}`)
        .sort()
        .join(',')
    } catch {
      return ''
    }
  }

  /**
   * 장치 변경: 꼭 필요할 때만 다시 연결한다.
   * 블루투스 이어폰은 마이크를 열고 닫을 때마다(통화 모드 ↔ 음악 모드) 장치 변경 신호를 여러 번 보내므로,
   * 그때마다 다시 연결하면 이어폰이 붙었다 떨어졌다를 반복한다.
   * → 지금 마이크가 살아 있고 목록에도 그대로 있으며, 새로 고를 마이크가 지금 것과 같으면 그대로 둔다.
   */
  private async handleDeviceChange(): Promise<void> {
    if (!this.wanted) return
    const sig = await this.inputSignature()
    const live = this.stream?.getAudioTracks()[0]?.readyState === 'live'
    if (live && sig === this.inputSig) return
    this.inputSig = sig
    if (live && this.currentDevice) {
      const ids = sig.split(',').map((x) => x.split('|')[0])
      const stillThere = ids.includes(this.currentDevice)
      const want = (await this.pickDevice()) ?? 'default'
      if (stillThere && want === this.currentDevice) {
        // 잠깐 사라졌다 돌아온 경우: 앞서 예약된 재연결도 취소
        if (this.restartTimer && this.pendingReason === 'devicechange') {
          clearTimeout(this.restartTimer)
          this.restartTimer = null
        }
        return
      }
    }
    this.retryCount = 0
    this.scheduleRestart('devicechange', 2000)
  }

  stop(): void {
    this.wanted = false
    if (this.held) clearTimeout(this.held.timer)
    this.held = null
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    navigator.mediaDevices?.removeEventListener?.('devicechange', this.onDeviceChange)
    this.node?.disconnect()
    this.stream?.getTracks().forEach((t) => t.stop())
    void this.ctx?.close()
    this.node = null
    this.stream = null
    this.ctx = null
    this.recording = false
    this.chunks = []
    this.cancelSpeech()
    this.setPhase('off')
  }

  /** 대화가 이어지는 중 — 주고받을 때마다 연장 */
  private touchConversation(): void {
    this.convoUntil = performance.now() + VAD_TUNING.conversationMs
  }

  /** 지금 "자비스" 없이 말해도 되는 상태인지 */
  get inConversation(): boolean {
    return this.conversation || performance.now() < this.convoUntil || performance.now() < this.awakeUntil
  }

  /** 호출어 없이 바로 듣기 (버튼/단축키/주먹 제스처) */
  async wake(): Promise<void> {
    if (!this.stream) await this.start()
    if (!this.stream) return
    this.cancelSpeech()
    this.awakeUntil = performance.now() + VAD_TUNING.wakeWindowMs
    this.followUpMs = VAD_TUNING.wakeWindowMs
    this.touchConversation()
    this.setPhase('awake')
    this.cb.onWake()
  }

  /** 호출어 없이 다음 말을 바로 명령으로 받는다 (정지 직후 등) */
  keepAwake(ms = 10000): void {
    if (!this.stream) return
    // 아직 말하는 중이면, 말이 다 끝난 시점부터 ms 동안 이어서 듣는다
    if (this.phase === 'speaking' || this.queueRunning || this.queue.length) this.followUpMs = Math.max(this.followUpMs, ms)
    this.awakeUntil = Math.max(this.awakeUntil, performance.now() + ms)
    if (!this.recording && this.phase !== 'speaking' && this.phase !== 'transcribing') this.setPhase('awake')
  }

  private hasApproval(): boolean {
    return this.approvalHandler !== null
  }

  get listening(): boolean {
    return !!this.stream
  }

  /** 듣기를 켜 둔 상태 (지금 연결이 잠깐 끊겨 다시 시도 중이어도 true) */
  get enabled(): boolean {
    return this.wanted
  }

  private captureToken = 0
  private playCtx: AudioContext | null = null
  private source: AudioBufferSourceNode | null = null
  /** 미리 만들어 둔 문장 소리 (앞 문장을 읽는 동안 다음 문장을 만든다) */
  private synthCache = new Map<string, Promise<ArrayBuffer | null>>()
  private speechToken = 0
  /** 맞장구("네, 잠깐만요") 미리 만들어 둔 소리 — 지연 없이 바로 대답하려고 */
  private fillerCache = new Map<string, Promise<ArrayBuffer | null>>()
  private replyTimers: Array<ReturnType<typeof setTimeout>> = []
  /** 대화 중: 이 시각까지는 "자비스" 없이 말해도 알아듣는다 (주고받을 때마다 연장) */
  private convoUntil = 0
  /** 말이 끝난 뒤 이어서 들을 시간 (대답한 직후 호출어 없이 바로 대화) */
  private followUpMs = 0

  /** 승인 창/질문이 떠 있는 동안: 호출어 없이 다음 발화를 그 답으로 받는다. 반환값으로 본인 것만 해제 */
  listenFor(handler: (text: string) => void): number {
    this.listenForApproval(handler)
    return this.captureToken
  }

  /** token 을 주면 그 리스너일 때만 해제 (다른 화면의 리스너를 지우지 않게) */
  release(token: number): void {
    if (token === this.captureToken) this.clearApproval()
  }

  listenForApproval(handler: (text: string) => void): void {
    this.captureToken++
    this.approvalHandler = handler
    this.awakeUntil = performance.now() + 60_000
    if (this.stream && this.phase !== 'speaking' && !this.recording) this.setPhase('awake')
  }

  clearApproval(): void {
    if (!this.approvalHandler) return
    this.approvalHandler = null
    this.awakeUntil = 0
    if (this.stream && this.phase === 'awake' && !this.conversation) this.setPhase('sleeping')
  }

  setConversation(on: boolean): void {
    this.conversation = on
    if (this.stream && !this.recording) this.setPhase(on ? 'awake' : 'sleeping')
  }

  private onAudio(buf: Float32Array): void {
    const f = analyzeFrame(buf, SR)
    const rms = f.rms
    this.watchDead(buf)
    this.cb.onLevel(Math.min(1, rms * 20))
    if (this.phase === 'speaking') {
      this.pushPreroll(buf)
      // 헤드셋(블루투스)은 입력이 작다 — 메아리는 메아리 제거 + 내용 비교(isEchoOf)로 거르므로 기준을 낮게
      this.maybeBargeIn(f.voiced && rms > Math.max(0.008, this.noise * 3))
      return
    }
    // 인식하는 동안에도 계속 듣는다 (이어 말한 앞부분을 버리지 않게)
    if (this.phase === 'loading') return

    const frameMs = (buf.length / SR) * 1000
    // JARVIS 가 막 말을 마친 직후(메아리가 남는 시간)엔 버리지 않고 기록만 해 두고, 더 또렷한 소리만 말로 본다.
    // 예전엔 0.7초를 통째로 버려서 바로 대답하면 말 앞부분이 잘렸다.
    const echoTail = !this.recording && performance.now() - this.speakEndedAt < 700
    if (!this.recording && !echoTail) this.noise = VAD_TUNING.legacyNoise ? this.noise * 0.97 + rms * 0.03 : trackNoise(this.noise, rms, f.voiced)
    // 블루투스 헤드셋처럼 입력이 작은 마이크도 잡히도록 낮은 하한 + 주변 소음 대비 배수 (목소리 떨림 판정이 함께 걸러 준다)
    const threshold = Math.max(echoTail ? 0.02 : 0.005, this.noise * VAD_TUNING.noiseRatio * (echoTail ? 2 : 1))
    // 크기만이 아니라 "목소리"여야 한다 — 키보드 타건음·딸깍 소리는 주기성이 없어 걸러진다
    const voice = rms > threshold && f.voiced

    if (!this.recording) {
      const n = this.startWin.push(voice)
      if (n >= START_VOICED) {
        this.beginRecording()
        this.voicedFrames = n
        if (this.phase === 'awake') this.setPhase('recording')
      } else this.pushPreroll(buf)
      if (!this.recording && this.phase === 'awake' && !this.approvalHandler && !this.inConversation) this.setPhase('sleeping')
      return
    }

    this.chunks.push(new Float32Array(buf))
    // 말하는 도중: 목소리 프레임이 아니어도 주변 소음보다 확실히 크면 말이 이어지는 중 (자음·짧은 숨)
    // (키보드 타건음처럼 순간 충격음인 프레임은 제외)
    const steady = f.crest <= MAX_SPEECH_CREST && f.burst <= MAX_SPEECH_BURST
    const continuing = voice || (VAD_TUNING.continueOnEnergy && steady && rms > Math.max(0.004, this.noise * 2))
    if (voice) this.voicedFrames++
    if (continuing) this.silenceMs = 0
    else this.silenceMs += frameMs
    const total = this.chunks.length * frameMs
    if (this.silenceMs > VAD_TUNING.endSilenceMs || total > 15000) {
      this.recording = false
      this.startWin.reset()
      const audio = concat(this.chunks)
      this.chunks = []
      const voiced = this.voicedFrames
      let pk = 0
      for (let i = 0; i < audio.length; i += 4) pk = Math.max(pk, Math.abs(audio[i]))
      console.debug(`[voice] utterance ${Math.round(total)}ms voiced=${voiced} peak=${pk.toFixed(3)} noise=${this.noise.toFixed(4)} phase=${this.phase} ready=${this.ready} barge=${this.bargedIn}`)
      if (total > 350 && voiced >= MIN_UTTERANCE_VOICED) {
        // 발화는 들어온 순서대로 하나씩 처리 (앞 말과 합쳐야 할 수 있으므로)
        this.utterQueue = this.utterQueue.then(() => this.handleUtterance(audio)).catch((e) => console.debug('[voice] 발화 처리 오류', e))
      }
      else if (this.bargedIn || this.phase === 'recording') {
        this.bargedIn = false
        this.setPhase(this.conversation || this.approvalHandler || performance.now() < this.awakeUntil ? 'awake' : 'sleeping')
      }
    }
  }

  private pushPreroll(buf: Float32Array): void {
    this.preroll.push(new Float32Array(buf))
    // 말 시작 전 0.64초를 함께 보관 (첫 자음·첫 음절이 잘리지 않게)
    if (this.preroll.length > 10) this.preroll.shift()
  }

  private beginRecording(): void {
    this.recording = true
    this.silenceMs = 0
    this.chunks = this.preroll.slice()
    this.preroll = []
  }

  /** 말하는 중 사용자 목소리가 이어지면: 즉시 TTS 를 끊고 그 말을 명령으로 받는다 */
  private maybeBargeIn(voice: boolean): void {
    if (this.opts.bargeIn === false) return
    if (this.bargeWin.push(voice) < BARGE_VOICED) return
    console.debug('[voice] barge-in — TTS 중단, 사용자 말 듣기')
    this.bargeWin.reset()
    this.bargedIn = true
    this.beginRecording()
    this.voicedFrames = BARGE_VOICED
    this.setPhase('recording')
    this.queue = []
    this.cancelSpeech()
    this.cb.onBargeIn?.()
  }

  private async transcribe(audio: Float32Array): Promise<string> {
    if (this.native) {
      try {
        const copy = audio.slice()
        return await window.jarvis.stt.transcribe(copy.buffer)
      } catch (e) {
        console.debug('[voice] 네이티브 인식 실패, 기본 엔진으로', e)
        this.native = false
        this.ensureWorker()
      }
    }
    const id = ++this.reqId
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
      this.ensureWorker().postMessage({ type: 'transcribe', id, audio, language: this.opts.language }, [audio.buffer])
    })
  }

  private utterQueue: Promise<void> = Promise.resolve()
  /** 끝나지 않은 말 (이어지는 말을 기다리는 중) */
  private held: { audio: Float32Array; command: string; timer: ReturnType<typeof setTimeout> } | null = null

  /** 말이 끝나지 않은 것 같으면 잠깐 기다린다. 이어서 말하면 합쳐서 다시 인식, 아니면 그대로 실행 */
  private hold(audio: Float32Array, command: string): void {
    const ms = VAD_TUNING.holdUnfinishedMs
    const fire = (): void => {
      if (!this.held) return
      // 지금 이어서 말하는 중이면 그 말이 끝날 때 합쳐진다
      if (this.recording) {
        this.held.timer = setTimeout(fire, 250)
        return
      }
      const cmd = this.held.command
      this.held = null
      this.awakeUntil = 0
      this.earcon()
      this.cb.onCommand(cmd)
      this.expectReply()
      if (this.phase !== 'speaking' && !this.recording) this.setPhase(this.conversation ? 'awake' : 'sleeping')
    }
    this.held = { audio, command, timer: setTimeout(fire, ms) }
    this.awakeUntil = performance.now() + ms + 4000
    if (!this.recording) this.setPhase('awake')
    this.cb.onTranscript(`${command} …`, false)
  }

  private async handleUtterance(input: Float32Array): Promise<void> {
    let audio = input
    let continued = false
    if (this.held) {
      // 앞에서 끝나지 않았던 말에 이어서 말함 → 합쳐서 한 문장으로 다시 인식
      clearTimeout(this.held.timer)
      audio = concat([this.held.audio, input])
      this.held = null
      continued = true
    }
    if (!this.ready && this.phase === 'sleeping' && !this.approvalHandler && !continued) return // 모델 로딩 중에는 호출어 대기 생략
    const barged = this.bargedIn
    this.bargedIn = false
    // 대화 중인지는 화면 상태가 아니라 시간으로 판단 (상태 갱신이 늦어도 틀리지 않게)
    const wasAwake = continued || barged || this.phase === 'recording' || this.inConversation
    this.setPhase('transcribing')
    const text = await this.transcribe(audio)
    console.debug(`[voice] transcript: ${JSON.stringify(text)}`)
    this.saveSample(audio, text)
    if (barged && text && isEchoOf(text, this.spokenText)) {
      console.debug('[voice] barge-in 이 자기 목소리 메아리로 판정되어 무시')
      this.setPhase(this.conversation || this.approvalHandler || performance.now() < this.awakeUntil ? 'awake' : 'sleeping')
      return
    }
    if (!text || isLikelyHallucination(text)) {
      this.setPhase(this.conversation || performance.now() < this.awakeUntil ? 'awake' : 'sleeping')
      return
    }
    this.cb.onTranscript(text, true)
    if (this.approvalHandler) {
      this.approvalHandler(text)
      if (this.phase === 'transcribing') this.setPhase(this.hasApproval() || this.conversation ? 'awake' : 'sleeping')
      return
    }
    if (wasAwake) {
      const m = matchWakeWord(text, this.opts.wakeWords)
      // 깨어 있는 중에 이름만 불러도 (예: 창을 닫은 뒤 "자비스") 호출로 처리한다
      if (m.matched && !m.command) {
        this.awakeUntil = performance.now() + VAD_TUNING.wakeWindowMs
        this.followUpMs = VAD_TUNING.wakeWindowMs
        this.touchConversation()
        this.cb.onWake()
        this.setPhase('awake')
        return
      }
      const cmd = m.matched ? m.command : text
      if (cmd && VAD_TUNING.holdUnfinishedMs > 0 && looksUnfinished(cmd) && audio.length < SR * 13) return this.hold(audio, cmd)
      this.awakeUntil = 0
      if (cmd) {
        this.touchConversation()
        this.earcon()
        this.cb.onCommand(cmd)
        this.expectReply()
      }
      this.setPhase(this.inConversation ? 'awake' : 'sleeping')
      return
    }
    const m = matchWakeWord(text, this.opts.wakeWords)
    if (m.matched) {
      if (m.command && VAD_TUNING.holdUnfinishedMs > 0 && looksUnfinished(m.command) && audio.length < SR * 13) return this.hold(audio, m.command)
      if (m.command) {
        this.touchConversation()
        this.earcon()
        this.cb.onCommand(m.command)
        this.expectReply()
        this.setPhase('awake')
      } else {
        this.awakeUntil = performance.now() + VAD_TUNING.wakeWindowMs
        this.followUpMs = VAD_TUNING.wakeWindowMs
        this.touchConversation()
        this.cb.onWake()
        this.setPhase('awake')
      }
    } else this.setPhase('sleeping')
  }

  /** 학습용으로 말소리를 압축해 보낸다 (저장·잠금·민감한 순간 제외는 main 이 판단). 응답 속도에 영향 없게 뒤에서 */
  private saveSample(audio: Float32Array, heard: string): void {
    if (!this.native || !heard || audio.length < SR * 0.4) return
    const device = this.stream?.getAudioTracks?.()[0]?.label
    void encodeOpus(audio, SR)
      .then((packets) => {
        if (!packets) return
        return window.jarvis.stt.sample({ heard, packets: packets.map((p) => p.slice().buffer), sampleRate: SR, device })
      })
      .catch(() => undefined)
  }

  /** TTS — 하던 말을 끊고 새로 말한다 (대기열도 비움) */
  async speak(md: string): Promise<void> {
    const text = speakableText(md)
    if (!text) return
    this.clearReplyTimers()
    this.queue = []
    return this.say(text, true)
  }

  private async say(text: string, cancelCurrent: boolean): Promise<void> {
    // 사용자가 말하는 중이면 끝날 때까지 기다렸다가 말한다 (사용자 말이 먼저)
    await this.waitForUser()
    if (cancelCurrent) this.cancelSpeech()
    const token = this.speechToken
    // 사람 같은 목소리: main 에서 만든 소리를 받아 재생 (만드는 사이에 끊겼으면 버린다)
    const buf = await this.synth(text)
    this.synthCache.delete(text)
    if (token !== this.speechToken) return
    const prev = this.phase
    this.spokenText = text
    this.bargeWin.reset()
    if (buf) {
      const ok = await this.playBuffer(buf, prev, token)
      if (ok) return
    }
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text)
      const voices = speechSynthesis.getVoices()
      const voice = voices.find((v) => v.name === this.opts.ttsVoice) ?? voices.find((v) => v.lang.startsWith('ko')) ?? null
      if (voice) u.voice = voice
      u.lang = voice?.lang ?? 'ko-KR'
      u.rate = this.opts.ttsRate
      u.pitch = this.opts.ttsPitch ?? 0.95
      let pulse = 0
      const timer = setInterval(() => this.cb.onLevel(0.3 + Math.abs(Math.sin((pulse += 0.7))) * 0.5), 90)
      u.onboundary = () => this.cb.onLevel(0.9)
      const end = (): void => {
        clearInterval(timer)
        this.speakEndedAt = performance.now()
        if (!this.queue.length && performance.now() < this.convoUntil) this.touchConversation()
        // 마지막 문장까지 다 말했으면, 그때부터 이어서 듣기 시작
        if (this.followUpMs && !this.queue.length) {
          this.awakeUntil = Math.max(this.awakeUntil, performance.now() + this.followUpMs)
          this.followUpMs = 0
        }
        const listening = this.inConversation || this.approvalHandler
        if (this.phase === 'speaking') this.setPhase(this.stream ? (listening ? 'awake' : 'sleeping') : prev === 'speaking' ? 'off' : prev)
        resolve()
      }
      u.onend = end
      u.onerror = end
      this.setPhase('speaking')
      speechSynthesis.speak(u)
    })
  }

  /** 말을 마쳤을 때 공통 처리 */
  private finishSpeaking(prev: VoicePhase): void {
    this.speakEndedAt = performance.now()
    // JARVIS 가 말을 마쳤으면 대화가 이어지는 중 — 바로 대답해도 알아듣게
    if (!this.queue.length && performance.now() < this.convoUntil) this.touchConversation()
    if (this.followUpMs && !this.queue.length) {
      this.awakeUntil = Math.max(this.awakeUntil, performance.now() + this.followUpMs)
      this.followUpMs = 0
    }
    const listening = this.inConversation || this.approvalHandler
    if (this.phase === 'speaking') this.setPhase(this.stream ? (listening ? 'awake' : 'sleeping') : prev === 'speaking' ? 'off' : prev)
  }

  /** 만들어 받은 소리 재생. 재생하지 못하면 false (운영체제 목소리로) */
  private async playBuffer(buf: ArrayBuffer, prev: VoicePhase, token: number): Promise<boolean> {
    try {
      const ctx = (this.playCtx ??= new AudioContext())
      await ctx.resume().catch(() => undefined)
      const audio = await ctx.decodeAudioData(buf.slice(0))
      if (token !== this.speechToken) return true
      const src = ctx.createBufferSource()
      src.buffer = audio
      const rate = this.opts.ttsRate && Math.abs(this.opts.ttsRate - 1.05) > 0.02 ? this.opts.ttsRate / 1.05 : 1
      src.playbackRate.value = rate
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      src.connect(analyser)
      analyser.connect(ctx.destination)
      this.source = src
      this.setPhase('speaking')
      const data = new Uint8Array(analyser.frequencyBinCount)
      const timer = setInterval(() => {
        analyser.getByteTimeDomainData(data)
        let peak = 0
        for (const v of data) peak = Math.max(peak, Math.abs(v - 128))
        this.cb.onLevel(Math.min(1, 0.25 + (peak / 128) * 1.6))
      }, 60)
      await new Promise<void>((resolve) => {
        src.onended = () => resolve()
        src.start()
      })
      clearInterval(timer)
      if (this.source === src) this.source = null
      this.finishSpeaking(prev)
      return true
    } catch (e) {
      console.debug('[voice] 사람 같은 목소리 재생 실패 → 기본 목소리', e)
      return false
    }
  }

  private waitForUser(maxMs = 20000): Promise<void> {
    const busy = (): boolean => this.recording || this.phase === 'recording' || this.phase === 'transcribing'
    if (!busy()) return Promise.resolve()
    const until = performance.now() + maxMs
    return new Promise((resolve) => {
      const t = setInterval(() => {
        if (!busy() || performance.now() > until) {
          clearInterval(t)
          resolve()
        }
      }, 100)
    })
  }

  /** 사용할 마이크: 사용자가 고른 장치 → (덮개 닫힘/끊긴 장치가 있으면) 외장 마이크 → 시스템 기본 */
  private async pickDevice(): Promise<string | undefined> {
    const chosen = this.opts.inputDeviceId ?? undefined
    let list: MediaDeviceInfo[] = []
    try {
      list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
    } catch {
      /* 목록 못 읽으면 기본 */
    }
    const alive = list.filter((d) => !this.deadDevices.has(d.deviceId))
    if (chosen && alive.some((d) => d.deviceId === chosen)) return chosen
    const builtIn = (d: MediaDeviceInfo): boolean => isBuiltInLabel(d.label)
    if (this.opts.clamshell || this.deadDevices.size) {
      const ext = alive.find((d) => !builtIn(d))
      if (ext) return ext.deviceId
    }
    if (this.deadDevices.size) return alive[0]?.deviceId
    return chosen
  }

  /** 입력이 몇 초간 완전히 0 이면 하드웨어적으로 끊긴 마이크 (맥북 덮개 닫힘 등) → 다른 장치로 */
  private watchDead(buf: Float32Array): void {
    let peak = 0
    for (let i = 0; i < buf.length; i += 8) {
      const a = buf[i] < 0 ? -buf[i] : buf[i]
      if (a > peak) peak = a
    }
    this.framesSinceOpen++
    if (peak > 1e-6) {
      this.deadFrames = 0
      return
    }
    // 연결 직후(블루투스 통화 모드 전환 중)는 0 이 들어와도 끊김으로 보지 않는다
    if ((this.framesSinceOpen * buf.length) / SR < 3) return
    this.deadFrames++
    const ms = (this.deadFrames * buf.length * 1000) / SR
    if (ms < 2500 || !this.currentDevice || this.deadDevices.has(this.currentDevice)) return
    const label = this.stream?.getAudioTracks()[0]?.label ?? '마이크'
    // 블루투스·USB 마이크는 조용할 때 완전한 0 을 보내기도 한다 (노이즈 게이트) → 끊김 판정은 내장 마이크만
    if (!isBuiltInLabel(label)) return
    this.deadDevices.add(this.currentDevice)
    if (!this.warnedDead.has(this.currentDevice)) {
      this.warnedDead.add(this.currentDevice)
      this.cb.onError(
        this.opts.clamshell
          ? `맥북 덮개가 닫혀 있어 내장 마이크(${label})가 꺼져 있습니다. 블루투스 헤드셋·USB 마이크를 연결하면 바로 그걸로 듣겠습니다.`
          : `마이크(${label})에서 소리가 전혀 들어오지 않습니다. 다른 마이크로 바꿔 볼게요. 계속 안 되면 설정 → 마이크를 확인해 주세요.`
      )
    }
    this.scheduleRestart('dead')
  }

  /** 마이크 다시 연결 (장치 변경/끊김/잠자기 후) — 짧게 모아서 한 번만 */
  private pendingReason = ''

  scheduleRestart(reason: string, ms = 1200): void {
    if (!this.wanted) return
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.pendingReason = reason
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (reason === 'devicechange' || reason === 'resume' || reason === 'unlock') this.deadDevices.clear() // 새 장치가 생겼을 수 있음
      void this.restart(reason)
    }, ms)
  }

  async restart(reason = 'manual'): Promise<void> {
    if (!this.wanted) return
    console.debug(`[voice] 마이크 재연결 (${reason})`)
    const keepPhase = this.phase === 'off' ? 'sleeping' : this.phase
    this.node?.disconnect()
    this.stream?.getTracks().forEach((t) => {
      t.onended = null
      t.stop()
    })
    void this.ctx?.close()
    this.node = null
    this.stream = null
    this.ctx = null
    this.recording = false
    this.chunks = []
    await this.start()
    if (this.stream && keepPhase !== 'loading' && keepPhase !== 'recording' && keepPhase !== 'transcribing') this.setPhase(keepPhase)
  }

  stopSpeaking(): void {
    this.clearReplyTimers()
    this.queue = []
    this.cancelSpeech()
  }

  /** 지금 말하는 것 즉시 멈추기 (운영체제 목소리 + 사람 같은 목소리 둘 다) */
  private cancelSpeech(): void {
    this.speechToken++
    speechSynthesis.cancel()
    const src = this.source
    this.source = null
    try {
      src?.stop()
    } catch {
      /* 이미 끝남 */
    }
    this.synthCache.clear()
  }

  /** 문장 → 소리 (사람 같은 목소리). 같은 문장은 한 번만 만든다 */
  private synth(text: string): Promise<ArrayBuffer | null> {
    if (!this.opts.neural) return Promise.resolve(null)
    let p = this.synthCache.get(text)
    if (!p) {
      p = window.jarvis.tts.speak(text).catch(() => null)
      this.synthCache.set(text, p)
    }
    return p
  }

  /** 스트리밍 답변: 완성된 문장을 대기열에 넣으면 앞 문장이 끝나는 대로 이어서 읽는다 */
  enqueue(text: string): void {
    const t = speakableText(text, 600)
    if (!t) return
    this.clearReplyTimers()
    this.queue.push(t)
    if (!this.queueRunning) void this.drain()
  }

  /** 대기열이 다 읽힐 때까지 */
  async whenIdle(): Promise<void> {
    while (this.queueRunning || this.queue.length) await new Promise((r) => setTimeout(r, 100))
  }

  private async drain(): Promise<void> {
    this.queueRunning = true
    try {
      while (this.queue.length) {
        const next = this.queue.shift()!
        // 이 문장을 읽는 동안 다음 문장 소리를 미리 만든다 (문장 사이 끊김 없이)
        if (this.queue[0]) void this.synth(this.queue[0])
        await this.say(next, false)
      }
    } finally {
      this.queueRunning = false
    }
  }

  /** 짧은 "띵" — 말을 알아들었다는 즉시 신호 (응답이 오기 전 체감 지연 감소) */
  earcon(): void {
    const ctx = this.ctx
    if (!ctx) return
    // 알림음이 마이크로 다시 들어와 말로 인식되지 않게 잠깐 무시
    this.speakEndedAt = performance.now() + 250
    try {
      const t = ctx.currentTime
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.015)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22)
      g.connect(ctx.destination)
      for (const [f, d] of [
        [880, 0],
        [1320, 0.07]
      ] as const) {
        const o = ctx.createOscillator()
        o.type = 'sine'
        o.frequency.setValueAtTime(f, t + d)
        o.connect(g)
        o.start(t + d)
        o.stop(t + 0.24)
      }
    } catch {
      /* 무시 */
    }
  }
}

/**
 * 주변 소음 크기 추정 — 말소리에 끌려 올라가지 않게.
 * 조용해지면 빨리 내려가고, 목소리가 아닌 소리에만 천천히 올라간다 (목소리 프레임은 반영하지 않음).
 * 예전에는 말할 때마다 소음 추정이 2배 이상 올라가 멀리서 말한 목소리를 소음으로 걸러 버렸다.
 */
export function trackNoise(noise: number, rms: number, voiced: boolean): number {
  if (rms < noise) return noise * 0.85 + rms * 0.15
  if (voiced) return noise
  return noise * 0.99 + Math.min(rms, noise * 3) * 0.01
}

/** 맥북 내장 마이크인지 (덮개를 닫으면 하드웨어적으로 꺼지는 장치) */
export function isBuiltInLabel(label: string): boolean {
  // "외장 마이크 (Built-in)" 처럼 맥 이어폰 단자에 꽂은 마이크도 macOS 는 Built-in 이라 표시한다 → 외장으로 본다
  if (/외장|external|headset|헤드셋/i.test(label)) return false
  return /macbook|내장 마이크|built-?in microphone|internal/i.test(label)
}

/** 마이크 열기 실패 원인 → 사용자 안내 문구 */
export function micErrorMessage(e: { name?: string; message?: string }, clamshell: boolean): string {
  switch (e.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return '마이크 권한이 꺼져 있습니다. 시스템 설정 → 개인정보 보호 및 보안 → 마이크에서 JARVIS 를 켜 주세요. 켜면 자동으로 다시 연결합니다.'
    case 'NotFoundError':
    case 'OverconstrainedError':
      return clamshell
        ? '덮개가 닫혀 있고 연결된 외장 마이크가 없습니다. 블루투스 헤드셋·USB 마이크를 연결하면 바로 그걸로 듣겠습니다.'
        : '연결된 마이크가 없습니다. 마이크를 연결하면 자동으로 다시 연결합니다.'
    case 'NotReadableError':
    case 'AbortError':
      return '마이크를 여는 중 문제가 생겼습니다 (다른 앱이 쓰고 있거나 블루투스 전환 중). 잠시 뒤 자동으로 다시 연결합니다.'
    default:
      return `마이크를 사용할 수 없습니다: ${e.message || e.name || '알 수 없는 오류'}. 잠시 뒤 자동으로 다시 연결합니다.`
  }
}

function concat(chunks: Float32Array[]): Float32Array {
  const n = chunks.reduce((s, c) => s + c.length, 0)
  const out = new Float32Array(n)
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
  }
  return out
}
