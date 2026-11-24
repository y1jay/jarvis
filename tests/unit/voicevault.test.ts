// 음성 학습 보관함: 내 암호로만 열림, 용량 제한, git 백업 시에도 잠긴 채, 말투 학습
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SpeechLexicon, VoiceVault, open, seal, deriveKeys, packSample, unpackSample } from '../../src/main/voicevault'
import { parseVoiceLearnIntent } from '../../src/main/intents'

const PASS = '내목소리-비밀-2026'
const sample = (heard: string, ts = Date.now(), corrected = false) => ({ ts, heard, corrected, sampleRate: 16000, packets: [new Uint8Array([1, 2, 3]), new Uint8Array(200).fill(7)] })
function walk(d: string): string[] {
  return readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]))
}

describe('잠그기/열기', () => {
  it('공개키로 잠근 건 암호로만 열린다', () => {
    const salt = Buffer.alloc(16, 1)
    const { priv, pub } = deriveKeys(PASS, salt)
    const blob = seal(Buffer.from('목소리 더 내려받기'), pub)
    expect(blob.includes(Buffer.from('목소리'))).toBe(false)
    expect(open(blob, priv, pub).toString()).toBe('목소리 더 내려받기')
    const wrong = deriveKeys('다른암호입니다', salt)
    expect(() => open(blob, wrong.priv, pub)).toThrow()
  })
  it('샘플 직렬화', () => {
    const s = sample('안녕')
    const back = unpackSample(packSample(s))
    expect(back.heard).toBe('안녕')
    expect(back.packets.map((p) => p.length)).toEqual([3, 200])
  })
})

describe('VoiceVault', () => {
  it('암호 설정 전엔 저장 안 함, 설정 후 저장 → 암호로만 읽기, 암호는 디스크에 없음', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jv-vault-'))
    const v = new VoiceVault(dir, () => 10 * 1024 * 1024)
    expect(v.add(sample('저장 안 됨'))).toBeNull()
    v.setup(PASS)
    v.add(sample('오늘 일정 알려줘'))
    v.add(sample('에퍼리 다 내려봤다', Date.now() + 1, true))
    expect(v.stats().samples).toBe(2)
    for (const f of walk(dir)) {
      const b = readFileSync(f)
      expect(b.includes(Buffer.from(PASS))).toBe(false)
      expect(b.includes(Buffer.from('오늘 일정'))).toBe(false)
    }
    expect(v.check(PASS)).toBe(true)
    expect(v.check('틀린 암호')).toBe(false)
    expect(v.readAll(PASS).map((s) => s.heard)).toEqual(['오늘 일정 알려줘', '에퍼리 다 내려봤다'])
    expect(() => v.readAll('틀린 암호')).toThrow(/암호/)
    // 다시 열어도 (앱 재시작) 그대로
    expect(new VoiceVault(dir, () => 1e9).readAll(PASS)).toHaveLength(2)
  })
  it('용량을 넘으면 오래된 일반 샘플부터 지우고, 바로잡은 샘플은 남긴다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jv-vault-'))
    let limit = 1e9
    const v = new VoiceVault(dir, () => limit)
    v.setup(PASS)
    v.add(sample('교정된 옛 샘플', 1000, true))
    for (let i = 0; i < 5; i++) v.add(sample(`일반 ${i}`, 2000 + i))
    const one = v.stats().bytes / 6
    limit = one * 3.5
    v.prune()
    const left = v.readAll(PASS).map((s) => s.heard)
    expect(left).toContain('교정된 옛 샘플')
    expect(left).toEqual(['교정된 옛 샘플', '일반 3', '일반 4'])
  })
  it('git 백업: 잠긴 파일 + 공개 정보만, 말투 학습도 잠겨서', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jv-vault-'))
    const out = mkdtempSync(join(tmpdir(), 'jv-repo-'))
    const v = new VoiceVault(dir, () => 1e9)
    v.setup(PASS)
    v.add(sample('커밋하지 말고 기다려'))
    expect(v.exportTo(out, { 'lexicon.jvs': Buffer.from('{"words":{"엑스크롤":3}}') }).copied).toBe(1)
    expect(v.exportTo(out).copied).toBe(0) // 이미 있는 건 다시 안 넣음
    for (const f of walk(out)) {
      const b = readFileSync(f)
      expect(b.includes(Buffer.from('커밋하지'))).toBe(false)
      expect(b.includes(Buffer.from('엑스크롤'))).toBe(false)
    }
    const info = JSON.parse(readFileSync(join(out, 'vault.json'), 'utf8'))
    const { priv, pub } = deriveKeys(PASS, Buffer.from(info.salt, 'base64'))
    expect(open(readFileSync(join(out, 'lexicon.jvs')), priv, pub).toString()).toMatch(/엑스크롤/)
  })
})

describe('말투 학습', () => {
  const crypt = { encrypt: (s: string) => Buffer.from(s).reverse(), decrypt: (b: Buffer) => Buffer.from(b).reverse().toString(), available: () => true }
  it('바로잡은 말을 기억하고, 자주 쓰는 단어를 힌트로', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'jv-lex-')), 'lexicon.bin')
    const l = new SpeechLexicon(f, crypt)
    l.learnFix('에퍼리 다 내려봤다.', '목소리 더 내려받기')
    expect(l.fix('에퍼리 다 내려봤다')).toBe('목소리 더 내려받기')
    for (let i = 0; i < 3; i++) l.learnWords('엑스크롤 프로젝트 테스트 돌려줘')
    l.learnWords('머니트리 열어줘')
    expect(l.topWords()).toEqual(expect.arrayContaining(['엑스크롤', '프로젝트', '테스트']))
    expect(l.topWords()).not.toContain('머니트리') // 한 번만 쓴 건 아직
    const again = new SpeechLexicon(f, crypt)
    expect(again.fix('에퍼리 다 내려봤다')).toBe('목소리 더 내려받기')
    expect(readFileSync(f).includes(Buffer.from('엑스크롤'))).toBe(false)
  })
})

describe('음성 학습 명령', () => {
  it.each([
    ['음성 학습 암호 정해줘', 'setup'],
    ['목소리 학습 시작해', 'train'],
    ['내 목소리로 학습시켜', 'train'],
    ['음성 학습 돌려줘', 'train'],
    ['목소리 학습 되돌려', 'revert'],
    ['음성 학습 켜줘', 'setup'],
    ['음성 학습 상태 알려줘', 'status'],
    ['음성 학습 깃에 백업해줘', 'backup'],
    ['음성 학습 샘플 다 지워', 'clear']
  ])('%s → %s', (t, a) => expect(parseVoiceLearnIntent(t)).toBe(a))
  it('관계없는 말은 아님', () => {
    expect(parseVoiceLearnIntent('목소리 바꿔줘')).toBeNull()
    expect(parseVoiceLearnIntent('머신러닝 학습 코드 짜줘')).toBeNull()
  })
})
