// 음성 학습 보관함
//
// 1) 말소리 샘플 (Opus 압축, 2초에 약 4KB) — 숨김 폴더에 '사용자만 아는 암호'로 잠근다.
//    암호는 어디에도 저장하지 않는다. 암호 → (scrypt) → X25519 개인키 → 공개키만 저장.
//    JARVIS 는 공개키로 '잠그기'만 할 수 있고, 여는 건 암호를 아는 사람만 가능하다 (git 에 올려도 안전).
// 2) 말투 학습 (텍스트, 아주 작음) — 자주 쓰는 단어(인식 힌트), 잘못 알아들은 말 → 실제로 뜻한 말(교정).
//    JARVIS 가 매번 써야 하므로 OS 키체인(safeStorage)으로 잠근다 (이 맥의 이 사용자 계정만 열 수 있음).
import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, scryptSync, type KeyObject } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const MAGIC = Buffer.from('JVS1')
const INFO = Buffer.from('jarvis-voice-v1')
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex')
const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex')

export interface VaultInfo {
  v: 1
  salt: string
  pub: string
  createdAt: string
}

export interface VoiceSample {
  ts: number
  /** 엔진이 알아들은 말 */
  heard: string
  /** 최종으로 처리된 말 (교정됐으면 교정된 말) */
  final?: string
  corrected?: boolean
  device?: string
  /** 엔진 확신도 (0 에 가까울수록 확신) — 학습 때 믿을 만한 정답만 고르는 데 쓴다 */
  logprob?: number
  /** Opus 패킷들 (16kHz mono) */
  packets: Uint8Array[]
  sampleRate: number
}

function rawToPrivate(raw: Buffer): KeyObject {
  return createPrivateKey({ key: Buffer.concat([PKCS8_X25519, raw]), format: 'der', type: 'pkcs8' })
}
function rawToPublic(raw: Buffer): KeyObject {
  return createPublicKey({ key: Buffer.concat([SPKI_X25519, raw]), format: 'der', type: 'spki' })
}
function publicRaw(k: KeyObject): Buffer {
  return (k.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32)
}

/** 암호 → 개인키 (항상 같은 암호면 같은 키) */
export function deriveKeys(passphrase: string, salt: Buffer): { priv: KeyObject; pub: Buffer } {
  const raw = scryptSync(passphrase.normalize('NFC'), salt, 32, SCRYPT)
  const priv = rawToPrivate(raw)
  return { priv, pub: publicRaw(createPublicKey(priv)) }
}

function aeadKey(shared: Buffer, ephPub: Buffer, pub: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, Buffer.concat([ephPub, pub]), INFO, 32))
}

/** 공개키로 잠그기 (누구나 가능) */
export function seal(plain: Buffer, pub: Buffer): Buffer {
  const eph = generateKeyPairSync('x25519')
  const ephPub = publicRaw(eph.publicKey)
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: rawToPublic(pub) })
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', aeadKey(shared, ephPub, pub), iv)
  const body = Buffer.concat([c.update(plain), c.final()])
  return Buffer.concat([MAGIC, ephPub, iv, c.getAuthTag(), body])
}

/** 개인키로 열기 (암호를 아는 사람만) */
export function open(blob: Buffer, priv: KeyObject, pub: Buffer): Buffer {
  if (!blob.subarray(0, 4).equals(MAGIC)) throw new Error('JARVIS 음성 파일이 아닙니다')
  const ephPub = blob.subarray(4, 36)
  const iv = blob.subarray(36, 48)
  const tag = blob.subarray(48, 64)
  const shared = diffieHellman({ privateKey: priv, publicKey: rawToPublic(Buffer.from(ephPub)) })
  const d = createDecipheriv('aes-256-gcm', aeadKey(shared, Buffer.from(ephPub), pub), iv)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(blob.subarray(64)), d.final()])
}

