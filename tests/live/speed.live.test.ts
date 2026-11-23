// 실제 동작 확인 (창 없음): 네이티브 음성 인식 엔진 + 빠른 대화 경로
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, copyFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NativeStt, MODELS, type SttState } from '../../src/main/stt'
import { FastChat } from '../../src/main/fastchat'

const root = join(__dirname, '../..')
const binary = join(root, 'resources', 'bin', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server')

function speech(text: string): Float32Array {
  const d = mkdtempSync(join(tmpdir(), 'jv-stt-'))
  execFileSync('say', ['-v', 'Yuna', '-o', join(d, 'a.aiff'), text])
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', join(d, 'a.aiff'), join(d, 'a.wav')])
  const b = readFileSync(join(d, 'a.wav'))
  const di = b.indexOf('data') + 8
  const n = (b.length - di) >> 1
  const s = new Float32Array(n)
  for (let i = 0; i < n; i++) s[i] = b.readInt16LE(di + i * 2) / 32768
  return s
}

describe.skipIf(!existsSync(binary) || process.platform !== 'darwin')('네이티브 음성 인식', () => {
  it('모델 다운로드(작은 모델) → 엔진 시작 → 인식', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jv-models-'))
    const states: SttState[] = []
    const stt = new NativeStt({ binary, modelsDir: dir, modelKey: () => 'small', onState: (s) => states.push(s) })
    const t0 = Date.now()
    expect(await stt.start()).toBe(true)
    console.log(`  다운로드+시작 ${Date.now() - t0}ms, 상태: ${[...new Set(states.map((s) => s.state))].join('→')}`)
    expect(states.some((s) => s.state === 'downloading')).toBe(true)
    expect(existsSync(join(dir, MODELS.small.file))).toBe(true)
    const t1 = Date.now()
    const text = await stt.transcribe(speech('자비스, 오늘 일정 알려줘.'))
    console.log(`  인식 ${Date.now() - t1}ms: ${text}`)
    expect(text).toMatch(/일정/)
    stt.stop()
  }, 600_000)

  it('정확한 모델(large-v3-turbo) + 인식 힌트', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jv-models-'))
    // 이미 받아 둔 모델이 있으면 재사용 (다운로드 경로는 위 테스트에서 검증)
    const cached = join(root, '.cache', 'models', MODELS['large-v3-turbo'].file)
    if (existsSync(cached)) {
      mkdirSync(dir, { recursive: true })
      copyFileSync(cached, join(dir, MODELS['large-v3-turbo'].file))
    }
    const stt = new NativeStt({ binary, modelsDir: dir, modelKey: () => 'large-v3-turbo', onState: () => undefined })
    expect(await stt.start()).toBe(true)
    const cases: Array<[string, RegExp]> = [
      ['헤이 자비스, 엑스크롤 비이 프로젝트 열고 테스트 돌려줘.', /xcroll-be/i],
      ['그거 말고 머니트리 백엔드 쪽 결제 API 고쳐줘.', /머니트리\s*백엔드/],
      ['아이폰 시뮬레이터 띄워서 로그인 화면 확인해줘.', /시뮬레이터/]
    ]
    for (const [say, expectRe] of cases) {
      const audio = speech(say)
      const t = Date.now()
      const text = await stt.transcribe(audio, '헤이 자비스, 자비스, xcroll-be, 머니트리 백엔드, 깃허브, 아이폰 시뮬레이터, 에뮬레이터, API')
      const ms = Date.now() - t
      console.log(`  ${ms}ms | ${text}`)
      expect(ms).toBeLessThan(2000)
      expect(text).toMatch(expectRe)
    }
    stt.stop()
  }, 600_000)
})

describe('빠른 대화 경로 (실제 Claude)', () => {
  it('간단한 질문은 빠르게, 도구가 필요하면 에이전트로 넘김', async () => {
    const fc = new FastChat({ env: () => ({}), name: () => '자비스', memory: () => '', model: () => 'sonnet', cwd: () => tmpdir() })
    fc.warm()
    await new Promise((r) => setTimeout(r, 2500)) // 앱에서는 시작할 때 미리 띄워 둔다
    let first = 0
    const t0 = Date.now()
    const ans = await fc.ask('일 더하기 일은 얼마야? 숫자만.', () => {
      if (!first) first = Date.now() - t0
    })
    console.log(`  첫 글자 ${first}ms, 완료 ${Date.now() - t0}ms: ${ans}`)
    expect(ans).toMatch(/2|이/)
    expect(first).toBeLessThan(2500)
    const handoff = await fc.ask('내 다운로드 폴더에 있는 파일 목록 정리해줘', () => undefined)
    console.log(`  도구 필요 요청 → ${handoff === null ? '에이전트로 넘김' : handoff}`)
    expect(handoff).toBeNull()
    fc.close()
  }, 180_000)
})
