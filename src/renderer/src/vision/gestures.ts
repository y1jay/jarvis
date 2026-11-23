// MediaPipe 손 랜드마크(21점) → 제스처 (순수 함수)
export interface P {
  x: number
  y: number
  z?: number
}

export type HandPose = 'pinch' | 'open' | 'fist' | 'point' | 'other'

export interface HandState {
  pose: HandPose
  /** 정규화 좌표 (0~1), 화면 기준(미러링 반영 전) */
  palm: P
  pinchPoint: P
  /** 손 크기 (손목 → 중지 MCP) */
  size: number
  pinchRatio: number
}

const d = (a: P, b: P): number => Math.hypot(a.x - b.x, a.y - b.y)

function extended(lm: P[], tip: number, pip: number): boolean {
  // 손끝이 PIP 관절보다 손목에서 충분히 멀면 펴진 것
  return d(lm[tip], lm[0]) > d(lm[pip], lm[0]) * 1.12
}

export function analyzeHand(lm: P[]): HandState {
  const size = Math.max(1e-6, d(lm[0], lm[9]))
  const pinchRatio = d(lm[4], lm[8]) / size
  const fingers = [extended(lm, 8, 6), extended(lm, 12, 10), extended(lm, 16, 14), extended(lm, 20, 18)]
  const count = fingers.filter(Boolean).length
  const palmIdx = [0, 5, 9, 13, 17]
  const palm = { x: palmIdx.reduce((s, i) => s + lm[i].x, 0) / 5, y: palmIdx.reduce((s, i) => s + lm[i].y, 0) / 5 }
  const pinchPoint = { x: (lm[4].x + lm[8].x) / 2, y: (lm[4].y + lm[8].y) / 2 }
  // 주먹에서도 엄지-검지가 가까워지므로, 검지가 말려 있으면 주먹을 우선한다
  const indexReach = d(lm[8], lm[0]) / size
  let pose: HandPose = 'other'
  if (count === 0 && indexReach < 1.1) pose = 'fist'
  else if (pinchRatio < 0.32) pose = 'pinch'
  else if (count === 4) pose = 'open'
  else if (count === 0) pose = 'fist'
  else if (fingers[0] && count === 1) pose = 'point'
  return { pose, palm, pinchPoint, size, pinchRatio }
}

/** 제스처 상태 머신: 프레임마다 손 상태를 받아 홀로그램 조작 명령을 낸다 */
export interface GestureOutput {
  rotate?: { dx: number; dy: number }
  scale?: number
  anchor?: P | null
  summon?: boolean
}

export class GestureTracker {
  private lastPinch: P | null = null
  private lastTwoDist: number | null = null
  private fistSince: number | null = null
  private fistFired = false
  private openFrames = 0

  update(hands: HandState[], now: number): GestureOutput {
    const out: GestureOutput = {}
    const pinching = hands.filter((h) => h.pose === 'pinch')

    // 양손 집기 → 확대/축소
    if (pinching.length >= 2) {
      const dist = d(pinching[0].pinchPoint, pinching[1].pinchPoint)
      if (this.lastTwoDist) out.scale = dist / this.lastTwoDist
      this.lastTwoDist = dist
      this.lastPinch = null
    } else {
      this.lastTwoDist = null
      // 한 손 집기 + 이동 → 회전
      if (pinching.length === 1) {
        const p = pinching[0].pinchPoint
        if (this.lastPinch) out.rotate = { dx: p.x - this.lastPinch.x, dy: p.y - this.lastPinch.y }
        this.lastPinch = p
      } else this.lastPinch = null
    }

    // 손바닥 펴기 → 홀로그램이 손 위로 (3프레임 이상 유지 시)
    const open = hands.find((h) => h.pose === 'open')
    if (open && pinching.length === 0) {
      this.openFrames++
      if (this.openFrames >= 3) out.anchor = { x: open.palm.x, y: open.palm.y - open.size * 1.4 }
    } else {
      if (this.openFrames >= 3) out.anchor = null
      this.openFrames = 0
    }

    // 주먹 0.8초 유지 → 자비스 호출
    const fist = hands.some((h) => h.pose === 'fist')
    if (fist) {
      this.fistSince ??= now
      if (!this.fistFired && now - this.fistSince > 800) {
        out.summon = true
        this.fistFired = true
      }
    } else {
      this.fistSince = null
      this.fistFired = false
    }
    return out
  }
}
