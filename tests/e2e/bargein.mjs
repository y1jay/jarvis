// E2E: 키보드 소리는 무시 / JARVIS 가 말하는 중에도 사용자가 말하면 멈추고 듣기 / "멈춰" → 작업 중지 + 이력
// 실제 Electron + 실제 Whisper, 마이크 입력은 Chromium 표준 가짜 오디오(파일)로 넣는다.
// 사용: npm run build && node tests/e2e/bargein.mjs
import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const target = { executablePath: require('electron'), args: [root, '--hidden'] }
const SR = 16000

let failures = 0
const assert = (c, m) => {
  if (!c) throw new Error(m)
}
const step = async (name, fn) => {
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return
  const t0 = Date.now()
  try {
    await fn()
    console.log(`✓ ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
  } catch (e) {
    failures++
    console.log(`✗ ${name}: ${e.message}`)
  }
}

function sayPcm(sentence) {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-barge-say-'))
  execFileSync('say', ['-v', 'Yuna', '-o', join(dir, 'v.aiff'), sentence])
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', join(dir, 'v.aiff'), join(dir, 'v.wav')])
  const b = readFileSync(join(dir, 'v.wav'))
  const di = b.indexOf('data') + 8
  const n = (b.length - di) >> 1
  const s = new Float32Array(n)
  for (let i = 0; i < n; i++) s[i] = b.readInt16LE(di + i * 2) / 32768
  return s
}

function rng(seed) {
  let s = seed
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1
}

/** 타건음 (높은 딸깍 + 낮은 기계식 똑, 초당 ~9타) */
function typing(seconds, seed = 1) {
  const n = Math.floor(seconds * SR)
  const x = new Float32Array(n)
  const r = rng(seed)
  let pos = 800
  let k = 0
  while (pos < n) {
    const thock = k++ % 2 === 1
    const amp = 0.25 + Math.abs(r()) * 0.2
    for (let i = pos; i < Math.min(n, pos + 1600); i++) {
      const t = (i - pos) / SR
      const env = Math.exp(-t / (thock ? 0.012 : 0.004))
      x[i] += amp * env * (thock ? Math.sin(2 * Math.PI * 200 * t) * 0.8 + r() * 0.2 : r() * 0.5 + Math.sin(2 * Math.PI * 2500 * t) * 0.5)
    }
    pos += Math.floor(SR * (0.08 + Math.abs(r()) * 0.14))
  }
  return x
}

/** 전체 길이 동안 타건음을 깔고, at 초 위치에 말을 얹는다 (가짜 마이크는 파일을 반복 재생) */
/** 실제 노트북 마이크에서 타건음은 보통 목소리보다 작다 — 목소리 대비 약 0.5 배로 */
const KEY_GAIN = Number(process.env.KEY_GAIN ?? 0.5)
function wav(seconds, speech = [], keys = 1) {
  const n = Math.floor(seconds * SR)
  const x = typing(seconds)
  for (let i = 0; i < n; i++) x[i] *= keys
  const r = rng(11)
  for (let i = 0; i < n; i++) x[i] += r() * 0.001
  for (const { at, pcm } of speech) for (let i = 0; i < pcm.length && at * SR + i < n; i++) x[Math.floor(at * SR) + i] += pcm[i]
  const body = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) body.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), i * 2)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + body.length, 4); h.write('WAVE', 8); h.write('fmt ', 12)
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(SR, 24)
  h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(body.length, 40)
  const out = join(mkdtempSync(join(tmpdir(), 'jarvis-barge-wav-')), 'mic.wav')
  writeFileSync(out, Buffer.concat([h, body]))
  return out
}

// Whisper 모델은 한 번만 받도록 같은 userData 를 공유
const userData = mkdtempSync(join(tmpdir(), 'jarvis-barge-ud-'))
const isolate = (micWav) => [
  `--user-data-dir=${userData}`,
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  `--use-file-for-fake-audio-capture=${micWav}`,
  '--disable-features=AudioServiceOutOfProcess,AudioServiceSandbox'
]
const env0 = { ...process.env }
delete env0.ELECTRON_RUN_AS_NODE

async function launch(micWav, settingsPatch) {
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({ alwaysListen: true, ...settingsPatch }))
  const app = await electron.launch({ ...target, args: [...target.args, ...isolate(micWav)], env: env0 })
  const page = await app.firstWindow()
  const logs = []
  page.on('console', (m) => {
    const t = m.text()
    if (t.startsWith('[voice]')) {
      logs.push({ t, at: Date.now() })
      console.log('     ', t)
    }
  })
  await page.waitForSelector('.app', { timeout: 60000 })
  await page.waitForFunction(() => document.querySelector('[data-testid=mic-toggle]')?.classList.contains('orb-on'), null, { timeout: 30000 })
  // 음성 인식 모델 준비 (첫 실행은 다운로드)
  await page.waitForFunction(() => /음성 인식 준비 완료/.test(document.body.innerText), null, { timeout: 600000 }).catch(() => undefined)
  return { app, page, logs }
}

const waitLog = async (page, logs, re, ms, since = 0) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const hit = logs.find((l) => l.at >= since && re.test(l.t))
    if (hit) return hit
    await page.waitForTimeout(300)
  }
  return null
}

await step('대화 모드(호출어 없이 바로 명령)에서 20초간 키보드만 → 녹음·인식·명령 0건', async () => {
  const { app, page, logs } = await launch(wav(10), { voice: { wakeWordEnabled: false } })
  try {
    await page.waitForTimeout(20000)
    const utter = logs.filter((l) => /\[voice\] (utterance|transcript)/.test(l.t))
    const jobs = await page.$$('[data-testid=jarvis-job]')
    assert(utter.length === 0, `키보드 소리가 발화로 잡힘: ${utter.map((l) => l.t).join(' | ')}`)
    assert(jobs.length === 0, `키보드 소리로 명령이 실행됨 (${jobs.length}건)`)
  } finally {
    await app.close()
  }
})

// 호출어 판정 자체는 Whisper 정확도에 좌우된다(합성 음성은 "헤이 사비스" 등으로 자주 들림 — 변경 전 코드도 동일).
// 여기서는 "타건음 속에서도 사람 말은 녹음되어 Whisper 로 넘어가는가"를 확인한다.
const wakeCase = (label, keys) => step(`${label} "헤이 자비스" → 말이 녹음되어 인식기로 전달 (타건음은 걸러도 말은 통과)`, async () => {
  const { app, page, logs } = await launch(wav(12, [{ at: 3, pcm: sayPcm('헤이 자비스') }], keys), {})
  try {
    const hit = await waitLog(page, logs, /\[voice\] transcript: "헤이/, 60000)
    assert(hit, '말이 녹음/인식되지 않음')
    const all = logs.filter((l) => /\[voice\] utterance/.test(l.t))
    assert(all.every((l) => Number(/ (\d+)ms/.exec(l.t)[1]) < 3000), `녹음이 타건음 때문에 길어짐: ${all.map((l) => l.t).join(' | ')}`)
  } finally {
    await app.close()
  }
})
await wakeCase('조용할 때', 0)
await wakeCase('키보드 치는 중', KEY_GAIN)

await step('JARVIS 가 길게 말하는 중 "잠깐, 멈춰" → TTS 즉시 중단 + 호출어 없이 정지 명령 + 이력 기록', async () => {
  const { app, page, logs } = await launch(wav(10, [{ at: 4, pcm: sayPcm('잠깐, 멈춰') }]), {})
  try {
    // 호출어 없는 말은 평소(대기 중)엔 무시되어야 한다
    await page.waitForTimeout(12000)
    assert(!(await page.$('[data-testid=jarvis-job]')), '대기 중 호출어 없는 말로 명령이 실행됨')
    const longText = Array.from({ length: 12 }, (_, i) => `${i + 1}번째 항목을 차근차근 설명드리겠습니다.`).join(' ')
    const t0 = Date.now()
    await app.evaluate(({ BrowserWindow }, t) => BrowserWindow.getAllWindows()[0].webContents.send('jarvis:speak', t), longText)
    const barge = await waitLog(page, logs, /\[voice\] barge-in/, 30000, t0)
    assert(barge, '말하는 중 사용자 말에 끼어들지 못함')
    const speaking = await page.evaluate(() => speechSynthesis.speaking)
    console.log(`      끼어들기까지 ${((barge.at - t0) / 1000).toFixed(1)}s, 직후 speechSynthesis.speaking=${speaking}`)
    const tr = await waitLog(page, logs, /\[voice\] transcript/, 60000, barge.at)
    assert(tr, '끼어든 말이 인식되지 않음')
    const auditFile = join(userData, 'audit', 'audit.jsonl')
    let entry = null
    const t1 = Date.now()
    while (Date.now() - t1 < 15000 && !entry) {
      if (existsSync(auditFile)) entry = readFileSync(auditFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.action === 'agent.interrupt' && e.ts >= new Date(t0).toISOString())
      if (!entry) await page.waitForTimeout(300)
    }
    assert(entry, `정지 명령 이력이 없음 (인식: ${tr.t})`)
    console.log(`      이력: ${JSON.stringify({ action: entry.action, detail: entry.detail, source: entry.source })}`)
    assert(entry.detail.via === 'voice', '이력에 음성 경로가 기록되지 않음')
    assert(!(await page.$('[data-testid=jarvis-job]')), '정지 명령이 새 작업으로 실행됨')
  } finally {
    await app.close()
  }
})

console.log(failures ? `\n${failures} 단계 실패` : '\n끼어들기/키보드 E2E 통과')
process.exit(failures ? 1 : 0)
