// JARVIS 목소리 엔진 — 마음대로 바꿔 쓰는 사람 같은 목소리
//   system     : 운영체제 기본 목소리 (renderer 의 speechSynthesis 로 재생, 여기서는 목록만)
//   supertonic : Supertonic 3 (오픈소스, 내 컴퓨터에서 실행, 145MB, 아주 빠름) — sherpa-onnx 로 JARVIS 안에서 직접
//   qwen3      : Qwen3-TTS (오픈소스, 맥 전용 MLX, 가장 사람 같음, 약 3GB) — JARVIS 가 띄우는 작은 로컬 서버
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { encodeWav } from './stt'

export type TtsEngineId = 'system' | 'supertonic' | 'qwen3'

export interface TtsVoice {
  id: string
  engine: TtsEngineId
  label: string
  desc: string
}

/** 고정 목록 (system 목소리는 운영체제 목록에서 따로) */
export const VOICE_CATALOG: TtsVoice[] = [
  { id: 'qwen3:sohee', engine: 'qwen3', label: '소희', desc: '여성 · 한국어 기본 목소리, 따뜻하고 감정이 풍부 (Qwen3)' },
  { id: 'qwen3:assistant', engine: 'qwen3', label: '비서', desc: '여성 · 밝고 따뜻한 20대 후반 비서 (Qwen3, 설계한 목소리)' },
  { id: 'qwen3:butler', engine: 'qwen3', label: '집사', desc: '남성 · 차분하고 정중한 30대 집사 (Qwen3, 설계한 목소리)' },
  { id: 'qwen3:serena', engine: 'qwen3', label: 'Serena', desc: '여성 (Qwen3)' },
  { id: 'qwen3:vivian', engine: 'qwen3', label: 'Vivian', desc: '여성 (Qwen3)' },
  { id: 'qwen3:ono_anna', engine: 'qwen3', label: 'Ono Anna', desc: '여성 (Qwen3)' },
  { id: 'qwen3:ryan', engine: 'qwen3', label: 'Ryan', desc: '남성 (Qwen3)' },
  { id: 'qwen3:aiden', engine: 'qwen3', label: 'Aiden', desc: '남성 (Qwen3)' },
  { id: 'qwen3:dylan', engine: 'qwen3', label: 'Dylan', desc: '남성 (Qwen3)' },
  { id: 'qwen3:eric', engine: 'qwen3', label: 'Eric', desc: '남성, 느린 편 (Qwen3)' },
  { id: 'qwen3:uncle_fu', engine: 'qwen3', label: 'Uncle Fu', desc: '남성, 중후함 (Qwen3)' },
  ...Array.from({ length: 10 }, (_, i): TtsVoice => ({ id: `supertonic:${i}`, engine: 'supertonic', label: `Supertonic 목소리 ${i + 1}`, desc: '내 컴퓨터에서 바로, 아주 빠름 (Supertonic 3)' }))
]

/** 사용자가 미리듣기에서 고른 목소리 (2026-11-24) */
export const DEFAULT_FAVORITES = ['qwen3:sohee', 'qwen3:assistant', 'supertonic:3', 'supertonic:6', 'supertonic:9']

/** 설계한 목소리(비서·집사)는 매번 같은 사람처럼 들리도록 기준 음성을 복제한다 */
const CLONE_REF_TEXT = '네, 알겠습니다. 오늘 일정은 오후 세 시 회의 하나뿐이에요. 다른 건 제가 정리해 둘게요.'
const CLONES: Record<string, string> = { assistant: 'assistant.wav', butler: 'butler.wav' }

export function voiceById(id: string | null | undefined): TtsVoice | null {
  return VOICE_CATALOG.find((v) => v.id === id) ?? null
}

/** 이 컴퓨터에서 쓸 수 있는 엔진 */
export function enginesFor(platform: NodeJS.Platform, arch: string): TtsEngineId[] {
  const out: TtsEngineId[] = ['system', 'supertonic']
  if (platform === 'darwin' && arch === 'arm64') out.push('qwen3')
  return out
}

