// 네이티브 음성 인식: whisper.cpp 서버(맥 Metal GPU / 윈도우 CPU)를 띄워 두고 발화마다 요청한다.
// 브라우저 내 Whisper 보다 수십 배 빠르다 (M 시리즈 기준 문장당 약 0.3초).
// 모델은 처음 한 번 내려받아 userData/models 에 저장 (실패 시 재시도, 이어받기).
import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { cpus } from 'node:os'
import { join } from 'node:path'

export interface SttModel {
  file: string
  url: string
  /** 대략 크기 (진행률 표시용) */
  bytes: number
  label: string
}

const HF = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'
export const MODELS: Record<string, SttModel> = {
  'large-v3-turbo': { file: 'ggml-large-v3-turbo-q5_0.bin', url: `${HF}/ggml-large-v3-turbo-q5_0.bin`, bytes: 574_041_195, label: 'Large v3 Turbo (정확, 약 570MB)' },
  'large-v3': { file: 'ggml-large-v3-q5_0.bin', url: `${HF}/ggml-large-v3-q5_0.bin`, bytes: 1_081_140_203, label: 'Large v3 (가장 정확, 약 1.1GB, 조금 느림)' },
  // 내 목소리 맞춤 모델 — 받는 게 아니라 이 컴퓨터에서 학습해 만든다 (없으면 기본 모델로)
  personal: { file: 'ggml-personal.bin', url: '', bytes: 0, label: '내 목소리 맞춤' },
  small: { file: 'ggml-small-q5_1.bin', url: `${HF}/ggml-small-q5_1.bin`, bytes: 190_085_487, label: 'Small (가벼움, 약 190MB)' }
}

/** 맥(GPU)은 정확한 turbo, 윈도우(CPU)는 가벼운 small 이 기본 */
export function defaultModelKey(): string {
  return process.platform === 'darwin' ? 'large-v3' : 'small'
}

/** 16kHz mono Float32 → 16bit PCM WAV */
export function encodeWav(pcm: Float32Array, rate = 16000): Buffer {
  const data = Buffer.alloc(pcm.length * 2)
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]))
    data.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), i * 2)
  }
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}

/** 인식 힌트(어휘): 이름·프로젝트·앱 이름을 알려 주면 고유명사를 훨씬 잘 맞힌다. Whisper 프롬프트 한도 안으로 자른다 */
export interface TranscribeOptions {
  /** 빔 서치 폭 (1 이하 = 그리디). 크면 정확하지만 조금 느리다 */
  beamSize?: number
  /** 작게 들어온 소리(블루투스 헤드셋 등)를 일정한 크기로 키워서 보낸다 */
  normalize?: boolean
}
export const DEFAULT_TRANSCRIBE: TranscribeOptions = { beamSize: 5, normalize: true }

/** 소리 크기 맞추기: 최댓값이 0.9 가 되도록 (최대 20배까지만 — 잡음만 키우지 않게) */
export function normalizeGain(pcm: Float32Array, target = 0.9, maxGain = 20): Float32Array {
  let peak = 0
  for (let i = 0; i < pcm.length; i++) {
    const a = Math.abs(pcm[i])
    if (a > peak) peak = a
  }
  if (peak < 1e-5) return pcm
  const g = Math.min(maxGain, target / peak)
  if (g <= 1.05) return pcm
  const out = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] * g
  return out
}

export function buildVocabPrompt(words: string[], maxChars = 180): string {
  const seen = new Set<string>()
  const out: string[] = []
  let len = 0
  for (const w of words) {
    const t = w.trim()
    const k = t.toLowerCase()
    if (!t || seen.has(k)) continue
    if (len + t.length + 2 > maxChars) break
    seen.add(k)
    out.push(t)
    len += t.length + 2
  }
  return out.join(', ')
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.unref()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port
      s.close(() => resolve(p))
    })
  })
}

export type SttState = { state: 'missing-binary' | 'downloading' | 'starting' | 'ready' | 'error'; progress?: number; message?: string; model?: string }

export class NativeStt {
  private proc: ChildProcess | null = null
  private port = 0
  private starting: Promise<boolean> | null = null
  state: SttState = { state: 'starting' }

  constructor(
    private readonly opts: {
      binary: string
      modelsDir: string
      modelKey: () => string
      onState: (s: SttState) => void
    }
  ) {}

  private set(s: SttState): void {
    this.state = s
    this.opts.onState(s)
  }

  get available(): boolean {
    return existsSync(this.opts.binary)
  }

  get ready(): boolean {
    return this.state.state === 'ready' && !!this.proc
  }