/** 샘플 ↔ 바이트: [헤더 길이 4B][헤더 JSON][패킷들] */
export function packSample(s: VoiceSample): Buffer {
  const { packets, ...meta } = s
  const head = Buffer.from(JSON.stringify({ ...meta, sizes: packets.map((p) => p.length) }))
  const len = Buffer.alloc(4)
  len.writeUInt32LE(head.length)
  return Buffer.concat([len, head, ...packets.map((p) => Buffer.from(p))])
}
export function unpackSample(b: Buffer): VoiceSample {
  const n = b.readUInt32LE(0)
  const meta = JSON.parse(b.subarray(4, 4 + n).toString()) as Omit<VoiceSample, 'packets'> & { sizes: number[] }
  const packets: Uint8Array[] = []
  let o = 4 + n
  for (const sz of meta.sizes) {
    packets.push(new Uint8Array(b.subarray(o, o + sz)))
    o += sz
  }
  const { sizes: _s, ...rest } = meta
  return { ...rest, packets }
}

export interface VaultStats {
  ready: boolean
  samples: number
  bytes: number
  limitBytes: number
}

export class VoiceVault {
  private info: VaultInfo | null = null
  constructor(
    private readonly dir: string,
    private readonly limitBytes: () => number
  ) {
    const f = join(dir, 'vault.json')
    if (existsSync(f)) this.info = JSON.parse(readFileSync(f, 'utf8')) as VaultInfo
  }

  get ready(): boolean {
    return !!this.info
  }

  /** 처음 한 번: 암호 정하기 (암호 자체는 저장하지 않는다) */
  setup(passphrase: string): VaultInfo {
    if (passphrase.length < 6) throw new Error('암호는 6자 이상으로 정해 주세요')
    const salt = randomBytes(16)
    const { pub } = deriveKeys(passphrase, salt)
    const info: VaultInfo = { v: 1, salt: salt.toString('base64'), pub: pub.toString('base64'), createdAt: new Date().toISOString() }
    mkdirSync(join(this.dir, 'samples'), { recursive: true })
    writeFileSync(join(this.dir, 'vault.json'), JSON.stringify(info, null, 2))
    this.info = info
    return info
  }

  /** 암호가 맞는지 (보기/복원 전에) */
  check(passphrase: string): boolean {
    if (!this.info) return false
    return deriveKeys(passphrase, Buffer.from(this.info.salt, 'base64')).pub.toString('base64') === this.info.pub
  }

  /** 샘플 저장 (잠가서). 용량을 넘으면 오래된 것부터 지운다 — 교정된(잘못 알아들었던) 샘플은 가장 나중에 */
  add(s: VoiceSample): string | null {
    if (!this.info) return null
    const pub = Buffer.from(this.info.pub, 'base64')
    const blob = seal(packSample(s), pub)
    const d = new Date(s.ts)
    const sub = join(this.dir, 'samples', `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`)
    mkdirSync(sub, { recursive: true })
    const name = `${s.ts}-${randomBytes(4).toString('hex')}${s.corrected ? '-c' : ''}.jvs`
    const tmp = join(sub, `.${name}.tmp`)
    writeFileSync(tmp, blob)
    renameSync(tmp, join(sub, name))
    this.prune()
    return name
  }

  private files(): Array<{ path: string; size: number; corrected: boolean; ts: number }> {
    const root = join(this.dir, 'samples')
    if (!existsSync(root)) return []
    const out: Array<{ path: string; size: number; corrected: boolean; ts: number }> = []
    for (const m of readdirSync(root)) {
      const sub = join(root, m)
      if (!statSync(sub).isDirectory()) continue
      for (const f of readdirSync(sub)) {
        if (!f.endsWith('.jvs')) continue
        const p = join(sub, f)
        out.push({ path: p, size: statSync(p).size, corrected: f.endsWith('-c.jvs'), ts: Number(f.split('-')[0]) || 0 })
      }
    }
    return out
  }

  prune(): number {
    const files = this.files()
    let total = files.reduce((a, f) => a + f.size, 0)
    const limit = this.limitBytes()
    if (total <= limit) return 0
    // 지우는 순서: 일반 샘플(오래된 것부터) → 교정 샘플(오래된 것부터)
    const order = [...files].sort((a, b) => Number(a.corrected) - Number(b.corrected) || a.ts - b.ts)
    let removed = 0
    for (const f of order) {
      if (total <= limit) break
      unlinkSync(f.path)
      total -= f.size
      removed++
    }
    return removed
  }