export interface EngineState {
  engine: TtsEngineId
  state: 'missing' | 'installing' | 'ready' | 'error'
  message?: string
  progress?: number
}

// ── Supertonic 3 ─────────────────────────────────────────────
const ST_ARCHIVE = 'sherpa-onnx-supertonic-3-tts-int8-2026-05-11'
const ST_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/${ST_ARCHIVE}.tar.bz2`

interface SherpaTts {
  generate(o: { text: string; enableExternalBuffer: boolean; generationConfig: unknown }): { samples: Float32Array; sampleRate: number }
}

export class SupertonicEngine {
  private tts: SherpaTts | null = null
  private sherpa: { OfflineTts: new (c: unknown) => SherpaTts; GenerationConfig: new (c: unknown) => unknown } | null = null
  constructor(
    private readonly dir: string,
    private readonly onState: (s: EngineState) => void
  ) {}

  get modelDir(): string {
    return join(this.dir, ST_ARCHIVE)
  }

  get installed(): boolean {
    return existsSync(join(this.modelDir, 'voice.bin'))
  }

  /** 모델 받기 (145MB, 처음 한 번) */
  async install(): Promise<void> {
    if (this.installed) return
    mkdirSync(this.dir, { recursive: true })
    const archive = join(this.dir, `${ST_ARCHIVE}.tar.bz2`)
    this.onState({ engine: 'supertonic', state: 'installing', message: 'Supertonic 목소리 모델을 받는 중 (145MB)', progress: 0 })
    const res = await fetch(ST_URL)
    if (!res.ok || !res.body) throw new Error(`모델 다운로드 실패 HTTP ${res.status}`)
    const total = Number(res.headers.get('content-length') ?? 0)
    let got = 0
    let lastPct = -1
    const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream)
    body.on('data', (c: Buffer) => {
      got += c.length
      const pct = total ? Math.floor((got / total) * 100) : 0
      if (pct !== lastPct && pct % 5 === 0) {
        lastPct = pct
        this.onState({ engine: 'supertonic', state: 'installing', message: `Supertonic 목소리 모델을 받는 중 ${pct}%`, progress: pct })
      }
    })
    await pipeline(body, createWriteStream(archive))
    await new Promise<void>((resolve, reject) => execFile('tar', ['xf', archive, '-C', this.dir], (e) => (e ? reject(e) : resolve())))
    rmSync(archive, { force: true })
    if (!this.installed) throw new Error('모델 압축을 풀지 못했습니다')
    this.onState({ engine: 'supertonic', state: 'ready' })
  }

  private load(): SherpaTts {
    if (this.tts) return this.tts
    // 네이티브 모듈은 실행 시점에 불러온다 (ESM main 이라 createRequire)
    this.sherpa = createRequire(import.meta.url)('sherpa-onnx-node')
    const m = this.modelDir
    this.tts = new this.sherpa!.OfflineTts({
      model: {
        supertonic: { durationPredictor: `${m}/duration_predictor.int8.onnx`, textEncoder: `${m}/text_encoder.int8.onnx`, vectorEstimator: `${m}/vector_estimator.int8.onnx`, vocoder: `${m}/vocoder.int8.onnx`, ttsJson: `${m}/tts.json`, unicodeIndexer: `${m}/unicode_indexer.bin`, voiceStyle: `${m}/voice.bin` },
        debug: false,
        numThreads: 4,
        provider: 'cpu'
      },
      maxNumSentences: 1
    })
    return this.tts
  }

  /** 문장 → WAV */
  speak(text: string, sid: number, speed = 1): Buffer {
    const tts = this.load()
    // Electron 은 외부 메모리 버퍼를 허용하지 않는다 → enableExternalBuffer: false
    const a = tts.generate({ text, enableExternalBuffer: false, generationConfig: new this.sherpa!.GenerationConfig({ sid, speed, numSteps: 8, extra: { lang: 'ko' } }) })
    return encodeWav(a.samples, a.sampleRate)
  }
}

// ── Qwen3-TTS (로컬 서버) ─────────────────────────────────────
const MLX_AUDIO_VERSION = '0.6.8'

/** 설치에 쓸 도구: uv(파이썬까지 알아서 받음) → 파이썬 3.10 이상 */
export function findPythonTool(exists: (p: string) => boolean = existsSync): { kind: 'uv' | 'python'; path: string } | null {
  const home = homedir()
  for (const p of [join(home, '.local/bin/uv'), '/opt/homebrew/bin/uv', '/usr/local/bin/uv']) if (exists(p)) return { kind: 'uv', path: p }
  for (const v of ['3.13', '3.12', '3.11', '3.10']) for (const d of ['/opt/homebrew/bin', '/usr/local/bin']) if (exists(`${d}/python${v}`)) return { kind: 'python', path: `${d}/python${v}` }
  return null
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, onLine: (s: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let tail = ''
    const on = (d: Buffer): void => {
      const s = d.toString()
      tail = (tail + s).slice(-2000)
      for (const l of s.split(/\r?\n/)) if (l.trim()) onLine(l.trim())
    }
    p.stdout.on('data', on)
    p.stderr.on('data', on)
    p.on('error', reject)
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} 실패 (${code}): ${tail.slice(-400)}`))))
  })
}

