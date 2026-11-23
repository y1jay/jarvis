import { describe, expect, it } from 'vitest'
import { Asker, normalizeCode, resolveChoice, type Question } from '../../src/main/asker'
import { parseVoiceIntent } from '../../src/main/intents'
import { parseDeviceIntent } from '../../src/main/devices'
import { parseSimctlList, runtimeLabel } from '../../src/main/simulator'
import { parseOpenIntent } from '../../src/main/projects'
import { parseReleaseIntent, androidReleasePlaybook } from '../../src/main/release'
import { resolveMessenger } from '../../src/main/computer'
import { escapeInputText } from '../../src/main/emulator'
import { FINAL_ACTION } from '../../src/main/jarvisTools'

describe('되묻기 (Asker)', () => {
  it('질문 → 답 → 이력(비밀값은 마스킹)', async () => {
    const shown: Question[] = []
    const audits: Array<[Question, string | null]> = []
    const a = new Asker({ show: (q) => (shown.push(q), true), hide: () => undefined, audit: (q, v) => audits.push([q, v]) })
    const p = a.ask('트랙?', { options: ['내부 테스트', '프로덕션'] })
    expect(shown[0].kind).toBe('choice')
    expect(a.list().length).toBe(1)
    a.answer(shown[0].id, '프로덕션')
    expect(await p).toBe('프로덕션')
    expect(a.list().length).toBe(0)
    const s = a.ask('비밀번호', { kind: 'secret' })
    a.answer(shown[1].id, 'pw')
    expect(await s).toBe('pw')
    expect(audits.map(([q]) => q.kind)).toEqual(['choice', 'secret'])
  })
  it('창이 없으면 즉시 null, 시간 초과 null', async () => {
    const a = new Asker({ show: () => false, hide: () => undefined, audit: () => undefined })
    expect(await a.ask('x')).toBeNull()
    const b = new Asker({ show: () => true, hide: () => undefined, audit: () => undefined })
    expect(await b.ask('x', { timeoutMs: 30 })).toBeNull()
  })
  it.each([
    ['2번', '비공개 테스트'],
    ['두 번째', '비공개 테스트'],
    ['프로덕션으로 해줘', '프로덕션'],
    ['비공개', '비공개 테스트'],
    ['3', '프로덕션'],
    ['내부 테스트', '내부 테스트']
  ])('선택지 해석: %s → %s', (ans, exp) => {
    expect(resolveChoice(ans, ['내부 테스트', '비공개 테스트', '프로덕션'])).toBe(exp)
  })
  it('애매하면 null', () => {
    expect(resolveChoice('테스트', ['내부 테스트', '비공개 테스트', '프로덕션'])).toBeNull()
    expect(resolveChoice('9번', ['a', 'b'])).toBeNull()
  })
  it.each([
    ['123456', '123456'],
    ['일 이 삼 사 오 육', '123456'],
    ['인증번호는 공구팔칠이요', '09872'],
    ['482 913 입니다', '482913']
  ])('인증번호 정규화: %s', (a, e) => {
    expect(normalizeCode(a)).toBe(e)
  })
})

describe('목소리 / 에뮬레이터 명령', () => {
  it.each([
    ['목소리 바꿔줘', 'choose'],
    ['다른 목소리로 해줘', 'choose'],
    ['말 좀 빠르게 해', 'faster'],
    ['말하는 속도 천천히', 'slower'],
    ['목소리 더 낮게', 'lower'],
    ['목소리 원래대로', 'reset'],
    ['목소리 더 많은 거 다운로드', 'more']
  ])('%s', (t, action) => {
    expect(parseVoiceIntent(t)?.action).toBe(action)
  })
  it('목소리 무관', () => {
    expect(parseVoiceIntent('README 바꿔줘')).toBeNull()
  })
  it.each([
    ['에뮬레이터 띄워줘', 'start', 'android', undefined, ''],
    ['에뮬레이터 Pixel_8 켜줘', 'start', 'android', 'Pixel_8', ''],
    ['에뮬레이터 띄워서 앱 실행해서 확인해', 'start', 'android', undefined, '앱 실행해서 확인해'],
    ['에뮬레이터 꺼줘', 'stop', 'android', undefined, ''],
    ['아이폰 시뮬레이터 띄워줘', 'start', 'ios', undefined, ''],
    ['시뮬레이터 켜서 로그인 화면 확인해', 'start', 'ios', undefined, '로그인 화면 확인해'],
    ['시뮬레이터 꺼', 'stop', 'ios', undefined, ''],
    ['테스트 기기 띄워줘', 'start', null, undefined, '']
  ])('%s', (t, action, platform, name, rest) => {
    expect(parseDeviceIntent(t)).toEqual({ action, platform, name, rest })
  })
})

