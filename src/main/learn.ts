// 내 목소리 맞춤 학습 — 쓸수록 더 잘 알아듣게
//  1) 모인 말소리 중 정답이 믿을 만한 것만 고른다 (바로잡은 말 / 엔진이 확신한 말)
//  2) 이 컴퓨터에서 Whisper 에 작은 덧붙임 학습(LoRA) — 메모리 상한을 걸고 (학습 스크립트가 약 11GB 넘으면 멈춤)
//  3) whisper.cpp 형식으로 변환
//  4) 학습에 안 쓴 말소리로 지금 모델과 새 모델을 비교 → 실제로 더 잘 알아들을 때만 바꾼다
import { meaningFlipped } from './corrector'
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { findPythonTool } from './tts'
import type { VoiceSample } from './voicevault'

export const MIN_SAMPLES = 40
/** 자동 학습: 10분마다 확인, 5분 이상 쉬고 있을 때만, 첫 학습 뒤엔 쓸 만한 말소리가 60개 더 모일 때마다 */
export const AUTO_LEARN = { checkMs: 10 * 60_000, idleMs: 5 * 60_000, growth: 60 }

/** 자동 학습을 지금 해도 되는지 — 쉬고 있고(작업·대화 없음), 전원에 연결돼 있고, 새 말소리가 충분히 모였을 때 */
export function shouldAutoTrain(x: { learning: boolean; training: boolean; busy: boolean; idleMs: number; onBattery: boolean; usable: number; lastUsable: number }): boolean {
  if (!x.learning || x.training || x.busy || x.onBattery) return false
  if (x.idleMs < AUTO_LEARN.idleMs) return false
  if (x.usable < MIN_SAMPLES) return false
  return x.lastUsable === 0 || x.usable - x.lastUsable >= AUTO_LEARN.growth
}
export const PACKAGES = ['torch', 'transformers', 'peft', 'accelerate', 'soundfile', 'librosa', 'openai-whisper', 'safetensors', 'huggingface_hub']

/** 학습에 쓸 수 있는 샘플: 바로잡은 말, 또는 엔진이 확신한 말 (틀렸을 수 있는 말로 배우면 틀린 걸 더 굳힌다) */
export function usableSamples(all: VoiceSample[]): Array<{ s: VoiceSample; text: string }> {
  return all
    .map((s) => ({ s, text: (s.corrected ? s.final : s.heard)?.trim() ?? '' }))
    .filter(({ s, text }) => text.length >= 2 && s.packets.length > 10 && (s.corrected || (s.logprob !== undefined && s.logprob > -0.1)))
    // 교정기가 뜻을 뒤집은 정답("…네가 직접 해" → "…내가 직접 해")은 배우지 않는다
    .filter(({ s }) => !(s.corrected && s.final && meaningFlipped(s.heard, s.final)))
}

