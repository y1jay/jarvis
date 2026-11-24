// 실제 이 맥의 시뮬레이터 목록에서 기본 기기 선택 확인 (부팅하지 않음)
import { describe, expect, it } from 'vitest'
import { DeviceHub } from '../../src/main/devices'

describe.skipIf(process.platform !== 'darwin')('기본 기기 = 아이폰 시뮬레이터', () => {
  it('묻지 않고 고를 기기', async () => {
    const h = new DeviceHub()
    const list = await h.choices('ios')
    const pick = h.pickDefault(list)
    console.log(`  시뮬레이터 ${list.length}개 → 기본: ${pick?.label}`)
    if (list.length) expect(pick?.label).toMatch(/iPhone/)
  }, 60_000)
})
