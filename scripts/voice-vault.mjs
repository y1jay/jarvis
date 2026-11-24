#!/usr/bin/env node
// 음성 학습 보관함 열어보기 — 암호를 아는 사람만.
//
//   node scripts/voice-vault.mjs                 # 이 맥의 보관함 목록 (암호 입력)
//   node scripts/voice-vault.mjs <폴더>          # git 백업 폴더(…/jarvis-voice)도 가능
//   node scripts/voice-vault.mjs <폴더> --ogg <출력폴더>   # 말소리를 재생 가능한 .ogg 로 풀기
//   node scripts/voice-vault.mjs <폴더> --lexicon          # 배운 말투(자주 쓰는 말/바로잡은 말) 보기
//   node scripts/voice-vault.mjs <폴더> --brain            # 기억 전부(기억·대화·승인 학습·말투) 보기
//
// 암호는 화면에 표시되지 않고 어디에도 저장되지 않는다.
import { createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, scryptSync } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MAGIC = Buffer.from('JVS1')
const INFO = Buffer.from('jarvis-voice-v1')
const PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex')
const SPKI = Buffer.from('302a300506032b656e032100', 'hex')

const args = process.argv.slice(2)
const flag = (n) => {
  const i = args.indexOf(n)
  return i >= 0 ? args[i + 1] ?? true : null
}
const dir =
  args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1] === '--ogg')) ??
  join(homedir(), process.platform === 'darwin' ? 'Library/Application Support/JARVIS/.voice' : 'AppData/Roaming/JARVIS/.voice')
if (!existsSync(join(dir, 'vault.json'))) {
  console.error(`보관함이 없습니다: ${dir}`)
  process.exit(1)
}
const info = JSON.parse(readFileSync(join(dir, 'vault.json'), 'utf8'))

function askHidden(q) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      // 파이프로 넘긴 경우 (스크립트용)
      let buf = ''
      process.stdin.on('data', (d) => (buf += d))
      process.stdin.on('end', () => resolve(buf.replace(/\r?\n$/, '')))
      return
    }
    process.stdout.write(q)
    const stdin = process.stdin
    stdin.setRawMode(true)
    stdin.resume()
    let s = ''
    const on = (c) => {
      const ch = c.toString('utf8')
      if (ch === '\r' || ch === '\n') {
        stdin.setRawMode(false)
        stdin.pause()
        stdin.off('data', on)
        process.stdout.write('\n')
        resolve(s)
      } else if (ch === '\u0003') process.exit(130)
      else if (ch === '\u007f') s = s.slice(0, -1)
      else s += ch
    }
    stdin.on('data', on)
  })
}

const pass = (await askHidden('음성 학습 암호: ')).normalize('NFC')
const salt = Buffer.from(info.salt, 'base64')
const pub = Buffer.from(info.pub, 'base64')
const raw = scryptSync(pass, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
const priv = createPrivateKey({ key: Buffer.concat([PKCS8, raw]), format: 'der', type: 'pkcs8' })
const myPub = createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32)
if (!myPub.equals(pub)) {
  console.error('암호가 맞지 않습니다.')
  process.exit(2)
}

function openBlob(b) {
  if (!b.subarray(0, 4).equals(MAGIC)) throw new Error('JARVIS 음성 파일이 아닙니다')
  const eph = b.subarray(4, 36)
  const shared = diffieHellman({ privateKey: priv, publicKey: createPublicKey({ key: Buffer.concat([SPKI, eph]), format: 'der', type: 'spki' }) })
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.concat([eph, pub]), INFO, 32))
  const d = createDecipheriv('aes-256-gcm', key, b.subarray(36, 48))
  d.setAuthTag(b.subarray(48, 64))
  return Buffer.concat([d.update(b.subarray(64)), d.final()])
}
function unpack(b) {
  const n = b.readUInt32LE(0)
  const meta = JSON.parse(b.subarray(4, 4 + n).toString())
  const packets = []
  let o = 4 + n
  for (const sz of meta.sizes) {
    packets.push(b.subarray(o, o + sz))
    o += sz
  }
  return { ...meta, packets }
}

