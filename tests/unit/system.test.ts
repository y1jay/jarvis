import { describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { listApps, parseQuitIntent, resolveApp, resolveFolder, resolveSite, type AppEntry } from '../../src/main/system'
import { parseOpenIntent } from '../../src/main/projects'

const apps: AppEntry[] = ['Google Chrome', 'Safari', 'Slack', '카카오톡', 'Visual Studio Code', 'Cursor', 'Docker', 'Calculator', 'System Settings', 'Terminal', 'Telegram', 'zoom.us'].map((name) => ({ name, path: `/Applications/${name}.app` }))

describe('resolveApp', () => {
  it.each([
    ['크롬', 'Google Chrome'],
    ['구글 크롬', 'Google Chrome'],
    ['카톡', '카카오톡'],
    ['카카오톡', '카카오톡'],
    ['슬랙', 'Slack'],
    ['slack', 'Slack'],
    ['코드', 'Visual Studio Code'],
    ['vs 코드', 'Visual Studio Code'],
    ['브이에스코드', 'Visual Studio Code'],
    ['계산기', 'Calculator'],
    ['설정', 'System Settings'],
    ['터미널 앱', 'Terminal'],
    ['줌', 'zoom.us'],
    ['docker', 'Docker'],
    ['Visual Studio', 'Visual Studio Code']
  ])('%s → %s', (q, name) => {
    expect(resolveApp(q, apps)?.name).toBe(name)
  })
  it('모르는 앱은 null', () => {
    expect(resolveApp('포토샵', apps)).toBeNull()
    expect(resolveApp('xcroll-be', apps)).toBeNull()
  })
})

describe('resolveSite / resolveFolder', () => {
  it('사이트 별칭 / 도메인 / URL', () => {
    expect(resolveSite('유튜브')).toBe('https://www.youtube.com')
    expect(resolveSite('네이버')).toBe('https://www.naver.com')
    expect(resolveSite('github.com/anthropics')).toBe('https://github.com/anthropics')
    expect(resolveSite('https://x.com')).toBe('https://x.com')
    expect(resolveSite('크롬')).toBeNull()
  })
  it('폴더 별칭', () => {
    expect(resolveFolder('다운로드')).toBe(join(homedir(), 'Downloads'))
    expect(resolveFolder('다운로드 폴더')).toBe(join(homedir(), 'Downloads'))
    expect(resolveFolder('바탕화면')).toBe(join(homedir(), 'Desktop'))
    expect(resolveFolder('크롬')).toBeNull()
  })
})

describe('명령 파싱', () => {
  it.each([
    ['크롬 열어줘', '크롬', ''],
    ['유튜브 켜줘', '유튜브', ''],
    ['다운로드 폴더 열어줘', '다운로드', ''],
    ['슬랙 열고 메시지 확인할 거 있는지 봐줘', '슬랙', '메시지 확인할 거 있는지 봐줘']
  ])('open: %s', (t, q, rest) => {
    expect(parseOpenIntent(t)).toEqual({ query: q, rest })
  })
  it.each([
    ['카톡 종료해줘', '카톡', ''],
    ['크롬 꺼줘', '크롬', ''],
    ['슬랙 닫아', '슬랙', ''],
    ['도커 종료하고 터미널 열어줘', '도커', '터미널 열어줘']
  ])('quit: %s', (t, target, rest) => {
    expect(parseQuitIntent(t)).toEqual({ verb: 'quit', target, rest })
  })
  it('종료 의도 아님', () => {
    expect(parseQuitIntent('이 프로젝트 구조 설명해줘')).toBeNull()
  })
})

describe('listApps (실제 OS)', () => {
  it('설치된 앱을 읽는다', () => {
    const list = listApps()
    expect(list.length).toBeGreaterThan(5)
    if (process.platform === 'darwin') {
      expect(list.some((a) => a.name === 'Safari')).toBe(true)
      expect(resolveApp('계산기', list)?.name).toBe('Calculator')
    }
  })
})
