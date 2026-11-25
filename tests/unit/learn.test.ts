// 맞춤 학습 자료 고르기·나누기·평가
import { describe, expect, it } from 'vitest'
import { cer, opusToOgg, splitSamples, usableSamples } from '../../src/main/learn'
import type { VoiceSample } from '../../src/main/voicevault'

const pk = Array.from({ length: 20 }, () => new Uint8Array(30))
const s = (o: Partial<VoiceSample>): VoiceSample => ({ ts: 1, heard: '', sampleRate: 16000, packets: pk, ...o })

describe('학습에 쓸 말소리 고르기', () => {
  it('바로잡은 말은 바로잡은 문장으로, 확신한 말만, 애매한 말은 뺀다', () => {
    const got = usableSamples([
      s({ heard: '에퍼리 다 내려봤다', final: '목소리 더 내려받기', corrected: true }),
      s({ heard: '다운로드 폴더 열어줘', logprob: -0.03 }),
      s({ heard: '오늘 일정 정리에서', logprob: -0.2 }), // 자신 없음 → 제외
      s({ heard: '확인 안 된 말' }), // 확신도 모름 → 제외
      s({ heard: '짧음', logprob: -0.01, packets: [new Uint8Array(3)] }) // 너무 짧은 소리 → 제외
    ])
    expect(got.map((x) => x.text)).toEqual(['목소리 더 내려받기', '다운로드 폴더 열어줘'])
  })
  it('평가용은 학습과 겹치지 않고 15%(최소 5개)', () => {
    const items = Array.from({ length: 100 }, (_, i) => i)
    const { train, evalSet } = splitSamples(items)
    expect(evalSet).toHaveLength(15)
    expect(train).toHaveLength(85)
    expect(new Set([...train, ...evalSet]).size).toBe(100)
    expect(splitSamples(Array.from({ length: 20 }, (_, i) => i)).evalSet).toHaveLength(5)
  })
  it('글자 오류율', () => {
    expect(cer('xcroll-be 배포 상태 알려줘', 'xcroll-be 배포 상태 알려줘.')).toBe(0)
    expect(cer('지금 몇 시야', '지금 역시야')).toBeCloseTo(1 / 5, 5)
  })
  it('Ogg 파일 형식 (Opus 머리말 + 페이지)', () => {
    const o = opusToOgg(pk, 16000)
    expect(o.subarray(0, 4).toString()).toBe('OggS')
    expect(o.includes(Buffer.from('OpusHead'))).toBe(true)
    expect(o.includes(Buffer.from('OpusTags'))).toBe(true)
  })
})

describe('자동 학습 시점', () => {
  it('쉬고 있고, 전원 연결, 말소리가 충분하면 스스로 학습', async () => {
    const { shouldAutoTrain, AUTO_LEARN, MIN_SAMPLES } = await import('../../src/main/learn')
    const base = { learning: true, training: false, busy: false, idleMs: AUTO_LEARN.idleMs, onBattery: false, usable: MIN_SAMPLES, lastUsable: 0 }
    expect(shouldAutoTrain(base)).toBe(true)
    expect(shouldAutoTrain({ ...base, usable: MIN_SAMPLES - 1 })).toBe(false)
    expect(shouldAutoTrain({ ...base, busy: true })).toBe(false)
    expect(shouldAutoTrain({ ...base, training: true })).toBe(false)
    expect(shouldAutoTrain({ ...base, onBattery: true })).toBe(false)
    expect(shouldAutoTrain({ ...base, idleMs: 60_000 })).toBe(false)
    expect(shouldAutoTrain({ ...base, learning: false })).toBe(false)
    // 한 번 학습한 뒤엔 60개 더 모일 때마다
    expect(shouldAutoTrain({ ...base, usable: 100, lastUsable: 60 })).toBe(false)
    expect(shouldAutoTrain({ ...base, usable: 120, lastUsable: 60 })).toBe(true)
  })
})

describe('잘못된 정답은 배우지 않는다', () => {
  it('[실제] 교정기가 뜻을 뒤집은 문장은 학습에서 뺀다', async () => {
    const { usableSamples } = await import('../../src/main/learn')
    const pk = Array.from({ length: 20 }, () => new Uint8Array(4))
    const s = (heard: string, final?: string, logprob?: number) => ({ ts: 1, heard, final, corrected: !!final, logprob, packets: pk, sampleRate: 16000 })
    const out = usableSamples([
      s('평소에 카드가 커밍돼서 직접 해', '평소에 하던 대로 main 반영은 내가 직접 해'),
      s('이랑 아이템 호텔 감소', '이랑 아이템 흡혈 감소'),
      s('너 말할 때 너무 느려', undefined, -0.05),
      s('자 베이징', undefined, -0.5)
    ]).map((x) => x.text)
    expect(out).toEqual(['이랑 아이템 흡혈 감소', '너 말할 때 너무 느려'])
  })
})
