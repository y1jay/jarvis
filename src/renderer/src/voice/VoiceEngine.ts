// 마이크 → VAD(발화 구간 검출) → Whisper → 호출어/명령 판정, 그리고 TTS.
import { isEchoOf, isLikelyHallucination, matchWakeWord, speakableText } from './text'
import { analyzeFrame, VoicedWindow } from './vad'

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
  private onDeviceChange = (): void => this.scheduleRestart('devicechange')
  /** 승인 대기 중이면 발화를 명령 대신 여기로 보낸다 (호출어 불필요) */
  private approvalHandler: ((text: string) => void) | null = null
  /** 버튼으로 켠 대화 모드: 호출어 없이 바로 명령 */
  private conversation = false

  constructor(
    private opts: VoiceOptions,
    private readonly cb: VoiceCallbacks
  ) {}

  updateOptions(o: Partial<VoiceOptions>): void {
    this.opts = { ...this.opts, ...o }
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
    if (this.stream) return
    this.setPhase('loading')
    await this.initRecognizer()
    try {
      await window.jarvis.media.request('microphone')
      const audio: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
      const dev = await this.pickDevice()
      if (dev) audio.deviceId = { exact: dev }
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio })
      } catch (e) {
        // 고른 마이크가 사라졌으면(블루투스 해제 등) 기본 마이크로
        if (!audio.deviceId) throw e
        delete audio.deviceId
        this.stream = await navigator.mediaDevices.getUserMedia({ audio })
      }
    } catch (e) {
      this.setPhase('off')
      this.cb.onError(`마이크를 사용할 수 없습니다: ${(e as Error).message}`)
      return
    }
    const track = this.stream.getAudioTracks()[0]
    this.currentDevice = track?.getSettings().deviceId
    this.deadFrames = 0
    // 장치가 빠지거나(블루투스 끊김) 새로 꽂히면 자동으로 다시 연결
    if (track) track.onended = () => this.scheduleRestart('ended')
    navigator.mediaDevices.removeEventListener?.('devicechange', this.onDeviceChange)
    navigator.mediaDevices.addEventListener?.('devicechange', this.onDeviceChange)
    this.ctx = new AudioContext({ sampleRate: SR })
    await this.ctx.resume().catch(() => undefined)
    console.debug(`[voice] mic started sr=${this.ctx.sampleRate} state=${this.ctx.state} track=${this.stream.getAudioTracks()[0]?.label}`)
    const src = this.ctx.createMediaStreamSource(this.stream)
    this.node = this.ctx.createScriptProcessor(1024, 1, 1)
    this.node.onaudioprocess = (e) => this.onAudio(e.inputBuffer.getChannelData(0))
    src.connect(this.node)
    this.node.connect(this.ctx.destination)
    this.conversation = !this.opts.wakeWordEnabled
    this.setPhase(this.conversation ? 'awake' : 'sleeping')
  }

  stop(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer)
    navigator.mediaDevices?.removeEventListener?.('devicechange', this.onDeviceChange)
    this.node?.disconnect()
    this.stream?.getTracks().forEach((t) => t.stop())
    void this.ctx?.close()
    this.node = null
    this.stream = null
    this.ctx = null
    this.recording = false
    this.chunks = []
    speechSynthesis.cancel()
    this.setPhase('off')
  }

  /** 호출어 없이 바로 듣기 (버튼/단축키/주먹 제스처) */
  async wake(): Promise<void> {
    if (!this.stream) await this.start()
    if (!this.stream) return
    speechSynthesis.cancel()
    this.awakeUntil = performance.now() + 10000
    this.setPhase('awake')
    this.cb.onWake()
  }

  /** 호출어 없이 다음 말을 바로 명령으로 받는다 (정지 직후 등) */
  keepAwake(ms = 10000): void {
    if (!this.stream) return
    this.awakeUntil = performance.now() + ms
    if (!this.recording && this.phase !== 'speaking' && this.phase !== 'transcribing') this.setPhase('awake')
  }

  private hasApproval(): boolean {
    return this.approvalHandler !== null
  }

  get listening(): boolean {
    return !!this.stream
  }

  private captureToken = 0

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
      this.maybeBargeIn(f.voiced && rms > Math.max(0.015, this.noise * 4))
      return
    }
    if (this.phase === 'transcribing' || this.phase === 'loading') return

    const frameMs = (buf.length / SR) * 1000
    if (!this.recording && performance.now() - this.speakEndedAt < 700) return
    if (!this.recording) this.noise = this.noise * 0.97 + rms * 0.03
    // 블루투스 헤드셋처럼 입력이 작은 마이크도 잡히도록 낮은 하한 + 주변 소음 대비 2.5배
    const threshold = Math.max(0.005, this.noise * 2.5)
    // 크기만이 아니라 "목소리"여야 한다 — 키보드 타건음·딸깍 소리는 주기성이 없어 걸러진다
    const voice = rms > threshold && f.voiced

    if (!this.recording) {
      const n = this.startWin.push(voice)
      if (n >= START_VOICED) {
        this.beginRecording()
        this.voicedFrames = n
        if (this.phase === 'awake') this.setPhase('recording')
      } else this.pushPreroll(buf)
      if (!this.recording && this.phase === 'awake' && !this.conversation && !this.approvalHandler && performance.now() > this.awakeUntil) this.setPhase('sleeping')
      return
    }

    this.chunks.push(new Float32Array(buf))
    if (voice) {
      this.voicedFrames++
      this.silenceMs = 0
    } else this.silenceMs += frameMs
    const total = this.chunks.length * frameMs
    if (this.silenceMs > 600 || total > 15000) {
      this.recording = false
      this.startWin.reset()
      const audio = concat(this.chunks)
      this.chunks = []
      const voiced = this.voicedFrames
      console.debug(`[voice] utterance ${Math.round(total)}ms voiced=${voiced} phase=${this.phase} ready=${this.ready} barge=${this.bargedIn}`)
      if (total > 350 && voiced >= MIN_UTTERANCE_VOICED) void this.handleUtterance(audio)
      else if (this.bargedIn || this.phase === 'recording') {
        this.bargedIn = false
        this.setPhase(this.conversation || this.approvalHandler || performance.now() < this.awakeUntil ? 'awake' : 'sleeping')
      }
    }
  }

  private pushPreroll(buf: Float32Array): void {
    this.preroll.push(new Float32Array(buf))
    if (this.preroll.length > 7) this.preroll.shift()
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
    speechSynthesis.cancel()
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

  private async handleUtterance(audio: Float32Array): Promise<void> {
    if (!this.ready && this.phase === 'sleeping' && !this.approvalHandler) return // 모델 로딩 중에는 호출어 대기 생략
    const barged = this.bargedIn
    this.bargedIn = false
    const wasAwake = barged || this.phase === 'recording' || this.phase === 'awake' || this.conversation || performance.now() < this.awakeUntil
    this.setPhase('transcribing')
    const text = await this.transcribe(audio)
    console.debug(`[voice] transcript: ${JSON.stringify(text)}`)
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
      const cmd = m.matched ? m.command : text
      this.awakeUntil = 0
      if (cmd) {
        this.earcon()
        this.cb.onCommand(cmd)
      }
      this.setPhase(this.conversation ? 'awake' : 'sleeping')
      return
    }
    const m = matchWakeWord(text, this.opts.wakeWords)
    if (m.matched) {
      if (m.command) {
        this.earcon()
        this.cb.onCommand(m.command)
        this.setPhase('sleeping')
      } else {
        this.awakeUntil = performance.now() + 10000
        this.cb.onWake()
        this.setPhase('awake')
      }
    } else this.setPhase('sleeping')
  }

  /** TTS — 하던 말을 끊고 새로 말한다 (대기열도 비움) */
  async speak(md: string): Promise<void> {
    const text = speakableText(md)
    if (!text) return
    this.queue = []
    return this.say(text, true)
  }

  private async say(text: string, cancelCurrent: boolean): Promise<void> {
    // 사용자가 말하는 중이면 끝날 때까지 기다렸다가 말한다 (사용자 말이 먼저)
    await this.waitForUser()
    if (cancelCurrent) speechSynthesis.cancel()
    const prev = this.phase
    this.spokenText = text
    this.bargeWin.reset()
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
        if (this.phase === 'speaking') this.setPhase(this.stream ? (this.conversation || this.approvalHandler ? 'awake' : 'sleeping') : prev === 'speaking' ? 'off' : prev)
        resolve()
      }
      u.onend = end
      u.onerror = end
      this.setPhase('speaking')
      speechSynthesis.speak(u)
    })
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
    const builtIn = (d: MediaDeviceInfo): boolean => /built-?in|내장|macbook/i.test(d.label)
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
    if (peak > 1e-6) {
      this.deadFrames = 0
      return
    }
    this.deadFrames++
    const ms = (this.deadFrames * buf.length * 1000) / SR
    if (ms < 2500 || !this.currentDevice || this.deadDevices.has(this.currentDevice)) return
    this.deadDevices.add(this.currentDevice)
    const label = this.stream?.getAudioTracks()[0]?.label ?? '마이크'
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
  scheduleRestart(reason: string, ms = 1200): void {
    if (!this.stream) return
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (reason === 'devicechange' || reason === 'resume' || reason === 'unlock') this.deadDevices.clear() // 새 장치가 생겼을 수 있음
      void this.restart(reason)
    }, ms)
  }

  async restart(reason = 'manual'): Promise<void> {
    if (!this.stream) return
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
    this.queue = []
    speechSynthesis.cancel()
  }

  /** 스트리밍 답변: 완성된 문장을 대기열에 넣으면 앞 문장이 끝나는 대로 이어서 읽는다 */
  enqueue(text: string): void {
    const t = speakableText(text, 600)
    if (!t) return
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
