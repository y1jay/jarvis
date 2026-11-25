// 실제 Claude: 영어로 나갔던 실제 답(11/24)을 한국어로 옮기는지 + 코드·해시는 그대로인지 + 걸리는 시간
import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { writeFileSync } from 'node:fs'
import { oneShot } from '../../src/main/oneshot'
import { isMostlyForeign, translatePrompt } from '../../src/shared/lang'

const REAL = [
  'I deployed the functions for the damage rebalance and the item lifesteal cut to the production server. All five functions (summon, coopStart, raidStart, colosseumAttack, colosseumDefend) are active. Commit `63c0b133` is on dev; main is still behind, so merge it before the next release.',
  'Checked on the simulator: the rebalanced numbers show in the game exactly as the code computes them. One thing to note: this simulator account was already linked and had cleared floor 42, so the premium tickets were granted by the server rules.'
]

describe('답은 무조건 한국어 (실제 Claude)', () => {
  it('영어 답 → 한국어', async () => {
    const lines: string[] = []
    for (const en of REAL) {
      expect(isMostlyForeign(en)).toBe(true)
      const t0 = Date.now()
      const ko = await oneShot('claude', translatePrompt(en), tmpdir(), {}, process.env.KO_MODEL ?? 'sonnet')
      const ms = Date.now() - t0
      lines.push(`${ms}ms\n원문: ${en}\n번역: ${ko}\n`)
      expect(isMostlyForeign(ko)).toBe(false)
      expect((ko.match(/[가-힣]/g) ?? []).length).toBeGreaterThan(40)
    }
    expect((lines.join('\n').match(/63c0b133/g) ?? []).length).toBe(2)
    writeFileSync(`${tmpdir()}/jarvis-korean-live.txt`, lines.join('\n'))
    console.log(lines.join('\n'))
  })
})
