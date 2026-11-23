import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseOpenIntent, resolveProject, scanProjects, scoreProject } from '../../src/main/projects'

describe('parseOpenIntent', () => {
  it.each([
    ['xcroll-be 프로젝트 열어줘', 'xcroll-be', ''],
    ['xcroll-be 열어', 'xcroll-be', ''],
    ['moneytree 백엔드 열고 README 요약해줘', 'moneytree 백엔드', 'README 요약해줘'],
    ['Jarvis 폴더 열어줘.', 'Jarvis', ''],
    ['xcroll-app 으로 전환해줘', 'xcroll-app', ''],
    ['~/Private/Jarvis 열고 나서 테스트 돌려줘', '~/Private/Jarvis', '테스트 돌려줘'],
    ['지금 xcroll-admin 레포 열어줘', 'xcroll-admin', ''],
    ['open xcroll-web and run the tests', 'xcroll-web', 'run the tests'],
    ['open the project jarvis', 'jarvis', '']
  ])('%s', (input, query, rest) => {
    expect(parseOpenIntent(input)).toEqual({ query, rest })
  })

  it.each(['안녕 자비스', 'src/App.tsx 파일 열어줘', 'README.md 열어줘', '이 프로젝트 구조 설명해줘', '열어줘'])('의도 아님: %s', (input) => {
    expect(parseOpenIntent(input)).toBeNull()
  })
})

describe('scoreProject / resolveProject', () => {
  const known = ['/h/Private/Jarvis', '/h/work/xcroll/xcroll-be', '/h/work/xcroll/xcroll-app', '/h/work/xcroll/xcroll-admin', '/h/work/xcroll/moneytree-backend', '/h/work/xcroll/moneytree-frontend']

  it('정확 일치 = 1', () => {
    expect(scoreProject('xcroll be', '/x/xcroll-be')).toBe(1)
    expect(scoreProject('Jarvis', '/h/Private/Jarvis')).toBe(1)
  })

  it('정확 일치는 바로 확정', () => {
    expect(resolveProject('xcroll-be', known).path).toBe('/h/work/xcroll/xcroll-be')
    expect(resolveProject('jarvis', known).path).toBe('/h/Private/Jarvis')
  })

  it('한국어 별칭: "moneytree 백엔드" → moneytree-backend', () => {
    expect(resolveProject('moneytree 백엔드', known).path).toBe('/h/work/xcroll/moneytree-backend')
    expect(resolveProject('머니트리 프론트', known).path).toBeUndefined() // 한글 음차는 AI 선택으로 넘어감
  })

  it('애매하면 확정하지 않고 후보만 준다', () => {
    const r = resolveProject('xcroll', known)
    expect(r.path).toBeUndefined()
    expect(r.candidates.length).toBeGreaterThan(1)
  })

  it('moneytree 만 말하면 후보 2개', () => {
    const r = resolveProject('moneytree', known)
    expect(r.path).toBeUndefined()
    expect(r.candidates.map((c) => c.path)).toEqual(expect.arrayContaining(['/h/work/xcroll/moneytree-backend', '/h/work/xcroll/moneytree-frontend']))
  })

  it('절대 경로 / ~ 경로', () => {
    const d = mkdtempSync(join(tmpdir(), 'jp-'))
    expect(resolveProject(d, []).path).toBe(d)
    expect(resolveProject('/nope/zzz', []).path).toBeUndefined()
  })
})

describe('scanProjects', () => {
  it('.git / package.json 폴더 수집, node_modules 제외, 모노레포 하위 포함', () => {
    const root = mkdtempSync(join(tmpdir(), 'jscan-'))
    const mk = (p: string, marker: string): void => {
      mkdirSync(join(root, p), { recursive: true })
      if (marker === '.git') mkdirSync(join(root, p, '.git'))
      else writeFileSync(join(root, p, marker), '{}')
    }
    mk('a', '.git')
    mk('a/apps/web', 'package.json')
    mk('b/c', 'pyproject.toml')
    mk('node_modules/x', 'package.json')
    mk('plain/dir', 'README')
    const found = scanProjects([root], { depth: 3 }).map((p) => p.slice(root.length + 1)).sort()
    expect(found).toEqual(['a', 'a/apps/web', 'b/c'])
  })
})

describe('긴 경로 여러 개 열기', () => {
  it('절대 경로 두 개 (80자 초과)', () => {
    const a = '/var/folders/xy/2sg7s2t557d1nzd1qsnd70400000gn/T/jarvis-e2e-alpha-mSjiL2'
    const b = '/var/folders/xy/2sg7s2t557d1nzd1qsnd70400000gn/T/jarvis-e2e-beta-P1J3r9'
    expect(parseOpenIntent(`${a}랑 ${b} 열어줘`)).toEqual({ query: `${a}랑 ${b}`, rest: '' })
  })
})