  stats(): VaultStats {
    const files = this.files()
    return { ready: this.ready, samples: files.length, bytes: files.reduce((a, f) => a + f.size, 0), limitBytes: this.limitBytes() }
  }

  /** 암호로 전부 열기 (사용자 확인용 도구에서만) */
  readAll(passphrase: string): VoiceSample[] {
    if (!this.info || !this.check(passphrase)) throw new Error('암호가 맞지 않습니다')
    const salt = Buffer.from(this.info.salt, 'base64')
    const { priv, pub } = deriveKeys(passphrase, salt)
    return this.files()
      .sort((a, b) => a.ts - b.ts)
      .map((f) => unpackSample(open(readFileSync(f.path), priv, pub)))
  }

  /** 모두 지우기 (사용자가 요청할 때만) */
  clearSamples(): number {
    let n = 0
    for (const f of this.files()) {
      unlinkSync(f.path)
      n++
    }
    return n
  }

  /** 기억 전부(한 파일)를 잠가서 숨김 폴더에 — 바뀔 때마다 갱신. 암호 없이 잠글 수 있다 (공개키) */
  writeBrain(plain: Buffer): boolean {
    if (!this.info) return false
    const f = join(this.dir, 'brain.jvs')
    writeFileSync(`${f}.tmp`, seal(plain, Buffer.from(this.info.pub, 'base64')))
    renameSync(`${f}.tmp`, f)
    return true
  }

  get publicKey(): string | null {
    return this.info?.pub ?? null
  }

  /**
   * 백업 폴더의 보관함을 이 기기로 가져온다 (샘플·공개 정보). 이 기기에 다른 암호의 보관함이 이미 있으면 샘플은 가져오지 않는다.
   * 반환: 가져온 샘플 수, 보관함을 새로 맞췄는지
   */
  adoptFrom(src: string): { samples: number; adopted: boolean; conflict: boolean } {
    const theirs = JSON.parse(readFileSync(join(src, 'vault.json'), 'utf8')) as VaultInfo
    if (this.info && this.info.pub !== theirs.pub) return { samples: 0, adopted: false, conflict: true }
    const adopted = !this.info
    if (adopted) {
      mkdirSync(join(this.dir, 'samples'), { recursive: true })
      writeFileSync(join(this.dir, 'vault.json'), JSON.stringify(theirs, null, 2))
      this.info = theirs
    }
    let samples = 0
    const root = join(src, 'samples')
    if (existsSync(root)) {
      for (const m of readdirSync(root)) {
        const sub = join(root, m)
        if (!statSync(sub).isDirectory()) continue
        for (const f of readdirSync(sub)) {
          if (!f.endsWith('.jvs')) continue
          const to = join(this.dir, 'samples', m, f)
          if (existsSync(to)) continue
          mkdirSync(dirname(to), { recursive: true })
          writeFileSync(to, readFileSync(join(sub, f)))
          samples++
        }
      }
    }
    this.prune()
    return { samples, adopted, conflict: false }
  }

  /** git 백업용: 잠긴 파일과 공개 정보(vault.json)를 대상 폴더로 복사 (이미 잠겨 있으니 그대로) */
  exportTo(target: string, extra: Record<string, Buffer> = {}): { copied: number } {
    if (!this.info) throw new Error('음성 학습 암호가 아직 설정되지 않았습니다')
    mkdirSync(join(target, 'samples'), { recursive: true })
    writeFileSync(join(target, 'vault.json'), JSON.stringify(this.info, null, 2))
    let copied = 0
    for (const f of this.files()) {
      const rel = f.path.slice(join(this.dir, 'samples').length + 1)
      const to = join(target, 'samples', rel)
      if (existsSync(to)) continue
      mkdirSync(dirname(to), { recursive: true })
      writeFileSync(to, readFileSync(f.path))
      copied++
    }
    for (const [name, data] of Object.entries(extra)) writeFileSync(join(target, name), seal(data, Buffer.from(this.info.pub, 'base64')))
    const brain = join(this.dir, 'brain.jvs')
    if (existsSync(brain)) writeFileSync(join(target, 'brain.jvs'), readFileSync(brain))
    return { copied }
  }
}

