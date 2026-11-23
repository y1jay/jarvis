// 사람 목소리 판별 (순수 함수) — 소리 크기만 보면 키보드 타건음도 "말"로 잡힌다.
// 목소리(모음)는 성대 진동 때문에 80~400Hz 기본 주파수로 주기적이고, 타건음·잡음은 주기성이 없다.

export interface FrameInfo {
  rms: number
  /** 80~400Hz 대역 정규화 자기상관 최대값 (0~1). 모음은 보통 0.5 이상, 타건음/잡음은 낮다 */
  periodicity: number
  /** 최대 진폭 / rms — 순간 충격음(타건)은 크다 */
  crest: number
  /** 16 등분한 구간 중 에너지 상위 4 구간(=프레임의 1/4)에 몰린 비율 (0.25~1).
   *  순간 "딸깍/똑" 하고 사라지는 타건음은 거의 1, 이어지는 목소리는 낮다 */
  burst: number
  /** 주기적이고 충격음이 아닌 프레임 = 목소리 후보 */
  voiced: boolean
}

export const VOICED_PERIODICITY = 0.5
export const MAX_SPEECH_CREST = 7
export const MAX_SPEECH_BURST = 0.82
const SUB_BLOCKS = 16
const TOP_BLOCKS = 4

export function analyzeFrame(buf: Float32Array, sampleRate = 16000): FrameInfo {
  const n = buf.length
  let mean = 0
  for (let i = 0; i < n; i++) mean += buf[i]
  mean /= n
  const x = new Float32Array(n)
  let energy = 0
  let peak = 0
  for (let i = 0; i < n; i++) {
    const v = buf[i] - mean
    x[i] = v
    energy += v * v
    const a = v < 0 ? -v : v
    if (a > peak) peak = a
  }
  const rms = Math.sqrt(energy / n)
  if (rms < 1e-6) return { rms, periodicity: 0, crest: 0, burst: 0, voiced: false }
  const crest = peak / rms
  const blk = Math.floor(n / SUB_BLOCKS)
  const blocks: number[] = []
  for (let b = 0; b < SUB_BLOCKS; b++) {
    let e = 0
    for (let i = b * blk; i < (b + 1) * blk; i++) e += x[i] * x[i]
    blocks.push(e)
  }
  blocks.sort((a, b) => b - a)
  let top = 0
  for (let b = 0; b < TOP_BLOCKS; b++) top += blocks[b]
  const burst = top / energy

  const minLag = Math.floor(sampleRate / 400)
  const maxLag = Math.min(Math.floor(sampleRate / 80), n >> 1)
  let best = 0
  for (let lag = minLag; lag <= maxLag; lag++) {
    let xy = 0
    let xx = 0
    let yy = 0
    for (let i = 0; i + lag < n; i++) {
      const a = x[i]
      const b = x[i + lag]
      xy += a * b
      xx += a * a
      yy += b * b
    }
    const r = xx > 0 && yy > 0 ? xy / Math.sqrt(xx * yy) : 0
    if (r > best) best = r
  }
  return { rms, periodicity: best, crest, burst, voiced: best >= VOICED_PERIODICITY && crest <= MAX_SPEECH_CREST && burst <= MAX_SPEECH_BURST }
}

/** 최근 N 프레임 중 목소리 프레임 수를 센다 (끊김에 강하게) */
export class VoicedWindow {
  private bits: boolean[] = []
  private readonly size: number
  constructor(size: number) {
    this.size = size
  }
  push(v: boolean): number {
    this.bits.push(v)
    if (this.bits.length > this.size) this.bits.shift()
    return this.count
  }
  get count(): number {
    let c = 0
    for (const b of this.bits) if (b) c++
    return c
  }
  reset(): void {
    this.bits = []
  }
}
