// 실제 동작 (창 없음): 앱과 같은 경로로 목소리 엔진 설치 → 문장 생성 → 다시 인식해서 한국어 확인
import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { TtsHub } from '../../src/main/tts'
import { NativeStt, MODELS } from '../../src/main/stt'

const root = join(__dirname, '../..')
const binary = join(root, 'resources/bin', `${process.platform}-${process.arch}`, 'whisper-server')
const sttModel = join(homedir(), 'Library/Application Support/JARVIS/models')

async function heard(wav: Buffer, stt: NativeStt): Promise<string> {
  // WAV(16bit) → 16kHz Float32 (간단 리샘플)
  const di = wav.indexOf('data') + 8
  const sr = wav.readUInt32LE(24)
  const n = (wav.length - di) >> 1
  const src = new Float32Array(n).map((_, i) => wav.readInt16LE(di + i * 2) / 32768)
  const out = new Float32Array(Math.floor((n * 16000) / sr)).map((_, i) => src[Math.floor((i * sr) / 16000)])
  return stt.transcribe(out)
}

describe.skipIf(process.platform !== 'darwin' || !existsSync(binary) || !existsSync(join(sttModel, MODELS['large-v3'].file)))('목소리 엔진 (실제)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jv-tts-'))
  const states: string[] = []
  const hub = new TtsHub(dir, join(root, 'resources/tts'), (s) => states.push(`${s.engine}:${s.state}:${s.message ?? ''}`))
  const lines: string[] = []

  it('Supertonic: 모델 받기 → 고른 목소리(4·7·10)로 생성 → 한국어로 들림', async () => {
    const stt = new NativeStt({ binary, modelsDir: sttModel, modelKey: () => 'large-v3', onState: () => undefined })
    expect(await stt.start()).toBe(true)
    const t0 = Date.now()
    await hub.install('supertonic')
    lines.push(`Supertonic 설치 ${((Date.now() - t0) / 1000).toFixed(1)}초`)
    for (const sid of [3, 6, 9]) {
      const t = Date.now()
      const wav = (await hub.speak(`supertonic:${sid}`, '다운로드 폴더를 열었어요.'))!
      const ms = Date.now() - t
      const text = await heard(wav, stt)
      lines.push(`supertonic:${sid} ${ms}ms → "${text}"`)
      expect(text).toMatch(/다운로드\s*폴더/)
    }
    stt.stop()
  }, 600_000)

  it('Qwen3: 엔진 설치 → 서버 → 소희·비서로 생성 → 한국어로 들림', async () => {
    const stt = new NativeStt({ binary, modelsDir: sttModel, modelKey: () => 'large-v3', onState: () => undefined })
    expect(await stt.start()).toBe(true)
    const t0 = Date.now()
    await hub.install('qwen3')
    lines.push(`Qwen3 설치 ${((Date.now() - t0) / 1000).toFixed(1)}초`)
    for (const id of ['qwen3:sohee', 'qwen3:assistant']) {
      const tw = Date.now()
      await hub.warm(id)
      lines.push(`${id} 준비 ${((Date.now() - tw) / 1000).toFixed(1)}초`)
      for (const sentence of ['네, 말씀하세요.', '커밋은 아직 안 했어요. 확인해 주시면 바로 올릴게요.']) {
        const t = Date.now()
        const wav = (await hub.speak(id, sentence))!
        const ms = Date.now() - t
        const text = await heard(wav, stt)
        lines.push(`${id} ${ms}ms → "${text}"`)
        expect(text.replace(/[\s.,!?]/g, '')).toContain(sentence.replace(/[\s.,!?]/g, '').slice(0, 4))
      }
    }
    hub.stop()
    stt.stop()
  }, 1_800_000)

  it('보고', () => {
    if (process.env.STT_REPORT) writeFileSync(process.env.STT_REPORT, lines.join('\n') + '\n' + states.slice(-5).join('\n'))
    console.log(lines.join('\n'))
  })
})
