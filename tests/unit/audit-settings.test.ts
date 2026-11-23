import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuditLog } from '../../src/main/audit'
import { SettingsStore, DEFAULT_SETTINGS } from '../../src/main/settings'
import { SecretStore, maskKey } from '../../src/main/secrets'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'jarvis-test-'))

describe('AuditLog (append-only 이력)', () => {
  it('기록 → 최신순 조회, 필수 항목(누가/언제/무엇/어디서) 포함', () => {
    const file = join(tmp(), 'a', 'audit.jsonl')
    const log = new AuditLog(file, '1.2.3')
    log.record({ action: 'auth.login', provider: 'claude', detail: { success: true } })
    log.record({ action: 'git.commit', provider: 'jarvis', project: '/p', target: 'abc123', detail: { message: 'feat: x' } })
    log.record({ action: 'approval.denied', provider: 'claude', target: 'git-push' })

    const all = log.list()
    expect(all.map((e) => e.action)).toEqual(['approval.denied', 'git.commit', 'auth.login'])
    const c = all[1]
    expect(c.actor).toMatch(/^user:/)
    expect(new Date(c.ts).toString()).not.toBe('Invalid Date')
    expect(c.project).toBe('/p')
    expect(c.target).toBe('abc123')
    expect(c.source.platform).toBe(process.platform)
    expect(c.source.app).toBe('jarvis@1.2.3')
    expect(c.source.host).toBeTruthy()
    expect(c.id).toMatch(/[0-9a-f-]{36}/)

    // 필터
    expect(log.list({ action: 'git' }).length).toBe(1)
    expect(log.list({ project: '/p' }).length).toBe(1)
    expect(log.list({ limit: 2 }).length).toBe(2)

    // 파일은 JSONL 로 누적
    expect(readFileSync(file, 'utf8').trim().split('\n').length).toBe(3)
  })

  it('손상된 줄은 건너뛴다', async () => {
    const file = join(tmp(), 'audit.jsonl')
    const log = new AuditLog(file)
    log.record({ action: 'project.open' })
    const { appendFileSync } = await import('node:fs')
    appendFileSync(file, '{broken\n')
    log.record({ action: 'project.open' })
    expect(log.list().length).toBe(2)
  })
})

describe('SettingsStore', () => {
  it('기본값 + 깊은 병합 + 영속화', () => {
    const file = join(tmp(), 'settings.json')
    const s = new SettingsStore(file)
    expect(s.get()).toEqual(DEFAULT_SETTINGS)
    s.update({ provider: 'gemini', voice: { ttsRate: 1.3 } })
    const s2 = new SettingsStore(file)
    expect(s2.get().provider).toBe('gemini')
    expect(s2.get().voice.ttsRate).toBe(1.3)
    expect(s2.get().voice.wakeWords).toEqual(DEFAULT_SETTINGS.voice.wakeWords)
    expect(s2.model('claude')).toBeUndefined()
    s2.update({ models: { claude: 'opus' } })
    expect(s2.model('claude')).toBe('opus')
    expect(s2.get().models.gpt).toBe('')
  })
})

describe('SecretStore', () => {
  const cipher = {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s.split('').reverse().join('')),
    decryptString: (b: Buffer) => b.toString().split('').reverse().join('')
  }
  it('암호화 저장 / 복호화 / 삭제, 평문 미저장, 파일 권한 600', () => {
    const file = join(tmp(), 'secrets.json')
    const st = new SecretStore(file, cipher)
    st.set('claude', 'sk-ant-SECRET-1234')
    expect(readFileSync(file, 'utf8')).not.toContain('sk-ant-SECRET-1234')
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(new SecretStore(file, cipher).get('claude')).toBe('sk-ant-SECRET-1234')
    st.clear('claude')
    expect(new SecretStore(file, cipher).has('claude')).toBe(false)
  })
  it('암호화 불가 환경이면 저장 거부', () => {
    const st = new SecretStore(join(tmp(), 's.json'), { ...cipher, isEncryptionAvailable: () => false })
    expect(() => st.set('gpt', 'k')).toThrow()
  })
  it('maskKey', () => {
    expect(maskKey('sk-ant-abcdefgh1234')).toBe('sk-a…1234')
  })
})
