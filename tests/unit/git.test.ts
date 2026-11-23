import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git, GitService, parseStatusV2 } from '../../src/main/git'

async function repo(): Promise<string> {
  const d = mkdtempSync(join(tmpdir(), 'jarvis-git-'))
  await git(d, ['init', '-q', '-b', 'main'])
  await git(d, ['config', 'user.email', 'test@example.com'])
  await git(d, ['config', 'user.name', 'Test'])
  await git(d, ['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(d, 'a.txt'), 'hello\n')
  await git(d, ['add', '.'])
  await git(d, ['commit', '-qm', 'init'])
  return d
}

describe('GitService — commit / push 는 승인 필수', () => {
  let dir: string
  let asked: string[]
  let answer: boolean
  let svc: GitService
  beforeEach(async () => {
    dir = await repo()
    asked = []
    answer = false
    svc = new GitService(async (req) => {
      asked.push(req.kind)
      return answer
    })
  })

  it('status: 수정/신규 파일, 브랜치', async () => {
    writeFileSync(join(dir, 'a.txt'), 'changed\n')
    writeFileSync(join(dir, 'new file.txt'), 'x\n')
    const st = await svc.status(dir)
    expect(st.isRepo).toBe(true)
    expect(st.branch).toBe('main')
    expect(st.files).toEqual(
      expect.arrayContaining([
        { path: 'a.txt', index: '.', worktree: 'M' },
        { path: 'new file.txt', index: '?', worktree: '?' }
      ])
    )
  })

  it('저장소가 아니면 isRepo=false', async () => {
    const st = await svc.status(mkdtempSync(join(tmpdir(), 'nogit-')))
    expect(st.isRepo).toBe(false)
  })

  it('거부하면 커밋되지 않는다', async () => {
    writeFileSync(join(dir, 'a.txt'), 'v2\n')
    await svc.stage(dir, ['a.txt'])
    const before = (await svc.log(dir)).length
    const r = await svc.commit(dir, 'feat: v2')
    expect(asked).toEqual(['git-commit'])
    expect(r.approved).toBe(false)
    expect((await svc.log(dir)).length).toBe(before)
  })

  it('승인하면 커밋된다 (메시지 그대로, 해시 반환)', async () => {
    answer = true
    writeFileSync(join(dir, 'a.txt'), 'v3\n')
    await svc.stage(dir, ['a.txt'])
    const r = await svc.commit(dir, 'feat: 한글 메시지\n\n- 본문')
    expect(r.approved).toBe(true)
    expect(r.code).toBe(0)
    const log = await svc.log(dir, 1)
    expect(log[0].subject).toBe('feat: 한글 메시지')
    expect(r.hash).toBe(log[0].hash)
  })

  it('스테이징이 없으면 승인 요청 자체를 하지 않는다', async () => {
    const r = await svc.commit(dir, 'x')
    expect(asked).toEqual([])
    expect(r.code).toBe(1)
  })

  it('push 거부 시 실행 안 함', async () => {
    const r = await svc.push(dir)
    expect(asked).toEqual(['git-push'])
    expect(r.approved).toBe(false)
  })

  it('push 승인 시 원격으로 전송', async () => {
    answer = true
    const remote = mkdtempSync(join(tmpdir(), 'jarvis-remote-'))
    await git(remote, ['init', '-q', '--bare'])
    await git(dir, ['remote', 'add', 'origin', remote])
    const r = await svc.push(dir)
    expect(r.approved).toBe(true)
    expect(r.code).toBe(0)
    const remoteLog = await git(remote, ['log', '--oneline', 'main'])
    expect(remoteLog.stdout).toContain('init')
  })

  it('diff / unstage', async () => {
    writeFileSync(join(dir, 'a.txt'), 'diffme\n')
    expect(await svc.diff(dir, { path: 'a.txt' })).toContain('+diffme')
    await svc.stage(dir, ['a.txt'])
    expect(await svc.diff(dir, { staged: true })).toContain('+diffme')
    await svc.unstage(dir, ['a.txt'])
    expect(await svc.diff(dir, { staged: true })).toBe('')
  })
})

describe('parseStatusV2', () => {
  it('ahead/behind, upstream', () => {
    const out = ['# branch.oid abc', '# branch.head feat', '# branch.upstream origin/feat', '# branch.ab +2 -1', '1 M. N... 100644 100644 100644 a b src/x.ts', ''].join('\0')
    const st = parseStatusV2(out)
    expect(st).toMatchObject({ branch: 'feat', upstream: 'origin/feat', ahead: 2, behind: 1 })
    expect(st.files).toEqual([{ path: 'src/x.ts', index: 'M', worktree: '.' }])
  })
})