/** 학습용/평가용 나누기 — 평가용은 학습에 쓰지 않는다 (15%, 최소 5개) */
export function splitSamples<T>(items: T[], seed = 7): { train: T[]; evalSet: T[] } {
  const a = [...items]
  let x = seed
  for (let i = a.length - 1; i > 0; i--) {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    const j = x % (i + 1)
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  const n = Math.max(5, Math.round(a.length * 0.15))
  return { evalSet: a.slice(0, n), train: a.slice(n) }
}

// ── Opus 패킷 → Ogg 파일 (학습 도구가 읽는 표준 형식) ──
const CRC = new Uint32Array(256).map((_, i) => {
  let r = i << 24
  for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1
  return r >>> 0
})
function crc(b: Buffer): number {
  let c = 0
  for (const x of b) c = ((c << 8) ^ CRC[((c >>> 24) ^ x) & 0xff]) >>> 0
  return c
}
function page(data: Buffer, granule: number, serial: number, seq: number, type: number): Buffer {
  const segs: number[] = []
  let left = data.length
  while (left >= 255) {
    segs.push(255)
    left -= 255
  }
  segs.push(left)
  const h = Buffer.alloc(27 + segs.length)
  h.write('OggS', 0)
  h[5] = type
  h.writeBigInt64LE(BigInt(granule), 6)
  h.writeUInt32LE(serial, 14)
  h.writeUInt32LE(seq, 18)
  h[26] = segs.length
  segs.forEach((s, i) => (h[27 + i] = s))
  const p = Buffer.concat([h, data])
  p.writeUInt32LE(crc(p), 22)
  return p
}
export function opusToOgg(packets: Uint8Array[], sampleRate: number): Buffer {
  const serial = 0x4a565331
  const head = Buffer.alloc(19)
  head.write('OpusHead', 0)
  head[8] = 1
  head[9] = 1
  head.writeUInt16LE(312, 10)
  head.writeUInt32LE(sampleRate, 12)
  const vendor = Buffer.from('JARVIS')
  const tags = Buffer.concat([Buffer.from('OpusTags'), Buffer.from([vendor.length, 0, 0, 0]), vendor, Buffer.alloc(4)])
  const out = [page(head, 0, serial, 0, 2), page(tags, 0, serial, 1, 0)]
  let g = 0
  packets.forEach((p, i) => {
    g += 960
    out.push(page(Buffer.from(p), g, serial, i + 2, i === packets.length - 1 ? 4 : 0))
  })
  return Buffer.concat(out)
}

/** 글자 오류율 (공백·문장부호 무시) */
export function cer(ref: string, hyp: string): number {
  const n = (t: string): string[] => [...t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')]
  const a = n(ref)
  const b = n(hyp)
  if (!a.length) return b.length ? 1 : 0
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[b.length] / a.length
}

export interface LearnProgress {
  stage: 'install' | 'prepare' | 'train' | 'convert' | 'evaluate' | 'done' | 'error'
  message: string
  progress?: number
}

function run(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string }, onLine: (s: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: { ...process.env, ...opts.env }, cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let tail = ''
    let buf = ''
    const on = (d: Buffer): void => {
      const s = d.toString()
      tail = (tail + s).slice(-3000)
      buf += s
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() ?? ''
      for (const l of lines) if (l.trim()) onLine(l.trim())
    }
    p.stdout.on('data', on)
    p.stderr.on('data', on)
    p.on('error', reject)
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd.split('/').pop()} 실패 (${code}): ${tail.slice(-500)}`))))
  })
}

export class VoiceTrainer {
  constructor(
    private readonly dir: string,
    private readonly resources: string,
    private readonly onProgress: (p: LearnProgress) => void
  ) {}

  private get python(): string {
    return join(this.dir, 'venv', 'bin', 'python')
  }

  get installed(): boolean {
    return existsSync(join(this.dir, 'venv', '.jarvis-ok'))
  }

  /** 학습 도구 설치 (약 1GB, 처음 한 번) */
  async install(): Promise<void> {
    if (this.installed) return
    const tool = findPythonTool()
    if (!tool) throw new Error('파이썬 3.10 이상(또는 uv)이 필요합니다. 터미널에서 "brew install uv" 후 다시 시도해 주세요.')
    mkdirSync(this.dir, { recursive: true })
    const venv = join(this.dir, 'venv')
    this.onProgress({ stage: 'install', message: '학습 도구를 설치하는 중 (처음 한 번, 약 1GB)' })
    if (tool.kind === 'uv') {
      await run(tool.path, ['venv', '-q', '-p', '3.12', venv], {}, () => undefined)
      await run(tool.path, ['pip', 'install', '-q', ...PACKAGES], { env: { VIRTUAL_ENV: venv } }, () => undefined)
    } else {
      await run(tool.path, ['-m', 'venv', venv], {}, () => undefined)
      await run(join(venv, 'bin', 'pip'), ['install', '-q', ...PACKAGES], {}, () => undefined)
    }
    await run(this.python, ['-c', 'import torch, transformers, peft, whisper'], {}, () => undefined)
    writeFileSync(join(venv, '.jarvis-ok'), PACKAGES.join(' '))
  }

  /** 샘플 → 학습 폴더 (Ogg + items.jsonl). 평가용은 따로 표시 */
  prepare(items: Array<{ s: VoiceSample; text: string }>): { dataDir: string; train: number; evalItems: Array<{ audio: string; text: string }> } {
    const dataDir = join(this.dir, 'data')
    rmSync(dataDir, { recursive: true, force: true })
    mkdirSync(dataDir, { recursive: true })
    const { train, evalSet } = splitSamples(items)
    const lines: string[] = []
    const evalItems: Array<{ audio: string; text: string }> = []
    ;[...train.map((x) => ({ ...x, split: 'train' })), ...evalSet.map((x) => ({ ...x, split: 'eval' }))].forEach((x, i) => {
      const audio = join(dataDir, `${String(i).padStart(5, '0')}.ogg`)
      writeFileSync(audio, opusToOgg(x.s.packets, x.s.sampleRate))
      lines.push(JSON.stringify({ audio, text: x.text, split: x.split }))
      if (x.split === 'eval') evalItems.push({ audio, text: x.text })
    })
    writeFileSync(join(dataDir, 'items.jsonl'), lines.join('\n') + '\n')
    return { dataDir, train: train.length, evalItems }
  }

  /** 학습 → 변환. 결과: whisper.cpp 모델 파일 경로 */
  async train(dataDir: string, epochs = 3): Promise<string> {
    const out = join(this.dir, 'out')
    rmSync(out, { recursive: true, force: true })
    this.onProgress({ stage: 'train', message: '내 목소리로 학습을 시작합니다', progress: 0 })
    // 낮은 우선순위로 (학습하는 동안에도 JARVIS 가 느려지지 않게)
    await run('nice', ['-n', '10', this.python, join(this.resources, 'finetune_whisper.py'), '--data', dataDir, '--out', out, '--epochs', String(epochs)], {}, (line) => {
      try {
        const j = JSON.parse(line) as { stage: string; step?: number; total?: number; loss?: number }
        if (j.stage === 'train' && j.total) this.onProgress({ stage: 'train', message: `내 목소리로 학습 중 ${Math.round(((j.step ?? 0) / j.total) * 100)}%`, progress: Math.round(((j.step ?? 0) / j.total) * 100) })
        else if (j.stage === 'load') this.onProgress({ stage: 'train', message: '기본 모델을 불러오는 중 (처음엔 약 1.6GB 받기)' })
      } catch {
        /* 로그 줄 */
      }
    })
    this.onProgress({ stage: 'convert', message: '학습한 모델을 음성 엔진 형식으로 바꾸는 중' })
    const site = (await this.capture(this.python, ['-c', 'import whisper, os; print(os.path.dirname(os.path.dirname(whisper.__file__)))'])).trim()
    await run(this.python, [join(this.resources, 'convert_h5_to_ggml.py'), join(out, 'hf'), site, out], {}, () => undefined)
    const model = join(out, 'ggml-model.bin')
    if (!existsSync(model)) throw new Error('모델 변환 결과가 없습니다')
    // 큰 중간 파일은 지운다 (디스크 절약)
    rmSync(join(out, 'hf'), { recursive: true, force: true })
    return model
  }

  private capture(cmd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let o = ''
      p.stdout.on('data', (d) => (o += d))
      p.on('exit', (c) => (c === 0 ? resolve(o) : reject(new Error(`${cmd} 실패`))))
    })
  }

  /** 평가용 말소리를 16kHz PCM 으로 (Node 에서 Opus 를 풀지 않고 학습 환경의 파이썬으로) */
  async decode(audio: string[]): Promise<Float32Array[]> {
    const tmp = join(this.dir, 'eval-pcm')
    rmSync(tmp, { recursive: true, force: true })
    mkdirSync(tmp, { recursive: true })
    const script = `import sys, numpy as np, soundfile as sf, librosa\nfor i, p in enumerate(sys.argv[2:]):\n    a, sr = sf.read(p, dtype='float32')\n    a = a.mean(axis=1) if a.ndim > 1 else a\n    a = librosa.resample(a, orig_sr=sr, target_sr=16000) if sr != 16000 else a\n    a.astype('<f4').tofile(f"{sys.argv[1]}/{i}.f32")`
    await run(this.python, ['-c', script, tmp, ...audio], {}, () => undefined)
    return audio.map((_, i) => {
      const b = readFileSync(join(tmp, `${i}.f32`))
      return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
    })
  }

  /** 학습 때 꺼내 둔 말소리·문장(잠기지 않은 사본)을 지운다 — 학습이 끝나면 항상 */
  cleanup(): void {
    for (const d of ['data', 'eval-pcm']) rmSync(join(this.dir, d), { recursive: true, force: true })
  }

  /** 새 모델을 맞춤 모델 자리로 */
  adopt(model: string, modelsDir: string): string {
    mkdirSync(modelsDir, { recursive: true })
    const dest = join(modelsDir, 'ggml-personal.bin')
    if (existsSync(dest)) copyFileSync(dest, join(modelsDir, 'ggml-personal.prev.bin'))
    renameSync(model, dest)
    return dest
  }
}
