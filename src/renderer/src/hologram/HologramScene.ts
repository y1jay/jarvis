// 홀로그램 코어: 와이어프레임 코어 + 회전 링 + 파티클 셸 + 스캔 라인.
// 배경은 투명 → 카메라 영상 위에 겹쳐서 AR 홀로그램처럼 보인다.
import * as THREE from 'three'

export type HoloState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error'

const COLORS: Record<HoloState, THREE.Color> = {
  idle: new THREE.Color('#38d6ff'),
  listening: new THREE.Color('#5dffcf'),
  thinking: new THREE.Color('#ffb648'),
  speaking: new THREE.Color('#9af0ff'),
  error: new THREE.Color('#ff4d5e')
}

function glowTexture(): THREE.Texture {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')!
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64)
  grd.addColorStop(0, 'rgba(255,255,255,1)')
  grd.addColorStop(0.25, 'rgba(255,255,255,0.55)')
  grd.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grd
  g.fillRect(0, 0, 128, 128)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

function tickRing(radius: number, ticks: number, len: number): THREE.BufferGeometry {
  const pts: number[] = []
  for (let i = 0; i < ticks; i++) {
    const a = (i / ticks) * Math.PI * 2
    const l = i % 5 === 0 ? len * 2 : len
    pts.push(Math.cos(a) * radius, Math.sin(a) * radius, 0, Math.cos(a) * (radius + l), Math.sin(a) * (radius + l), 0)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
  return g
}

function arc(radius: number, start: number, length: number, segments = 64): THREE.BufferGeometry {
  const pts: THREE.Vector3[] = []
  for (let i = 0; i <= segments; i++) {
    const a = start + (i / segments) * length
    pts.push(new THREE.Vector3(Math.cos(a) * radius, Math.sin(a) * radius, 0))
  }
  return new THREE.BufferGeometry().setFromPoints(pts)
}

export class HologramScene {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private root = new THREE.Group()
  private spin = new THREE.Group()
  private materials: Array<THREE.LineBasicMaterial | THREE.MeshBasicMaterial | THREE.PointsMaterial | THREE.SpriteMaterial> = []
  private core: THREE.LineSegments
  private inner: THREE.Mesh
  private rings: THREE.Object3D[] = []
  private particles: THREE.Points
  private particleBase: Float32Array
  private glow: THREE.Sprite
  private raf = 0
  private clock = new THREE.Clock()
  private state: HoloState = 'idle'
  private color = COLORS.idle.clone()
  private level = 0
  private targetScale = 1
  private userScale = 1
  private userRot = new THREE.Euler(0.25, 0, 0)
  private anchor: { x: number; y: number } | null = null
  private ro: ResizeObserver
  /** 작업 중 (말하기/듣기와 별개로 작업이 도는 동안 계속) */
  private working = false
  private workAmt = 0
  /** 코어 와이어프레임의 원래 꼭짓점 (작업 중 표면을 물결치게 할 때 기준) */
  private coreBase: Float32Array
  private coreDeformed = false

  constructor(private readonly host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setClearColor(0x000000, 0)
    host.appendChild(this.renderer.domElement)
    this.renderer.domElement.dataset.testid = 'hologram-canvas'

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100)
    this.camera.position.set(0, 0, 7)
    this.scene.add(this.root)
    this.root.add(this.spin)

    const line = (opacity: number): THREE.LineBasicMaterial => {
      const m = new THREE.LineBasicMaterial({ color: this.color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false })
      this.materials.push(m)
      return m
    }

    // 코어: 지오데식 와이어프레임
    this.core = new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(1, 2)), line(0.75))
    this.spin.add(this.core)
    const innerMat = new THREE.MeshBasicMaterial({ color: this.color, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false })
    this.materials.push(innerMat)
    this.inner = new THREE.Mesh(new THREE.IcosahedronGeometry(0.62, 1), innerMat)
    this.spin.add(this.inner)
    const innerWire = new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.OctahedronGeometry(0.55, 0)), line(0.9))
    this.inner.add(innerWire)

    // 회전 링들
    const ringDefs: Array<[number, number, THREE.Euler]> = [
      [1.55, 0.5, new THREE.Euler(Math.PI / 2, 0, 0)],
      [1.8, 0.35, new THREE.Euler(Math.PI / 2.6, 0.4, 0)],
      [2.1, 0.25, new THREE.Euler(Math.PI / 1.8, -0.5, 0.2)]
    ]
    for (const [r, o, rot] of ringDefs) {
      const g = new THREE.Group()
      g.rotation.copy(rot)
      g.add(new THREE.LineLoop(arc(r, 0, Math.PI * 2, 128), line(o)))
      g.add(new THREE.Line(arc(r + 0.06, 0.3, Math.PI * 0.7), line(o + 0.35)))
      g.add(new THREE.Line(arc(r + 0.06, Math.PI * 1.2, Math.PI * 0.45), line(o + 0.35)))
      this.rings.push(g)
      this.root.add(g)
    }
    const ticks = new THREE.LineSegments(tickRing(2.45, 120, 0.05), line(0.45))
    this.rings.push(ticks)
    this.root.add(ticks)

    // 파티클 셸
    const N = 1800
    this.particleBase = new Float32Array(N * 3)
    for (let i = 0; i < N; i++) {
      const u = Math.random() * 2 - 1
      const t = Math.random() * Math.PI * 2
      const r = 1.25 + Math.random() * 0.12
      const s = Math.sqrt(1 - u * u)
      this.particleBase.set([r * s * Math.cos(t), r * u, r * s * Math.sin(t)], i * 3)
    }
    const pg = new THREE.BufferGeometry()
    pg.setAttribute('position', new THREE.BufferAttribute(this.particleBase.slice(), 3))
    const pm = new THREE.PointsMaterial({ color: this.color, size: 0.025, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false })
    this.materials.push(pm)
    this.particles = new THREE.Points(pg, pm)
    this.spin.add(this.particles)

    // 중심 글로우
    const gm = new THREE.SpriteMaterial({ map: glowTexture(), color: this.color, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false })
    this.materials.push(gm)
    this.glow = new THREE.Sprite(gm)
    this.glow.scale.set(3.2, 3.2, 1)
    this.root.add(this.glow)

    this.coreBase = (this.core.geometry.getAttribute('position').array as Float32Array).slice()

    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(host)
    this.resize()
    this.loop()
  }

  setState(s: HoloState): void {
    this.state = s
  }
  /** 작업 중 표시 켜기/끄기 — 말하기·듣기 상태와 겹쳐서 계속 보인다 */
  setWorking(on: boolean): void {
    this.working = on
  }
  getState(): HoloState {
    return this.state
  }
  /** 0~1 오디오 레벨 */
  setLevel(v: number): void {
    this.level = Math.max(this.level * 0.6, Math.min(1, v))
  }
  rotateBy(dx: number, dy: number): void {
    this.userRot.y += dx * 6
    this.userRot.x += dy * 6
  }
  scaleBy(f: number): void {
    this.userScale = THREE.MathUtils.clamp(this.userScale * f, 0.35, 3)
  }
  /** 화면 정규화 좌표(0~1)에 홀로그램 고정. null = 중앙 복귀 */
  setAnchor(p: { x: number; y: number } | null): void {
    this.anchor = p
  }
  snapshot(): string {
    return this.renderer.domElement.toDataURL('image/png')
  }

  private resize(): void {
    const w = this.host.clientWidth || 1
    const h = this.host.clientHeight || 1
    this.renderer.setSize(w, h, false)
    this.renderer.domElement.style.width = '100%'
    this.renderer.domElement.style.height = '100%'
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop)
    const dt = Math.min(this.clock.getDelta(), 0.05)
    const t = this.clock.elapsedTime

    this.workAmt = THREE.MathUtils.lerp(this.workAmt, this.working ? 1 : 0, 0.06)
    const w = this.workAmt
    // 작업 중이면 색이 호박색 쪽으로 (말하는 중엔 살짝만)
    const tint = COLORS[this.state].clone().lerp(COLORS.thinking, this.state === 'speaking' || this.state === 'listening' ? w * 0.12 : w * 0.3)
    this.color.lerp(tint, 0.08)
    for (const m of this.materials) m.color.copy(this.color)

    const speed = (this.state === 'thinking' ? 2.6 : this.state === 'listening' ? 1.4 : 0.6) + w * 1.8
    this.spin.rotation.y += dt * 0.35 * speed
    this.spin.rotation.x = this.userRot.x
    this.root.rotation.y = this.userRot.y * 0.5
    this.rings.forEach((r, i) => (r.rotation.z += dt * (0.25 + i * 0.12) * (i % 2 ? -1 : 1) * speed))
    this.inner.rotation.x -= dt * 0.9 * speed
    this.inner.rotation.z += dt * 0.6 * speed

    // 오디오 반응 + 호흡
    this.level *= 0.92
    const breathe = 1 + Math.sin(t * 1.6) * 0.025
    const react = this.state === 'speaking' || this.state === 'listening' ? this.level * 0.35 : 0
    this.targetScale = this.userScale * (breathe + react)
    const s = THREE.MathUtils.lerp(this.root.scale.x, this.targetScale * (this.anchor ? 0.55 : 1), 0.15)
    this.root.scale.setScalar(s)
    ;(this.glow.material as THREE.SpriteMaterial).opacity = 0.35 + react + (this.state === 'thinking' ? Math.sin(t * 8) * 0.1 : 0) + this.workAmt * 0.25 * Math.pow(Math.max(0, Math.sin(t * 4.2)), 8)

    // 작업 중: 홀로그램 몸체가 일한다
    // ① 표면이 여러 방향의 물결로 계속 일렁인다 (계산하는 느낌)
    const cpos = this.core.geometry.getAttribute('position') as THREE.BufferAttribute
    const carr = cpos.array as Float32Array
    if (w > 0.002) {
      const a1 = t * 0.7
      const ax = Math.cos(a1)
      const az = Math.sin(a1)
      for (let i = 0; i < carr.length; i += 3) {
        const x = this.coreBase[i]
        const y = this.coreBase[i + 1]
        const z = this.coreBase[i + 2]
        const d1 = x * ax + z * az
        const wave = Math.sin(d1 * 7 - t * 6) * 0.07 + Math.sin(y * 5 + t * 4.3) * 0.05 + Math.sin((x - y + z) * 4 - t * 3.1) * 0.04
        const k = 1 + wave * w
        carr[i] = x * k
        carr[i + 1] = y * k
        carr[i + 2] = z * k
      }
      cpos.needsUpdate = true
      this.coreDeformed = true
    } else if (this.coreDeformed) {
      carr.set(this.coreBase)
      cpos.needsUpdate = true
      this.coreDeformed = false
    }
    // ② 안쪽 코어가 빠르게 돌며 맥박친다
    this.inner.rotation.y += dt * 3.2 * w
    this.inner.rotation.x += dt * 2.1 * w
    const beat = Math.pow(Math.max(0, Math.sin(t * 4.2)), 8)
    this.inner.scale.setScalar(1 + w * (0.12 + beat * 0.32))

    // 파티클 흔들림 (+ 작업 중엔 위아래로 오가는 스캔 띠)
    const pos = this.particles.geometry.getAttribute('position') as THREE.BufferAttribute
    const arr = pos.array as Float32Array
    const amp = 0.04 + this.level * 0.25 + (this.state === 'thinking' ? 0.06 : 0) + w * 0.03
    for (let i = 0; i < arr.length; i += 3) {
      const bx = this.particleBase[i]
      const by = this.particleBase[i + 1]
      const bz = this.particleBase[i + 2]
      // ③ 작업 중: 입자들이 소용돌이치며 코어로 빨려 들어갔다가 퍼진다 (데이터를 처리하는 흐름)
      const inhale = w * 0.5 * (0.5 + 0.5 * Math.sin(t * 2.6 + i * 0.0021))
      const k = (1 + Math.sin(t * 2.2 + i * 0.013) * amp) * (1 - inhale)
      const a = w * (t * 1.8 + by * 1.6)
      const ca = Math.cos(a)
      const sa = Math.sin(a)
      arr[i] = (bx * ca - bz * sa) * k
      arr[i + 1] = by * k
      arr[i + 2] = (bx * sa + bz * ca) * k
    }
    pos.needsUpdate = true

    // 손 위 고정: 화면 좌표 → 월드 좌표 (z=0 평면)
    const target = new THREE.Vector3(0, 0, 0)
    if (this.anchor) {
      const ndc = new THREE.Vector3(this.anchor.x * 2 - 1, -(this.anchor.y * 2 - 1), 0.5).unproject(this.camera)
      const dir = ndc.sub(this.camera.position).normalize()
      const dist = -this.camera.position.z / dir.z
      target.copy(this.camera.position).add(dir.multiplyScalar(dist))
    }
    this.root.position.lerp(target, 0.2)

    this.renderer.render(this.scene, this.camera)
  }

  dispose(): void {
    cancelAnimationFrame(this.raf)
    this.ro.disconnect()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