// ── 말투 학습 (텍스트) ───────────────────────────────────────────
export interface LexiconData {
  v: 1
  /** 자주 쓰는 단어 → 횟수 */
  words: Record<string, number>
  /** 잘못 알아들은 말 → 실제로 뜻한 말 */
  fixes: Record<string, { to: string; n: number; at: number }>
}

const STOP = new Set(['그거', '이거', '저거', '그리고', '근데', '그래서', '지금', '좀', '더', '다시', '그냥', '이제', '해줘', '해', '줘', '자비스'])

export function normKey(s: string): string {
  return s.toLowerCase().replace(/[\s.,!?~…'"]/g, '')
}

export class SpeechLexicon {
  data: LexiconData = { v: 1, words: {}, fixes: {} }
  constructor(
    private readonly file: string,
    private readonly crypt: { encrypt: (s: string) => Buffer; decrypt: (b: Buffer) => string; available: () => boolean }
  ) {
    try {
      if (existsSync(file)) this.data = JSON.parse(this.crypt.decrypt(readFileSync(file))) as LexiconData
    } catch {
      /* 손상/다른 계정 → 새로 시작 */
    }
  }

  private save(): void {
    if (!this.crypt.available()) return
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, this.crypt.encrypt(JSON.stringify(this.data)))
    renameSync(tmp, this.file)
  }

  /** 처리된 말에서 자주 쓰는 단어를 배운다 (최대 5000개, 넘으면 드물게 쓴 것부터 잊는다) */
  learnWords(text: string): void {
    for (const w of text.split(/[\s,.!?]+/)) {
      const t = w.replace(/(을|를|이|가|은|는|에|에서|으로|로|한테|하고|도|만|요|줘)$/, '')
      if (t.length < 2 || STOP.has(t) || /^\d+$/.test(t)) continue
      this.data.words[t] = (this.data.words[t] ?? 0) + 1
    }
    const keys = Object.keys(this.data.words)
    if (keys.length > 5000) {
      for (const k of keys.sort((a, b) => this.data.words[a] - this.data.words[b]).slice(0, keys.length - 4000)) delete this.data.words[k]
    }
    this.save()
  }

  /** 잘못 알아들은 말 → 뜻한 말 (예: "에퍼리 다 내려봤다" → "목소리 더 내려받기") */
  learnFix(heard: string, meant: string): void {
    const k = normKey(heard)
    if (!k || k === normKey(meant)) return
    const cur = this.data.fixes[k]
    this.data.fixes[k] = { to: meant, n: (cur?.to === meant ? cur.n : 0) + 1, at: Date.now() }
    const keys = Object.keys(this.data.fixes)
    if (keys.length > 3000) for (const x of keys.sort((a, b) => this.data.fixes[a].at - this.data.fixes[b].at).slice(0, keys.length - 2500)) delete this.data.fixes[x]
    this.save()
  }

  /** 복원 등으로 통째로 바꾸기 */
  replace(data: LexiconData): void {
    this.data = { v: 1, words: { ...data.words }, fixes: { ...data.fixes } }
    this.save()
  }

  fix(heard: string): string | null {
    return this.data.fixes[normKey(heard)]?.to ?? null
  }

  /** 인식 힌트에 넣을 자주 쓰는 단어 */
  topWords(n = 25): string[] {
    return Object.entries(this.data.words)
      .filter(([, c]) => c >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([w]) => w)
  }

  /** git 백업용 원문 (백업할 땐 사용자 암호 공개키로 다시 잠근다) */
  exportPlain(): Buffer {
    return Buffer.from(JSON.stringify(this.data))
  }
}

/** 백업 폴더 열기 (암호 확인). 틀리면 null */
export function openBackup(dir: string, passphrase: string): { read: (name: string) => Buffer | null; info: VaultInfo } | null {
  const info = JSON.parse(readFileSync(join(dir, 'vault.json'), 'utf8')) as VaultInfo
  const { priv, pub } = deriveKeys(passphrase, Buffer.from(info.salt, 'base64'))
  if (pub.toString('base64') !== info.pub) return null
  return { info, read: (name) => (existsSync(join(dir, name)) ? open(readFileSync(join(dir, name)), priv, pub) : null) }
}
