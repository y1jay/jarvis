import { FilesetResolver, HandLandmarker, type NormalizedLandmark } from '@mediapipe/tasks-vision'
import { analyzeHand, GestureTracker, type GestureOutput, type HandState } from './gestures'

const CONNECTIONS: Array<[number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]
]

export class HandTracker {
  private landmarker: HandLandmarker | null = null
  private raf = 0
  private lastVideoTime = -1
  private gestures = new GestureTracker()
  hands: HandState[] = []

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly overlay: HTMLCanvasElement,
    private readonly onGesture: (g: GestureOutput, hands: HandState[]) => void
  ) {}

  async init(): Promise<void> {
    const base = new URL('./mediapipe/', window.location.href).href
    const fileset = await FilesetResolver.forVisionTasks(base + 'wasm')
    const opts = (delegate: 'GPU' | 'CPU') => ({
      baseOptions: { modelAssetPath: base + 'hand_landmarker.task', delegate },
      runningMode: 'VIDEO' as const,
      numHands: 2,
      minHandDetectionConfidence: 0.6,
      minTrackingConfidence: 0.5
    })
    try {
      this.landmarker = await HandLandmarker.createFromOptions(fileset, opts('GPU'))
    } catch {
      this.landmarker = await HandLandmarker.createFromOptions(fileset, opts('CPU'))
    }
  }

  start(): void {
    const tick = (): void => {
      this.raf = requestAnimationFrame(tick)
      if (!this.landmarker || this.video.readyState < 2) return
      if (this.video.currentTime === this.lastVideoTime) return
      this.lastVideoTime = this.video.currentTime
      const res = this.landmarker.detectForVideo(this.video, performance.now())
      // 영상은 거울 모드로 보여주므로 x 를 뒤집는다
      const mirrored = res.landmarks.map((lm) => lm.map((p) => ({ x: 1 - p.x, y: p.y, z: p.z })))
      this.hands = mirrored.map(analyzeHand)
      this.draw(mirrored)
      this.onGesture(this.gestures.update(this.hands, performance.now()), this.hands)
    }
    tick()
  }

  private draw(hands: NormalizedLandmark[][] | Array<Array<{ x: number; y: number }>>): void {
    const c = this.overlay
    const w = (c.width = c.clientWidth * devicePixelRatio)
    const h = (c.height = c.clientHeight * devicePixelRatio)
    const g = c.getContext('2d')!
    g.clearRect(0, 0, w, h)
    // object-fit: cover 보정
    const vw = this.video.videoWidth || 1
    const vh = this.video.videoHeight || 1
    const scale = Math.max(w / vw, h / vh)
    const ox = (w - vw * scale) / 2
    const oy = (h - vh * scale) / 2
    const X = (x: number): number => ox + x * vw * scale
    const Y = (y: number): number => oy + y * vh * scale
    g.lineWidth = 2 * devicePixelRatio
    g.shadowColor = '#38d6ff'
    g.shadowBlur = 12
    hands.forEach((lm, hi) => {
      const pose = this.hands[hi]?.pose
      g.strokeStyle = pose === 'pinch' ? '#ffb648' : pose === 'fist' ? '#ff6b8a' : 'rgba(80,220,255,0.9)'
      g.beginPath()
      for (const [a, b] of CONNECTIONS) {
        g.moveTo(X(lm[a].x), Y(lm[a].y))
        g.lineTo(X(lm[b].x), Y(lm[b].y))
      }
      g.stroke()
      g.fillStyle = '#e8fdff'
      for (const p of lm) {
        g.beginPath()
        g.arc(X(p.x), Y(p.y), 3 * devicePixelRatio, 0, Math.PI * 2)
        g.fill()
      }
    })
  }

  /** 영상 좌표(0~1) → 컨테이너 좌표(0~1) (object-fit: cover 보정) */
  toContainer(p: { x: number; y: number }): { x: number; y: number } {
    const w = this.overlay.clientWidth || 1
    const h = this.overlay.clientHeight || 1
    const vw = this.video.videoWidth || 1
    const vh = this.video.videoHeight || 1
    const scale = Math.max(w / vw, h / vh)
    const ox = (w - vw * scale) / 2
    const oy = (h - vh * scale) / 2
    return { x: (ox + p.x * vw * scale) / w, y: (oy + p.y * vh * scale) / h }
  }

  stop(): void {
    cancelAnimationFrame(this.raf)
    this.landmarker?.close()
    this.landmarker = null
    const g = this.overlay.getContext('2d')
    g?.clearRect(0, 0, this.overlay.width, this.overlay.height)
  }
}
