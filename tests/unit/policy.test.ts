import { describe, expect, it } from 'vitest'
import { classifyCommand, splitShellCommands, extractFilePaths } from '../../src/main/policy'

describe('classifyCommand — git commit/push 는 항상 승인 필요', () => {
  it.each([
    'git commit -m "feat: x"',
    'git add . && git commit -m wip',
    'cd repo; git commit --amend --no-edit',
    'git -C /tmp/repo commit -am "x"',
    'GIT_AUTHOR_NAME=a git commit -m x',
    'git -c user.name=x commit -m y',
    'echo hi | git commit -F -',
    'bash -c "true" && /usr/bin/git commit -m x',
    '(cd sub && git commit -m x)'
  ])('commit: %s', (cmd) => {
    expect(classifyCommand(cmd).gate).toBe('git-commit')
  })

  it.each(['git push', 'git push origin main', 'git push --force', 'git add -A && git commit -m x && git push', 'git -C repo push -u origin feat'])('push: %s', (cmd) => {
    // commit 과 push 가 같이 있으면 commit 이 먼저 걸리지만 둘 다 승인 대상
    expect(['git-push', 'git-commit']).toContain(classifyCommand(cmd).gate)
  })

  it('push 단독은 git-push', () => {
    expect(classifyCommand('git push origin main').gate).toBe('git-push')
  })

  it.each(['git status', 'git diff --cached', 'git log --oneline -5', 'git add src/a.ts', 'git checkout -b feat/x', 'ls -la', 'npm test', 'echo "git commit"', "grep -r 'git push' docs"])(
    '승인 불필요: %s',
    (cmd) => {
      expect(classifyCommand(cmd).gate).toBeNull()
    }
  )
})

describe('classifyCommand — 파괴적 명령', () => {
  it.each([
    'rm -rf node_modules',
    'rm -fr build',
    'git reset --hard HEAD~1',
    'git clean -fd',
    'git checkout -- .',
    'git restore .',
    'git branch -D old',
    'find . -name "*.tmp" -delete',
    'docker compose down -v',
    'docker system prune -a',
    'kill -9 1234',
    'mysql -e "DROP TABLE users"',
    'npx prisma migrate reset',
    'git stash drop'
  ])('%s', (cmd) => {
    expect(classifyCommand(cmd).gate).toBe('destructive')
  })

  it('rm 단일 파일은 통과', () => {
    expect(classifyCommand('rm tmp.txt').gate).toBeNull()
  })
})

describe('splitShellCommands', () => {
  it('따옴표 안의 연결자는 분리하지 않는다', () => {
    expect(splitShellCommands('echo "a && b" && ls')).toEqual(['echo "a && b"', 'ls'])
  })
})

describe('extractFilePaths', () => {
  it('file_path / path / notebook_path', () => {
    expect(extractFilePaths({ file_path: '/a.ts' })).toEqual(['/a.ts'])
    expect(extractFilePaths({ path: 'b.ts', content: 'x' })).toEqual(['b.ts'])
    expect(extractFilePaths(null)).toEqual([])
  })
})
