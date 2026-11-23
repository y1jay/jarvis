// 마이크 → VAD(발화 구간 검출) → Whisper → 호출어/명령 판정, 그리고 TTS.
import { isLikelyHallucination, matchWakeWord, speakableText } from './text'

export type VoicePhase = 'off' | 'loading' | 'sleeping' | 'awake' | 'recording' | 'transcribing' | 'speaking'

export interface VoiceOptions {
  model: string
  language: string
  wakeWords: string[]
  wakeWordEnabled: boolean
  ttsVoice: string | null
  ttsRate: number
  ttsPitch?: number
}

export interface VoiceCallbacks {
  onPhase: (p: VoicePhase) => void
  onLevel: (v: number) => void
  onTranscript: (text: string, final: boolean) => void
  onCommand: (text: string) => void
  onWake: () => void
  onProgress: (msg: string) => void
  onError: (msg: string) => void
}

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
  private speechFrames = 0
  private silenceMs = 0
  private recording = false
  private noise = 0.008
  private awakeUntil = 0
  private reqId = 0
  private pending = new Map<number, (t: string) => void>()
  private ready = false
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
        if (m.status === 'progress' && m.file) this.cb.onProgress(`음성 모델 다운로드 ${m.file} ${Math.round(m.progress ?? 0)}%`)
      } else if (m.type === 'ready') {
        this.ready = true
        this.cb.onProgress(`음성 인식 준비 완료 (${m.device})`)
      } else if (m.type === 'result') {
        this.pending.get(m.id)?.(m.text)
        this.pending.delete(m.id)
      } else if (m.type === 'error') {
        if (m.id !== undefined) {
          this.pending.get(m.id)?.('')
          this.pending.delete(m.id)
        }
        this.cb.onError(`음성 인식 오류: ${m.message}`)
      }
    }
    w.postMessage({ type: 'load', model: this.opts.model, ortBase: new URL('./ort/', window.location.href).href })
    this.worker = w
    return w
  }

  /** 마이크를 켠다. wakeWordEnabled 면 '자비스' 대기, 아니면 대화 모드 */
  async start(): Promise<void> {
    if (this.stream) return
    this.setPhase('loading')
    this.ensureWorker()
    try {
      await window.jarvis.media.request('microphone')
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } })
    } catch (e) {
      this.setPhase('off')
      this.cb.onError(`마이크를 사용할 수 없습니다: ${(e as Error).message}`)
      return
    }
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
    let sum = 0
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
    const rms = Math.sqrt(sum / buf.length)
    this.cb.onLevel(Math.min(1, rms * 12))
    if (this.phase === 'speaking' || this.phase === 'transcribing' || this.phase === 'loading') return

    const frameMs = (buf.length / SR) * 1000
    if (!this.recording && performance.now() - this.speakEndedAt < 700) return
    if (!this.recording) this.noise = this.noise * 0.97 + rms * 0.03
    const threshold = Math.max(0.012, this.noise * 3)

    if (rms > threshold) {
      this.speechFrames++
      this.silenceMs = 0
      if (!this.recording && this.speechFrames >= 2) {
        this.recording = true
        this.chunks = this.preroll.slice()
        if (this.phase === 'awake') this.setPhase('recording')
      }
    } else {
      this.speechFrames = 0
      if (this.recording) this.silenceMs += frameMs
    }
    if (!this.recording) {
      this.preroll.push(new Float32Array(buf))
      if (this.preroll.length > 7) this.preroll.shift()
    }
    if (this.recording) {
      this.chunks.push(new Float32Array(buf))
      const total = this.chunks.length * frameMs
      if (this.silenceMs > 850 || total > 15000) {
        this.recording = false
        const audio = concat(this.chunks)
        this.chunks = []
        console.debug(`[voice] utterance ${Math.round(total)}ms phase=${this.phase} ready=${this.ready}`)
        if (total > 350) void this.handleUtterance(audio)
      }
    } else if (this.phase === 'awake' && !this.conversation && !this.approvalHandler && performance.now() > this.awakeUntil) {
      this.setPhase('sleeping')
    }
  }

  private transcribe(audio: Float32Array): Promise<string> {
    const id = ++this.reqId
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
      this.ensureWorker().postMessage({ type: 'transcribe', id, audio, language: this.opts.language }, [audio.buffer])
    })
  }

  private async handleUtterance(audio: Float32Array): Promise<void> {
    if (!this.ready && this.phase === 'sleeping' && !this.approvalHandler) return // 모델 로딩 중에는 호출어 대기 생략
    const wasAwake = this.phase === 'recording' || this.phase === 'awake' || this.conversation || performance.now() < this.awakeUntil
    this.setPhase('transcribing')
    const text = await this.transcribe(audio)
    console.debug(`[voice] transcript: ${JSON.stringify(text)}`)
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
      if (cmd) this.cb.onCommand(cmd)
      this.setPhase(this.conversation ? 'awake' : 'sleeping')
      return
    }
    const m = matchWakeWord(text, this.opts.wakeWords)
    if (m.matched) {
      if (m.command) {
        this.cb.onCommand(m.command)
        this.setPhase('sleeping')
      } else {
        this.awakeUntil = performance.now() + 10000
        this.cb.onWake()
        this.setPhase('awake')
      }
    } else this.setPhase('sleeping')
  }

  /** TTS — 말하는 동안에는 마이크 입력을 무시(자기 목소리 인식 방지) */
  speak(md: string): Promise<void> {
    const text = speakableText(md)
    if (!text) return Promise.resolve()
    speechSynthesis.cancel()
    const prev = this.phase
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

  stopSpeaking(): void {
    speechSynthesis.cancel()
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
