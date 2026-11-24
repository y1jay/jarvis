// 실제 Claude: 오늘 실제로 잘못 알아들은 말을 문맥으로 바로잡는지 + 맞는 문장은 그대로 두는지 + 속도
import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { writeFileSync } from 'node:fs'
import { SpeechCorrector, type CorrectionContext } from '../../src/main/corrector'

const VOICE_Q = '자비스: 지금은 유나 목소리입니다. 어떤 목소리로 바꿀까요? 한국어 목소리는 지금 하나뿐이라, 더 내려받을 수도 있습니다.'
const OPTS = ['유나', 'Daniel (영어)', 'Karen (영어)', 'Moira (영어)', '목소리 더 내려받기']
const WORDS = ['자비스', 'xcroll-be', 'xcroll-app', '머니트리', '아이폰 시뮬레이터', '슬랙', '카톡', '깃허브', '커밋', '푸시']
type Case = { raw: string; ctx: Partial<CorrectionContext>; expect: RegExp; same?: boolean }
const CASES: Case[] = [
  { raw: '유난한 건 없어', ctx: { recent: `사용자: 목소리를 오픈소스에서 찾아봐\n${VOICE_Q}` }, expect: /유나.*(말고|말곤|밖에|없)/ },
  { raw: '인화 말곤 없어', ctx: { recent: `사용자: 목소리 다른 거 없어?\n${VOICE_Q}` }, expect: /유나\s*말곤/ },
  { raw: '더 내라고 하다가.', ctx: { recent: VOICE_Q, options: OPTS }, expect: /내려받/ },
  { raw: '에퍼리 다 내려봤다.', ctx: { recent: VOICE_Q, options: OPTS }, expect: /내려받/ },
  { raw: '자이스 지금 역시야', ctx: {}, expect: /자비스\s*지금\s*몇\s*시야/ },
  { raw: '나쁜 거야?', ctx: { recent: '사용자: 목소리 바꿔줘\n자비스: 목소리를 Karen 으로 바꿨습니다.' }, expect: /바꾼\s*거야/ },
  { raw: '다운로드 폴더 열어줘', ctx: {}, expect: /^다운로드 폴더 열어줘$/, same: true },
  { raw: '오늘 일정 정리해서 슬랙으로 보내줘', ctx: {}, expect: /^오늘 일정 정리해서 슬랙으로 보내줘$/, same: true },
  { raw: '방금 만든 커밋은 푸시하지 말고 기다려', ctx: {}, expect: /^방금 만든 커밋은 푸시하지 말고 기다려$/, same: true },
  { raw: '엑스크롤 비이 테스트 돌려줘', ctx: {}, expect: /(xcroll-be|엑스크롤 비이) 테스트 돌려줘/ }
]

describe('문맥 보정 (실제 Claude)', () => {
  it('모델별 정확도·속도', async () => {
    const lines: string[] = []
    const score: Record<string, { ok: number; ms: number[] }> = {}
    for (const model of (process.env.CORR_MODELS ?? 'haiku,sonnet').split(',')) {
      const c = new SpeechCorrector({ env: () => ({}), model: () => model, cwd: () => tmpdir(), timeoutMs: 8000 })
      c.warm()
      await new Promise((r) => setTimeout(r, 3000))
      score[model] = { ok: 0, ms: [] }
      for (const k of CASES) {
        const t = Date.now()
        const out = await c.correct(k.raw, { recent: '', words: WORDS, name: '자비스', ...k.ctx })
        const ms = Date.now() - t
        const pass = k.expect.test(out)
        score[model].ok += pass ? 1 : 0
        score[model].ms.push(ms)
        lines.push(`${model} ${pass ? 'O' : 'X'} ${ms}ms  ${k.raw} → ${out}`)
      }
      c.close()
    }
    for (const [m, s] of Object.entries(score)) {
      const sorted = [...s.ms].sort((a, b) => a - b)
      lines.push(`${m}: ${s.ok}/${CASES.length} 맞음, 중간값 ${sorted[Math.floor(sorted.length / 2)]}ms, 최대 ${sorted[sorted.length - 1]}ms`)
    }
    if (process.env.STT_REPORT) writeFileSync(process.env.STT_REPORT, lines.join('\n'))
    console.log(lines.join('\n'))
    expect(Math.max(...Object.values(score).map((s) => s.ok))).toBeGreaterThanOrEqual(8)
  }, 300_000)
})
