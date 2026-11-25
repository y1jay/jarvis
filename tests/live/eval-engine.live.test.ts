// 학습 뒤 비교 단계 재현 (앱이 남긴 평가용 말소리로): 지금 모델 vs 새 모델, 시간·오류
import { expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { MODELS, NativeStt } from '../../src/main/stt'
import { cer } from '../../src/main/learn'

const UD = join(homedir(), 'Library/Application Support/jarvis')
const BIN = join(process.cwd(), 'dist/mac-arm64/JARVIS.app/Contents/Resources/bin/darwin-arm64/whisper-server')
const NEW = join(UD, 'learn/out/ggml-model.bin')

it('비교용 엔진: 지금 모델 / 새 모델', async () => {
  expect(existsSync(NEW)).toBe(true)
  const items = readFileSync(join(UD, 'learn/data/items.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { text: string; split: string }).filter((x) => x.split === 'eval')
  const pcmDir = join(UD, 'learn/eval-pcm')
  const pcms = readdirSync(pcmDir).sort((a, b) => parseInt(a) - parseInt(b)).map((f) => { const b = readFileSync(join(pcmDir, f)); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) })
  const md = mkdtempSync(join(tmpdir(), 'jarvis-eval-'))
  symlinkSync(join(UD, 'models', MODELS['large-v3'].file), join(md, MODELS['large-v3'].file))
  symlinkSync(NEW, join(md, MODELS.personal.file))
  const lines: string[] = [`평가 말소리 ${pcms.length}개 / 문장 ${items.length}개`]
  const score: Record<string, number> = {}
  for (const key of ['large-v3', 'personal']) {
    const states: string[] = []
    const s = new NativeStt({ binary: BIN, modelsDir: md, modelKey: () => key, onState: (st) => states.push(`${st.state}${st.message ? ':' + st.message : ''}`) })
    const t0 = Date.now()
    const ok = await s.start()
    lines.push(`${key} 시작 ${ok} ${Date.now() - t0}ms ${states.join(' | ')}`)
    expect(ok).toBe(true)
    let err = 0
    const t1 = Date.now()
    for (let i = 0; i < pcms.length; i++) {
      const out = await s.transcribe(pcms[i])
      const e = cer(items[i].text, out)
      err += e
      lines.push(`  [${key}] ${(e * 100).toFixed(0)}%틀림 정답="${items[i].text}" 들은="${out}"`)
    }
    score[key] = 1 - err / pcms.length
    lines.push(`${key} 정확도 ${(score[key] * 100).toFixed(1)}% (${((Date.now() - t1) / 1000).toFixed(1)}초)`)
    s.stop()
  }
  writeFileSync(join(tmpdir(), 'jv-eval.txt'), lines.join('\n'))
}, 900_000)
