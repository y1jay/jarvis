// 실제 동작 (창 없음): 맞춤 학습 결과 비교 — 학습에 안 쓴 말소리로 지금 모델 vs 새 모델
// LEARN_DIR: 학습 환경(venv)과 data/items.jsonl, out/ggml-model.bin 이 있는 폴더
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cer, opusToOgg, VoiceTrainer } from '../../src/main/learn'
import { NativeStt, MODELS } from '../../src/main/stt'

const root = join(__dirname, '../..')
const binary = join(root, 'resources/bin', `${process.platform}-${process.arch}`, 'whisper-server')
const dir = process.env.LEARN_DIR ?? ''
const electron = join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')

describe.skipIf(!dir || !existsSync(join(dir, 'venv')))('맞춤 학습 (실제)', () => {
  const trainer = new VoiceTrainer(dir, join(root, 'resources/learn'), () => undefined)

  it('앱이 저장한 형식(Opus 패킷) → Ogg → 학습 도구로 풀림', async () => {
    const d = mkdtempSync(join(tmpdir(), 'jv-ogg-'))
    execFileSync('say', ['-v', 'Yuna', '-o', join(d, 'a.aiff'), '엑스크롤 비이 테스트 돌려줘'])
    execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', join(d, 'a.aiff'), join(d, 'a.wav')])
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    execFileSync(electron, [join(__dirname, 'helpers/opus-encode.cjs'), join(d, 'a.wav'), join(d, 'p.json')], { env, timeout: 40000 })
    const packets = (JSON.parse(readFileSync(join(d, 'p.json'), 'utf8')) as string[]).map((b) => new Uint8Array(Buffer.from(b, 'base64')))
    writeFileSync(join(d, 'a.ogg'), opusToOgg(packets, 16000))
    const [pcm] = await trainer.decode([join(d, 'a.ogg')])
    const secs = readFileSync(join(d, 'a.wav')).length / 32000
    expect(Math.abs(pcm.length / 16000 - secs)).toBeLessThan(0.15)
  }, 120_000)

  it('지금 모델 vs 학습한 모델', async () => {
    const items = readFileSync(join(dir, 'data/items.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { audio: string; text: string; split: string; spoken?: string })
    const evalItems = items.filter((x) => x.split === 'eval')
    const pcms = await trainer.decode(evalItems.map((x) => x.audio))
    const models = mkdtempSync(join(tmpdir(), 'jv-models-'))
    mkdirSync(models, { recursive: true })
    symlinkSync(join(root, '.cache/models', MODELS['large-v3-turbo'].file), join(models, MODELS['large-v3-turbo'].file))
    symlinkSync(join(dir, 'out/ggml-model.bin'), join(models, MODELS.personal.file))
    const lines: string[] = []
    const score: Record<string, number> = {}
    for (const key of ['large-v3-turbo', 'personal']) {
      const stt = new NativeStt({ binary, modelsDir: models, modelKey: () => key, onState: () => undefined })
      expect(await stt.start()).toBe(true)
      let err = 0
      for (let i = 0; i < evalItems.length; i++) {
        const out = await stt.transcribe(pcms[i])
        const e = cer(evalItems[i].text, out)
        err += e
        lines.push(`${key} ${(1 - e).toFixed(2)}  정답 "${evalItems[i].text}" → "${out}"`)
      }
      score[key] = 1 - err / evalItems.length
      stt.stop()
    }
    lines.push(`정확도: 지금 모델 ${(score['large-v3-turbo'] * 100).toFixed(1)}% → 학습한 모델 ${(score.personal * 100).toFixed(1)}%`)
    if (process.env.STT_REPORT) writeFileSync(process.env.STT_REPORT, lines.join('\n'))
    console.log(lines.join('\n'))
    expect(score.personal).toBeGreaterThan(score['large-v3-turbo'])
  }, 900_000)
})
