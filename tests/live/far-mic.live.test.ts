// 멀리서 말할 때 (실제 마이크 잡음 위에 작은 목소리) — 말 감지·인식 비교. 잡음 파일은 STT_NOISE_WAV 로 지정
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_TRANSCRIBE, MODELS, NativeStt } from '../../src/main/stt'
import { VAD_TUNING, VoiceEngine } from '../../src/renderer/src/voice/VoiceEngine'

const SR = 16000
const FRAME = 1024
const root = join(__dirname, '../..')
const binary = join(root, 'resources/bin', `${process.platform}-${process.arch}`, 'whisper-server')
const MODEL = MODELS['large-v3-turbo'].file
const modelSrc = [join(homedir(), 'Library/Application Support/JARVIS/models', MODEL), join(root, '.cache/models', MODEL)].find((p) => existsSync(p))
const noiseWav = process.env.STT_NOISE_WAV
const readWav = (p: string): Float32Array => {
  const b = readFileSync(p)
  const di = b.indexOf('data') + 8
  return new Float32Array((b.length - di) >> 1).map((_, i) => b.readInt16LE(di + i * 2) / 32768)
}
const SENTENCES = ['자비스 지금 몇 시야', '다운로드 폴더 열어줘', '목소리 좀 더 낮게 바꿔줘', '오늘 일정 정리해서 슬랙으로 보내줘']

describe.skipIf(!noiseWav || !existsSync(binary) || !modelSrc)('멀리서 말하기', () => {
  let stt: NativeStt
  const dir = mkdtempSync(join(tmpdir(), 'jv-far-'))
  beforeAll(async () => {
    vi.stubGlobal('speechSynthesis', { cancel: () => undefined, getVoices: () => [] })
    mkdirSync(join(dir, 'm'))
    copyFileSync(modelSrc!, join(dir, 'm', MODEL))
    stt = new NativeStt({ binary, modelsDir: join(dir, 'm'), modelKey: () => 'large-v3-turbo', onState: () => undefined })
    expect(await stt.start()).toBe(true)
  })
  afterAll(() => {
    stt?.stop()
    vi.unstubAllGlobals()
  })

  it('거리별 감지율', async () => {
    const noise = readWav(noiseWav!)
    const speech = SENTENCES.map((t, i) => {
      execFileSync('say', ['-v', 'Yuna', '-o', join(dir, `${i}.aiff`), t])
      execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', join(dir, `${i}.aiff`), join(dir, `${i}.wav`)])
      return readWav(join(dir, `${i}.wav`))
    })
    const rmsOf = (x: Float32Array): number => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length)
    const noiseRms = rmsOf(noise)
    const lines: string[] = [`실제 잡음 rms=${noiseRms.toFixed(4)}`]
    // 가까이(잡음의 15배) / 중간(5배) / 멀리(2.5배) / 아주 멀리(1.8배) — 목소리 rms 기준
    const cer = (ref: string, hyp: string): number => {
      const a = [...ref.replace(/[^가-힣]/g, '')]
      const b = [...hyp.replace(/[^가-힣]/g, '')]
      const d = Array.from({ length: a.length + 1 }, (_, x) => [x, ...new Array(b.length).fill(0)])
      for (let y = 1; y <= b.length; y++) d[0][y] = y
      for (let x = 1; x <= a.length; x++) for (let y = 1; y <= b.length; y++) d[x][y] = Math.min(d[x - 1][y] + 1, d[x][y - 1] + 1, d[x - 1][y - 1] + (a[x - 1] === b[y - 1] ? 0 : 1))
      return d[a.length][b.length] / a.length
    }
    // 목소리 크기 = 잡음 rms 의 몇 배 (가까이 15배, 중간 5배, 멀리 2.5배, 아주 멀리 1.8배)
    for (const [label, ratio] of [['가까이', 15], ['중간', 5], ['멀리', 2.5], ['아주 멀리', 1.8]] as const) {
      for (const legacy of [true, false]) {
        Object.assign(VAD_TUNING, legacy ? { legacyNoise: true, noiseRatio: 2.5 } : { legacyNoise: false, noiseRatio: 2 })
        let detected = 0
        let err = 0
        for (let i = 0; i < speech.length; i++) {
          const s = speech[i]
          const g = (noiseRms * ratio) / rmsOf(s)
          // 실제 잡음을 바닥에 계속 깔고: 0.5초 가까이서 한 큰 말(소음 추정이 오르는 상황) → 2.5초 쉼 → 작은 목소리 → 2초
          const loudAt = SR * 2
          const speechAt = SR * 5
          const total = speechAt + s.length + SR * 2
          const audio = new Float32Array(total)
          for (let k = 0; k < total; k++) audio[k] = noise[k % noise.length]
          for (let k = 0; k < SR / 2; k++) audio[loudAt + k] += speech[(i + 1) % speech.length][k] * ((noiseRms * 15) / rmsOf(speech[(i + 1) % speech.length]))
          for (let k = 0; k < s.length; k++) audio[speechAt + k] += s[k] * g
          const heard: Array<{ a: Float32Array; at: number }> = []
          let frame = 0
          const e = new VoiceEngine({ model: 'x', language: 'korean', wakeWords: ['자비스'], wakeWordEnabled: true, ttsVoice: null, ttsRate: 1 }, { onPhase: () => undefined, onLevel: () => undefined, onTranscript: () => undefined, onCommand: () => undefined, onWake: () => undefined, onProgress: () => undefined, onError: () => undefined })
          const p = e as unknown as Record<string, unknown>
          p.stream = { getTracks: () => [], getAudioTracks: () => [] }
          p.ready = true
          p.speakEndedAt = -1e9
          p.conversation = true
          p.earcon = () => undefined
          p.transcribe = async (a: Float32Array) => {
            heard.push({ a, at: frame * FRAME })
            return ''
          }
          ;(p.setPhase as (x: string) => void).call(e, 'awake')
          for (let k = 0; k + FRAME <= audio.length; k += FRAME, frame++) (p.onAudio as (b: Float32Array) => void).call(e, audio.slice(k, k + FRAME))
          await new Promise((r) => setTimeout(r, 0))
          // 작은 목소리 구간에서 끝난 조각들
          // 첫 조각은 앞서 가까이서 한 큰 말 → 그 뒤 조각들이 작은 목소리 (인식 호출은 끝에 몰려서 순서로 구분)
          const mine = heard.slice(1)
          if (mine.length) {
            detected++
            const texts: string[] = []
            for (const h of mine) texts.push(await stt.transcribe(h.a, '', DEFAULT_TRANSCRIBE))
            err += Math.min(1, cer(SENTENCES[i], texts.join(' ')))
            if (process.env.STT_DEBUG) lines.push(`    ${label}/${legacy ? '이전' : '개선'} "${SENTENCES[i]}" → [${texts.join(' / ')}] 조각 ${mine.length}`)
          } else err += 1
        }
        lines.push(`${label}(목소리=잡음×${ratio}) ${legacy ? '이전' : '개선'}: 감지 ${detected}/${speech.length}, 정확도 ${(100 - (err / speech.length) * 100).toFixed(0)}%`)
      }
    }
    Object.assign(VAD_TUNING, { legacyNoise: false, noiseRatio: 2 })
    if (process.env.STT_REPORT) writeFileSync(process.env.STT_REPORT, lines.join('\n'))
    console.log(lines.join('\n'))
  }, 600_000)
})
