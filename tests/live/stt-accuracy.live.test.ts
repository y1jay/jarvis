// 음성 인식 정확도 측정 (창 없음, 토큰 사용 없음)
// 실제 VoiceEngine 의 말 구간 자르기 → 실제 whisper.cpp 엔진까지 그대로 통과시켜 글자 오류율(CER)을 잰다.
// 블루투스 통화 음질(8kHz 대역 + 작은 음량 + 잡음)과 문장 중간 쉼을 재현한다.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_TRANSCRIBE, NativeStt, MODELS, type TranscribeOptions } from '../../src/main/stt'
import { VAD_TUNING, VoiceEngine } from '../../src/renderer/src/voice/VoiceEngine'

const SR = 16000
const FRAME = 1024
const root = join(__dirname, '../..')
const binary = join(root, 'resources', 'bin', `${process.platform}-${process.arch}`, 'whisper-server')
const MODEL_KEY = process.env.STT_MODEL ?? 'large-v3-turbo'
const MODEL = MODELS[MODEL_KEY].file
const modelSrc = [join(homedir(), 'Library/Application Support/JARVIS/models', MODEL), join(root, '.cache/models', MODEL)].find((p) => existsSync(p))
const PROMPT = '헤이 자비스, 자비스, 깃허브, 아이폰 시뮬레이터, 에뮬레이터, 슬랙, 카톡, 크롬, 유튜브, 커밋, 푸시'

// [[slnc N]] = 말 중간에 N ms 쉼 (사람이 생각하며 말하는 것처럼)
const SENTENCES = [
  '자비스 [[slnc 400]] 다운로드 폴더 열어줘',
  '오늘 일정 정리해서 [[slnc 700]] 슬랙으로 보내줘',
  '목소리 좀 더 [[slnc 500]] 낮게 바꿔줘',
  '크롬 열어서 유튜브에서 [[slnc 650]] 아이유 노래 틀어줘',
  '방금 만든 커밋은 [[slnc 900]] 푸시하지 말고 기다려',
  '아이폰 시뮬레이터 띄워서 [[slnc 700]] 로그인 화면 확인해줘',
  '지금 몇 시야',
  '카톡으로 엄마한테 [[slnc 600]] 오늘 좀 늦는다고 보내줘'
]
const truth = (s: string): string => s.replace(/\[\[slnc \d+\]\]/g, '')

const dir = mkdtempSync(join(tmpdir(), 'jv-acc-'))
function readWav(p: string): Float32Array {
  const b = readFileSync(p)
  const di = b.indexOf('data') + 8
  const n = (b.length - di) >> 1
  const s = new Float32Array(n)
  for (let i = 0; i < n; i++) s[i] = b.readInt16LE(di + i * 2) / 32768
  return s
}
function tts(text: string, i: number, bt: boolean): Float32Array {
  const aiff = join(dir, `${i}.aiff`)
  const wav = join(dir, `${i}.wav`)
  if (!existsSync(wav)) {
    execFileSync('say', ['-v', 'Yuna', '-r', '185', '-o', aiff, text])
    execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav])
  }
  if (!bt) return readWav(wav)
  // 블루투스 통화(HFP) 음질: 300~3400Hz, 8kHz 로 떨어졌다가 16kHz 로, 음량 1/4
  const n8 = join(dir, `${i}-8k.wav`)
  const out = join(dir, `${i}-bt.wav`)
  if (!existsSync(out)) {
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', wav, '-af', 'highpass=f=300,lowpass=f=3400,volume=0.25', '-ar', '8000', n8])
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', n8, '-ar', '16000', out])
  }
  return readWav(out)
}
function rng(seed: number): () => number {
  let s = seed
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1
}
/** 앞뒤 무음 + 잡음 (방 소음) */
function scene(speech: Float32Array, noise: number, seed: number): Float32Array {
  const r = rng(seed)
  const lead = SR * 1.2
  const tail = SR * 1.6
  const out = new Float32Array(lead + speech.length + tail)
  let lp = 0
  for (let i = 0; i < out.length; i++) {
    lp = lp * 0.9 + r() * 0.1 // 저역 위주 잡음
    out[i] = lp * noise * 3 + (i >= lead && i < lead + speech.length ? speech[i - lead] : 0)
  }
  return out
}