describe('iOS 시뮬레이터 목록 파싱', () => {
  it('iOS 런타임만, 최신 런타임 우선', () => {
    const json = JSON.stringify({ devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-4': [{ udid: 'a', name: 'iPhone 17', state: 'Booted', isAvailable: true }],
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [{ udid: 'b', name: 'iPhone 17 Pro', state: 'Shutdown', isAvailable: true }, { udid: 'x', name: 'Broken', state: 'Shutdown', isAvailable: false }],
      'com.apple.CoreSimulator.SimRuntime.watchOS-12-0': [{ udid: 'w', name: 'Watch', state: 'Shutdown', isAvailable: true }]
    } })
    const l = parseSimctlList(json)
    expect(l.map((d) => d.udid)).toEqual(['b', 'a'])
    expect(runtimeLabel('com.apple.CoreSimulator.SimRuntime.iOS-26-4')).toBe('iOS 26.4')
  })
})

describe('생성된 지시문 오작동 방지', () => {
  it('영어 open 은 문장 중간에서 열기 명령이 아님', () => {
    expect(parseOpenIntent('1. mcp__jarvis__browser_open 으로 http://x/console 를 연다. 로그인 화면이면 ...')).toBeNull()
    expect(parseOpenIntent('open xcroll-web')).toEqual({ query: 'xcroll-web', rest: '' })
  })
  it('긴 질의는 경로 목록일 때만', () => {
    expect(parseOpenIntent('a'.repeat(90) + ' 열어줘')).toBeNull()
  })
})

describe('안드로이드 출시 명령 (오작동 방지)', () => {
  it.each(['안드로이드 출시해', '안드로이드 출시하자', '플레이스토어에 올려줘', '구글 플레이 배포 진행해', '안드로이드 심사 요청해줘', 'android 배포해줘'])('출시: %s', (t) => {
    expect(parseReleaseIntent(t)).not.toBeNull()
  })
  it.each(['안드로이드 release 빌드 설정 고쳐줘', '안드로이드 출시 방법 알려줘', '안드로이드 출시는 어떻게 해?', '안드로이드 앱 버그 고쳐줘', 'android 배포 스크립트 수정해줘'])('아님: %s', (t) => {
    expect(parseReleaseIntent(t)).toBeNull()
  })
  it('플레이북: 트랙 질문·보안 입력·최종 승인 규칙 포함', () => {
    const p = androidReleasePlaybook('안드로이드 출시해', '/w/app')
    expect(p).toContain('내부 테스트", "비공개 테스트", "프로덕션')
    expect(p).toContain('browser_fill_secret')
    expect(p).toContain('사용자 승인')
    expect(p).toContain('/w/app')
  })
})

describe('기타', () => {
  it('최종 웹 동작 감지', () => {
    for (const t of ['검토를 위해 변경사항 전송', '출시 시작', 'Send for review', 'Start rollout', 'Publish', '제출']) expect(FINAL_ACTION.test(t)).toBe(true)
    for (const t of ['새 버전 만들기', '다음', '저장', '내부 테스트']) expect(FINAL_ACTION.test(t)).toBe(false)
  })
  it('메신저 해석', () => {
    expect(resolveMessenger('카톡')?.key).toBe('kakaotalk')
    expect(resolveMessenger('카카오톡')?.key).toBe('kakaotalk')
    expect(resolveMessenger('Slack')?.key).toBe('slack')
    expect(resolveMessenger('텔레그램')).toBeNull()
  })
  it('adb input text 이스케이프', () => {
    expect(escapeInputText('hello world')).toBe('hello%sworld')
    expect(escapeInputText('a&b')).toBe('a\\&b')
  })
})
