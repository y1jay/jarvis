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