function cer(ref: string, hyp: string): number {
  const norm = (t: string): string[] => [...t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')]
  const a = norm(ref)
  const b = norm(hyp)
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return d[a.length][b.length] / Math.max(1, a.length)
}

/** 실제 VoiceEngine 에 실제 시간 흐름대로 소리를 흘려보내고, 실제 엔진으로 인식해 최종 실행될 명령을 받는다 */
async function runCommands(audio: Float32Array, stt: NativeStt, opts: TranscribeOptions): Promise<{ commands: string[]; requests: number; ms: number }> {
  const commands: string[] = []
  let requests = 0
  let ms = 0
  const e = new VoiceEngine(
    { model: 'x', language: 'korean', wakeWords: ['자비스'], wakeWordEnabled: true, ttsVoice: null, ttsRate: 1 },
    { onPhase: () => undefined, onLevel: () => undefined, onTranscript: () => undefined, onCommand: (t) => commands.push(t), onWake: () => undefined, onProgress: () => undefined, onError: () => undefined }
  )
  const p = e as unknown as Record<string, unknown>
  p.stream = { getTracks: () => [], getAudioTracks: () => [] }
  p.ready = true
  p.speakEndedAt = -1e9
  p.conversation = true
  p.earcon = () => undefined
  p.transcribe = async (a: Float32Array) => {
    const t = Date.now()
    const r = await stt.transcribe(a, PROMPT, opts)
    ms += Date.now() - t
    requests++
    return r
  }
  ;(p.setPhase as (x: string) => void).call(e, 'awake')
  const t0 = Date.now()
  for (let k = 0, i = 0; i + FRAME <= audio.length; i += FRAME, k++) {
    ;(p.onAudio as (b: Float32Array) => void).call(e, audio.slice(i, i + FRAME))
    const due = t0 + ((k + 1) * FRAME * 1000) / SR
    const wait = due - Date.now()
    await new Promise((r) => setTimeout(r, Math.max(0, wait)))
  }
  await new Promise((r) => setTimeout(r, 3000)) // 기다리던 말 처리
  e.stop()
  return { commands, requests, ms }
}

type Config = { name: string; vad: { endSilenceMs: number; continueOnEnergy: boolean; holdUnfinishedMs: number }; stt: TranscribeOptions }
const CONFIGS: Config[] = [
  { name: '이전 설정', vad: { endSilenceMs: 600, continueOnEnergy: false, holdUnfinishedMs: 0 }, stt: { beamSize: 1, normalize: false } },
  { name: '개선 (앱 기본값)', vad: { ...VAD_TUNING }, stt: { ...DEFAULT_TRANSCRIBE } },
  ...(process.env.STT_TRY_FAST ? [{ name: '말끝 0.6초', vad: { ...VAD_TUNING, endSilenceMs: 600 }, stt: { ...DEFAULT_TRANSCRIBE } }] : [])
]
const ALL_CONDITIONS = [
  { name: '깨끗', bt: false, noise: 0.001 },
  { name: '블루투스', bt: true, noise: 0.003 },
  { name: '블루투스+소음', bt: true, noise: 0.008 }
]
const CONDITIONS = process.env.STT_CONDS ? ALL_CONDITIONS.filter((c) => process.env.STT_CONDS!.split(',').includes(c.name)) : ALL_CONDITIONS

describe.skipIf(!existsSync(binary) || !modelSrc || process.platform !== 'darwin')('음성 인식 정확도 (실제 엔진)', () => {
  let stt: NativeStt
  beforeAll(async () => {
    vi.stubGlobal('speechSynthesis', { cancel: () => undefined, getVoices: () => [] })
    const md = join(dir, 'models')
    mkdirSync(md, { recursive: true })
    copyFileSync(modelSrc!, join(md, MODEL))
    stt = new NativeStt({ binary, modelsDir: md, modelKey: () => MODEL_KEY, onState: () => undefined })
    expect(await stt.start()).toBe(true)
  })
  afterAll(() => {
    stt?.stop()
    vi.unstubAllGlobals()
  })

  it('설정별 글자 오류율 비교', async () => {
    const saved = { ...VAD_TUNING }
    const table: Record<string, Record<string, { cer: number; segs: number; ms: number }>> = {}
    const samples: string[] = []
    for (const cfg of CONFIGS) {
      Object.assign(VAD_TUNING, cfg.vad)
      table[cfg.name] = {}
      for (const cond of CONDITIONS) {
        let errSum = 0
        let segSum = 0
        let msSum = 0
        let nReq = 0
        for (let i = 0; i < SENTENCES.length; i++) {
          const audio = scene(tts(SENTENCES[i], i, cond.bt), cond.noise, i + 1)
          const r = await runCommands(audio, stt, cfg.stt)
          const hyp = r.commands.join(' ')
          const ref = truth(SENTENCES[i]).replace(/^\s*자비스\s*/, '') // 호출어는 명령에서 빠진다
          errSum += cer(ref, hyp)
          segSum += r.commands.length
          msSum += r.ms
          nReq += r.requests
          if (cond.name === '블루투스+소음') samples.push(`${cfg.name} | ${ref.replace(/\s+/g, ' ')} → [${r.commands.join(' / ')}]`)
        }
        table[cfg.name][cond.name] = { cer: errSum / SENTENCES.length, segs: segSum / SENTENCES.length, ms: msSum / Math.max(1, nReq) }
      }
    }
    Object.assign(VAD_TUNING, saved)
    const report: string[] = []
    const log = (l: string): void => {
      report.push(l)
      console.log(l)
    }
    log('\n설정 | ' + CONDITIONS.map((c) => `${c.name} 정확도(명령 수)`).join(' | ') + ' | 인식 시간')
    for (const [name, row] of Object.entries(table)) {
      const ms = Object.values(row).reduce((a, r) => a + r.ms, 0) / CONDITIONS.length
      log(`${name} | ` + CONDITIONS.map((c) => `${(100 - row[c.name].cer * 100).toFixed(1)}% (${row[c.name].segs.toFixed(1)})`).join(' | ') + ` | ${ms.toFixed(0)}ms`)
    }
    console.log('\n' + samples.join('\n'))
    // 통과해도 결과를 볼 수 있게 파일로도 남긴다
    if (process.env.STT_REPORT) writeFileSync(process.env.STT_REPORT, report.join('\n') + '\n\n' + samples.join('\n') + '\n')
    const prod = table[CONFIGS[1].name]
    const old = table[CONFIGS[0].name]
    // 개선 설정이 모든 조건에서 이전보다 좋아야 하고, 블루투스+소음에서도 90% 이상
    for (const c of CONDITIONS) expect(prod[c.name].cer).toBeLessThanOrEqual(old[c.name].cer)
    if (prod['블루투스+소음']) expect(1 - prod['블루투스+소음'].cer).toBeGreaterThan(0.9)
  }, 900_000)
})