  /** 모델 내려받기 (이어받기 + 최대 5회 재시도) */
  private async ensureModel(m: SttModel): Promise<string> {
    const dest = join(this.opts.modelsDir, m.file)
    if (existsSync(dest) && statSync(dest).size > m.bytes * 0.95) return dest
    if (!m.url) throw new Error(`${m.label} 모델 파일이 없습니다`)
    mkdirSync(this.opts.modelsDir, { recursive: true })
    const part = `${dest}.part`
    let lastErr = ''
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const have = existsSync(part) ? statSync(part).size : 0
        const res = await fetch(m.url, { headers: have ? { Range: `bytes=${have}-` } : {}, redirect: 'follow' })
        if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`)
        const append = res.status === 206 && have > 0
        const total = append ? have + Number(res.headers.get('content-length') ?? 0) : Number(res.headers.get('content-length') ?? m.bytes)
        const out = createWriteStream(part, { flags: append ? 'a' : 'w' })
        let got = append ? have : 0
        let lastPct = -1
        const reader = res.body!.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          got += value.length
          if (!out.write(value)) await new Promise((r) => out.once('drain', r))
          const pct = Math.floor((got / total) * 100)
          if (pct !== lastPct) {
            lastPct = pct
            this.set({ state: 'downloading', progress: pct, model: m.label })
          }
        }
        await new Promise<void>((r, j) => out.end((e?: Error | null) => (e ? j(e) : r())))
        if (statSync(part).size < m.bytes * 0.95) throw new Error('파일이 덜 받아졌습니다')
        renameSync(part, dest)
        return dest
      } catch (e) {
        lastErr = (e as Error).message
        this.set({ state: 'downloading', progress: undefined, model: m.label, message: `다운로드 재시도 ${attempt}/5 (${lastErr})` })
        await new Promise((r) => setTimeout(r, 1500 * attempt))
      }
    }
    throw new Error(`음성 인식 모델을 받지 못했습니다: ${lastErr}`)
  }

  start(): Promise<boolean> {
    if (this.ready) return Promise.resolve(true)
    if (this.starting) return this.starting
    this.starting = (async () => {
      if (!this.available) {
        this.set({ state: 'missing-binary', message: '네이티브 음성 엔진이 없어 기본 엔진을 씁니다' })
        return false
      }
      const key = this.opts.modelKey()
      let m = MODELS[key] ?? MODELS[defaultModelKey()]
      // 맞춤 모델 파일이 없으면 기본 모델로
      if (!m.url && !existsSync(join(this.opts.modelsDir, m.file))) m = MODELS[defaultModelKey()]
      try {
        const model = await this.ensureModel(m)
        this.set({ state: 'starting', model: m.label })
        this.port = await freePort()
        const threads = String(Math.max(2, Math.min(8, cpus().length - 2)))
        this.proc = spawn(this.opts.binary, ['-m', model, '-l', 'ko', '--host', '127.0.0.1', '--port', String(this.port), '-t', threads, '-nt'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
        let stderr = ''
        this.proc.stderr?.on('data', (d) => (stderr = (stderr + String(d)).slice(-2000)))
        this.proc.on('exit', (code) => {
          this.proc = null
          if (this.state.state === 'ready') this.set({ state: 'error', message: `음성 엔진이 종료됨 (code ${code}) — 다시 시작합니다` })
          this.starting = null
        })
        // 준비될 때까지 대기 (모델 로드)
        const t0 = Date.now()
        while (Date.now() - t0 < 60_000) {
          if (!this.proc) throw new Error(`음성 엔진 시작 실패: ${stderr.split('\n').slice(-3).join(' ')}`)
          try {
            const r = await fetch(`http://127.0.0.1:${this.port}/`)
            if (r.ok) {
              this.set({ state: 'ready', model: m.label })
              return true
            }
          } catch {
            /* 아직 */
          }
          await new Promise((r) => setTimeout(r, 300))
        }
        throw new Error('음성 엔진 시작 시간 초과')
      } catch (e) {
        this.set({ state: 'error', message: (e as Error).message })
        this.stop()
        return false
      } finally {
        this.starting = null
      }
    })()
    return this.starting
  }

  async transcribe(pcm: Float32Array, prompt = '', opts: TranscribeOptions = DEFAULT_TRANSCRIBE): Promise<string> {
    return (await this.transcribeDetailed(pcm, prompt, opts)).text
  }

  /** 받아 적은 문장 + 엔진의 확신도(avg_logprob, 0 에 가까울수록 확신. 보통 -0.12 아래면 틀렸을 가능성이 큼) */
  async transcribeDetailed(pcm: Float32Array, prompt = '', opts: TranscribeOptions = DEFAULT_TRANSCRIBE): Promise<{ text: string; logprob: number }> {
    if (!this.ready && !(await this.start())) throw new Error(this.state.message ?? '음성 엔진 준비 안 됨')
    const fd = new FormData()
    const audio = opts.normalize ? normalizeGain(pcm) : pcm
    fd.append('file', new Blob([new Uint8Array(encodeWav(audio))], { type: 'audio/wav' }), 'speech.wav')
    fd.append('language', 'ko')
    fd.append('temperature', '0')
    if (opts.beamSize && opts.beamSize > 1) fd.append('beam_size', String(opts.beamSize))
    fd.append('response_format', 'verbose_json')
    if (prompt) fd.append('prompt', prompt)
    const r = await fetch(`http://127.0.0.1:${this.port}/inference`, { method: 'POST', body: fd })
    if (!r.ok) throw new Error(`인식 실패 HTTP ${r.status}`)
    const j = JSON.parse((await r.text()).replace(/[\u0000-\u001f]+/g, ' ')) as { text?: string; error?: string; segments?: Array<{ avg_logprob?: number }> }
    if (j.error) throw new Error(j.error)
    const lps = (j.segments ?? []).map((x) => x.avg_logprob ?? 0)
    return { text: (j.text ?? '').replace(/\s+/g, ' ').trim(), logprob: lps.length ? Math.min(...lps) : 0 }
  }

  stop(): void {
    this.proc?.kill()
    this.proc = null
  }

  /** 모델을 바꾸면 다시 시작 */
  async restart(): Promise<boolean> {
    this.stop()
    await new Promise((r) => setTimeout(r, 200))
    return this.start()
  }
}

export function sttBinaryPath(appPath: string, resourcesPath: string, packaged: boolean): string {
  const exe = process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server'
  const dir = `${process.platform}-${process.arch}`
  return packaged ? join(resourcesPath, 'bin', dir, exe) : join(appPath, 'resources', 'bin', dir, exe)
}