if (args.includes('--brain')) {
  const f = join(dir, 'brain.jvs')
  if (!existsSync(f)) {
    console.log('기억 파일(brain.jvs)이 아직 없습니다.')
    process.exit(0)
  }
  const b = JSON.parse(openBlob(readFileSync(f)).toString())
  console.log(`기억 파일 — ${new Date(b.createdAt).toLocaleString('ko-KR')} (JARVIS ${b.app})`)
  const mem = b.files['memory/memory.json'] ? JSON.parse(b.files['memory/memory.json']) : []
  console.log(`\n기억 ${mem.length}개`)
  for (const m of mem) console.log(`  · [${m.category}] ${m.text}`)
  const conv = (b.files['memory/conversations.jsonl'] ?? '').split('\n').filter(Boolean)
  console.log(`\n대화 기록 ${conv.length}개 (최근 5개)`)
  for (const l of conv.slice(-5)) {
    const j = JSON.parse(l)
    console.log(`  · ${j.ts?.slice(0, 16) ?? ''} ${j.prompt ?? ''} → ${(j.answer ?? '').replace(/\s+/g, ' ').slice(0, 60)}`)
  }
  const ap = b.files['memory/approval-lexicon.json'] ? JSON.parse(b.files['memory/approval-lexicon.json']) : []
  console.log(`\n승인 대답 학습 ${ap.length}개: ${ap.map((x) => `${x.example}(${x.decision === 'approve' ? '승인' : '거부'})`).join(', ')}`)
  const w = Object.entries(b.speechLexicon?.words ?? {}).sort((x, y) => y[1] - x[1]).slice(0, 20)
  console.log(`\n자주 쓰는 말: ${w.map(([k, c]) => `${k}(${c})`).join(', ') || '없음'}`)
  console.log(`바로잡은 말 ${Object.keys(b.speechLexicon?.fixes ?? {}).length}개`)
  process.exit(0)
}

if (args.includes('--lexicon')) {
  const f = join(dir, 'lexicon.jvs')
  if (!existsSync(f)) {
    console.log('이 폴더에는 말투 학습 백업(lexicon.jvs)이 없습니다. (이 맥의 말투 학습은 키체인으로 잠겨 JARVIS 안에서만 열립니다 — "음성 학습 상태 알려줘")')
    process.exit(0)
  }
  const lex = JSON.parse(openBlob(readFileSync(f)).toString())
  const words = Object.entries(lex.words).sort((a, b) => b[1] - a[1]).slice(0, 50)
  console.log('자주 쓰는 말:', words.map(([w, c]) => `${w}(${c})`).join(', ') || '없음')
  console.log('바로잡은 말:')
  for (const [k, v] of Object.entries(lex.fixes)) console.log(`  ${k} → ${v.to} (${v.n}번)`)
  process.exit(0)
}

// ── Ogg Opus (재생용) ──
const CRC = new Uint32Array(256).map((_, i) => {
  let r = i << 24
  for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1
  return r >>> 0
})
function crc(b) {
  let c = 0
  for (const x of b) c = ((c << 8) ^ CRC[((c >>> 24) ^ x) & 0xff]) >>> 0
  return c
}
function page(data, granule, serial, seq, type) {
  const segs = []
  let left = data.length
  while (left >= 255) {
    segs.push(255)
    left -= 255
  }
  segs.push(left)
  const h = Buffer.alloc(27 + segs.length)
  h.write('OggS', 0)
  h[4] = 0
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
function toOgg(packets, sampleRate) {
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
    g += 960 // 20ms (48kHz 기준)
    out.push(page(Buffer.from(p), g, serial, i + 2, i === packets.length - 1 ? 4 : 0))
  })
  return Buffer.concat(out)
}

const files = []
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f)
    if (statSync(p).isDirectory()) walk(p)
    else if (f.endsWith('.jvs') && f !== 'lexicon.jvs') files.push(p)
  }
}
walk(join(dir, 'samples'))
files.sort()
const oggDir = flag('--ogg')
if (oggDir && oggDir !== true) mkdirSync(oggDir, { recursive: true })
let n = 0
for (const f of files) {
  const s = unpack(openBlob(readFileSync(f)))
  n++
  const when = new Date(s.ts).toLocaleString('ko-KR')
  console.log(`${String(n).padStart(4)}  ${when}  "${s.heard}"${s.corrected ? `  → 바로잡음: "${s.final}"` : ''}${s.device ? `  [${s.device}]` : ''}`)
  if (oggDir && oggDir !== true) writeFileSync(join(oggDir, `${String(n).padStart(4, '0')}.ogg`), toOgg(s.packets, s.sampleRate))
}
console.log(`\n샘플 ${n}개${oggDir && oggDir !== true ? ` → ${oggDir} 에 .ogg 로 풀었습니다` : ''}`)