export class Qwen3Engine {
  private proc: ChildProcess | null = null
  private port = 0
  private starting: Promise<boolean> | null = null
  constructor(
    private readonly dir: string,
    private readonly resources: string,
    private readonly onState: (s: EngineState) => void
  ) {}

  private get python(): string {
    return join(this.dir, 'venv', 'bin', 'python')
  }

  get installed(): boolean {
    return existsSync(join(this.dir, 'venv', '.jarvis-ok'))
  }

  /** 엔진 설치 (파이썬 환경 + mlx-audio). 모델(약 1.5GB씩)은 처음 쓸 때 받는다 */
  async install(): Promise<void> {
    if (this.installed) return
    const tool = findPythonTool()
    if (!tool) throw new Error('파이썬 3.10 이상(또는 uv)이 필요합니다. 터미널에서 "brew install uv" 후 다시 시도해 주세요.')
    mkdirSync(this.dir, { recursive: true })
    const venv = join(this.dir, 'venv')
    const say = (message: string): void => this.onState({ engine: 'qwen3', state: 'installing', message })
    say('Qwen3 목소리 엔진 준비 중 (파이썬 환경)')
    if (tool.kind === 'uv') {
      await run(tool.path, ['venv', '-q', '-p', '3.12', venv], {}, () => undefined)
      say('Qwen3 목소리 엔진 설치 중 (mlx-audio)')
      await run(tool.path, ['pip', 'install', '-q', `mlx-audio==${MLX_AUDIO_VERSION}`, 'soundfile'], { VIRTUAL_ENV: venv }, () => undefined)
    } else {
      await run(tool.path, ['-m', 'venv', venv], {}, () => undefined)
      say('Qwen3 목소리 엔진 설치 중 (mlx-audio)')
      await run(join(venv, 'bin', 'pip'), ['install', '-q', `mlx-audio==${MLX_AUDIO_VERSION}`, 'soundfile'], {}, () => undefined)
    }
    await run(this.python, ['-c', 'import mlx_audio, soundfile'], {}, () => undefined)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(venv, '.jarvis-ok'), MLX_AUDIO_VERSION)
    this.onState({ engine: 'qwen3', state: 'ready' })
  }

  /** 서버 띄우기 (이미 떠 있으면 그대로) */
  start(): Promise<boolean> {
    if (this.proc && this.port) return Promise.resolve(true)
    if (this.starting) return this.starting
    this.starting = new Promise<boolean>((resolve) => {
      if (!this.installed) return resolve(false)
      const p = spawn(this.python, [join(this.resources, 'qwen_server.py'), '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HF_HUB_DISABLE_TELEMETRY: '1', TOKENIZERS_PARALLELISM: 'false' } })
      this.proc = p
      let buf = ''
      const timer = setTimeout(() => resolve(false), 60_000)
      p.stdout.on('data', (d: Buffer) => {
        buf += d.toString()
        const line = buf.split('\n').find((l) => l.includes('"ready"'))
        if (line && !this.port) {
          try {
            this.port = Number(JSON.parse(line).port)
            clearTimeout(timer)
            resolve(true)
          } catch {
            /* 다음 줄 */
          }
        }
      })
      p.stderr.on('data', () => undefined)
      p.on('exit', () => {
        this.proc = null
        this.port = 0
        clearTimeout(timer)
        resolve(false)
      })
    }).finally(() => {
      this.starting = null
    })
    return this.starting
  }

  stop(): void {
    this.proc?.kill('SIGTERM')
    this.proc = null
    this.port = 0
  }

  private voiceSpec(key: string): Record<string, string> {
    if (CLONES[key]) return { kind: 'clone', ref_audio: join(this.resources, 'voices', CLONES[key]), ref_text: CLONE_REF_TEXT }
    return { kind: 'custom', speaker: key }
  }

  private async post(path: string, body: unknown, timeoutMs: number): Promise<Response> {
    if (!(await this.start())) throw new Error('Qwen3 목소리 엔진을 시작하지 못했습니다')
    return fetch(`http://127.0.0.1:${this.port}${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs) })
  }

  /** 모델을 미리 올려 둔다 (처음엔 모델 다운로드 포함, 수 분 걸릴 수 있음) */
  async warm(key: string): Promise<void> {
    const r = await this.post('/warm', { voice: this.voiceSpec(key) }, 30 * 60_000)
    if (!r.ok) throw new Error(`Qwen3 준비 실패: ${(await r.text()).slice(0, 200)}`)
  }

  async speak(text: string, key: string, speed = 1): Promise<Buffer> {
    const r = await this.post('/speak', { text, voice: this.voiceSpec(key), speed }, 120_000)
    if (!r.ok) throw new Error(`Qwen3 생성 실패: ${(await r.text()).slice(0, 200)}`)
    return Buffer.from(await r.arrayBuffer())
  }
}

// ── 묶음 ─────────────────────────────────────────────────────
export class TtsHub {
  readonly supertonic: SupertonicEngine
  readonly qwen3: Qwen3Engine
  constructor(userData: string, resources: string, onState: (s: EngineState) => void) {
    this.supertonic = new SupertonicEngine(join(userData, 'tts', 'supertonic'), onState)
    this.qwen3 = new Qwen3Engine(join(userData, 'tts', 'qwen3'), resources, onState)
  }

  installed(engine: TtsEngineId): boolean {
    if (engine === 'system') return true
    return engine === 'supertonic' ? this.supertonic.installed : this.qwen3.installed
  }

  async install(engine: TtsEngineId): Promise<void> {
    if (engine === 'supertonic') await this.supertonic.install()
    else if (engine === 'qwen3') await this.qwen3.install()
  }

  /** 목소리로 문장 만들기. system 이면 null (renderer 가 운영체제 목소리로 읽음) */
  async speak(voiceId: string, text: string, speed = 1): Promise<Buffer | null> {
    const v = voiceById(voiceId)
    if (!v || v.engine === 'system') return null
    const key = v.id.split(':')[1]
    if (v.engine === 'supertonic') {
      if (!this.supertonic.installed) await this.supertonic.install()
      return this.supertonic.speak(text, Number(key), speed)
    }
    if (!this.qwen3.installed) throw new Error('Qwen3 목소리 엔진이 설치되어 있지 않습니다')
    return this.qwen3.speak(text, key, speed)
  }

  async warm(voiceId: string): Promise<void> {
    const v = voiceById(voiceId)
    if (v?.engine === 'qwen3' && this.qwen3.installed) await this.qwen3.warm(v.id.split(':')[1])
    if (v?.engine === 'supertonic' && this.supertonic.installed) this.supertonic.speak('네.', Number(v.id.split(':')[1]))
  }

  stop(): void {
    this.qwen3.stop()
  }
}
