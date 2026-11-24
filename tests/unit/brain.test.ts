// 기억 전부 → 잠근 한 파일 → git 폴더 → 다른 기기에서 암호로 되살리기
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectBrain, mergeBrain, type BrainBundle } from '../../src/main/brain'
import { openBackup, VoiceVault } from '../../src/main/voicevault'
import { parseVoiceLearnIntent } from '../../src/main/intents'

const PASS = '내-기억-암호-777'
function device(): string {
  const d = mkdtempSync(join(tmpdir(), 'jv-dev-'))
  mkdirSync(join(d, 'memory'), { recursive: true })
  mkdirSync(join(d, 'audit'), { recursive: true })
  return d
}
function walk(d: string): string[] {
  return readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]))
}

describe('기억 전부 백업 → 다른 기기에서 복원', () => {
  it('누구나 파일은 열 수 있지만 내용은 암호 없이는 못 본다, 암호로 되살리면 합쳐진다', () => {
    // 기기 A: 배운 것들
    const A = device()
    writeFileSync(join(A, 'memory/memory.json'), JSON.stringify([{ id: '1', text: '커밋 메시지는 한국어로 쓴다', category: 'preference', source: 'user', createdAt: '2026-11-20T00:00:00Z' }]))
    writeFileSync(join(A, 'memory/approval-lexicon.json'), JSON.stringify([{ phrase: '그래그렇게해', example: '그래 그렇게 해', decision: 'approve', source: 'ai', count: 3, updatedAt: 'x' }]))
    writeFileSync(join(A, 'memory/conversations.jsonl'), JSON.stringify({ ts: '2026-11-20T01:00:00Z', prompt: '엑스크롤 테스트 돌려줘' }) + '\n')
    writeFileSync(join(A, 'settings.json'), JSON.stringify({ assistantName: '프라이데이', voice: { ttsRate: 1.3, inputDeviceId: 'A-마이크' }, projectDir: '/Users/a/xcroll' }))
    writeFileSync(join(A, 'audit/audit.jsonl'), JSON.stringify({ action: 'git.commit' }) + '\n')
    const va = new VoiceVault(join(A, '.voice'), () => 1e9)
    va.setup(PASS)
    va.add({ ts: 1, heard: '에퍼리 다 내려봤다', final: '목소리 더 내려받기', corrected: true, sampleRate: 16000, packets: [new Uint8Array(50)] })
    va.writeBrain(collectBrain(A, { v: 1, words: { 엑스크롤: 5 }, fixes: { 에퍼리다내려봤다: { to: '목소리 더 내려받기', n: 1, at: 1 } } }, '0.1.0'))
    const repo = mkdtempSync(join(tmpdir(), 'jv-repo-'))
    va.exportTo(join(repo, 'jarvis-memory'))

    // git 에 올라가는 파일들: 내용이 보이면 안 됨
    for (const f of walk(join(repo, 'jarvis-memory'))) {
      const b = readFileSync(f)
      for (const secret of ['커밋 메시지', '프라이데이', '엑스크롤', '그래그렇게해', '에퍼리', PASS]) expect(b.includes(Buffer.from(secret))).toBe(false)
    }
    expect(walk(join(repo, 'jarvis-memory')).map((f) => f.split('/').pop())).toEqual(expect.arrayContaining(['vault.json', 'brain.jvs']))
    expect(openBackup(join(repo, 'jarvis-memory'), '틀린 암호')).toBeNull()

    // 기기 B: 이미 자기 기억이 조금 있음
    const B = device()
    writeFileSync(join(B, 'memory/memory.json'), JSON.stringify([{ id: '9', text: 'B 에서 배운 것', category: 'fact', source: 'x', createdAt: 'x' }]))
    writeFileSync(join(B, 'settings.json'), JSON.stringify({ assistantName: '자비스', voice: { ttsRate: 1, inputDeviceId: 'B-마이크' }, projectDir: '/Users/b/work' }))
    const bk = openBackup(join(repo, 'jarvis-memory'), PASS)!
    const bundle = JSON.parse(bk.read('brain.jvs')!.toString()) as BrainBundle
    const { result, lexicon } = mergeBrain(B, bundle, { v: 1, words: { 머니트리: 2 }, fixes: {} })
    expect(result.memory).toBe(1)
    expect(result.approvals).toBe(1)
    expect(result.conversations).toBe(1)
    const mem = JSON.parse(readFileSync(join(B, 'memory/memory.json'), 'utf8')).map((x: { text: string }) => x.text)
    expect(mem).toEqual(['B 에서 배운 것', '커밋 메시지는 한국어로 쓴다'])
    const st = JSON.parse(readFileSync(join(B, 'settings.json'), 'utf8'))
    expect(st.assistantName).toBe('프라이데이')
    expect(st.voice.ttsRate).toBe(1.3)
    expect(st.voice.inputDeviceId).toBe('B-마이크') // 기기마다 다른 값은 그대로
    expect(st.projectDir).toBe('/Users/b/work')
    expect(lexicon.words).toEqual({ 머니트리: 2, 엑스크롤: 5 })
    expect(lexicon.fixes['에퍼리다내려봤다'].to).toBe('목소리 더 내려받기')
    expect(readdirSync(join(B, 'audit')).some((f) => f.startsWith('imported-'))).toBe(true)

    // 말소리 보관함도 B 로
    const vb = new VoiceVault(join(B, '.voice'), () => 1e9)
    expect(vb.adoptFrom(join(repo, 'jarvis-memory'))).toEqual({ samples: 1, adopted: true, conflict: false })
    expect(vb.readAll(PASS)[0].final).toBe('목소리 더 내려받기')
    // 두 번 복원해도 중복 없음
    expect(mergeBrain(B, bundle, lexicon).result.memory).toBe(0)
    expect(vb.adoptFrom(join(repo, 'jarvis-memory')).samples).toBe(0)
  })
})

describe('기억 백업/복원 명령', () => {
  it.each([
    ['기억 백업해줘', 'backup'],
    ['기억 전부 깃에 백업해줘', 'backup'],
    ['기억 복원해줘', 'restore'],
    ['백업 복원해줘', 'restore'],
    ['자비스 데이터 가져와', 'restore']
  ])('%s → %s', (t, a) => expect(parseVoiceLearnIntent(t)).toBe(a))
  it('관계없는 말', () => {
    expect(parseVoiceLearnIntent('그 파일 복원해줘')).toBeNull()
    expect(parseVoiceLearnIntent('기억해 나는 커피를 좋아해')).toBeNull()
  })
})
