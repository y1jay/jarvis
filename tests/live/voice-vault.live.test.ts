// 실제 동작 확인 (창 없음): 말소리 → Opus 압축(앱과 같은 방식) → 내 암호로 잠금 → 암호로 열기 도구 → .ogg → 다시 인식
import { describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { VoiceVault } from '../../src/main/voicevault'
import { collectBrain } from '../../src/main/brain'
import { writeFileSync } from 'node:fs'
import { NativeStt, MODELS } from '../../src/main/stt'

const root = join(__dirname, '../..')
const electron = join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const binary = join(root, 'resources/bin', `${process.platform}-${process.arch}`, 'whisper-server')
const MODEL = MODELS['large-v3-turbo'].file
const modelSrc = [join(homedir(), 'Library/Application Support/JARVIS/models', MODEL), join(root, '.cache/models', MODEL)].find((p) => existsSync(p))

describe.skipIf(process.platform !== 'darwin' || !existsSync(electron) || !modelSrc)('음성 학습 보관함 전체 흐름', () => {
  it('저장된 말소리를 암호로만 다시 들을 수 있다', async () => {
    const d = mkdtempSync(join(tmpdir(), 'jv-vv-'))
    execFileSync('say', ['-v', 'Yuna', '-o', join(d, 'a.aiff'), '목소리 더 내려받아 줘'])
    execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', join(d, 'a.aiff'), join(d, 'a.wav')])
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    execFileSync(electron, [join(__dirname, 'helpers/opus-encode.cjs'), join(d, 'a.wav'), join(d, 'p.json')], { env, timeout: 40000 })
    const packets = (JSON.parse(readFileSync(join(d, 'p.json'), 'utf8')) as string[]).map((b) => new Uint8Array(Buffer.from(b, 'base64')))
    const bytes = packets.reduce((a, p) => a + p.length, 0)
    const secs = statSync(join(d, 'a.wav')).size / 32000
    console.log(`  Opus ${packets.length}패킷, ${bytes}B (${secs.toFixed(1)}초, 원본 ${statSync(join(d, 'a.wav')).size}B)`)
    expect(bytes / secs).toBeLessThan(3000) // 1초에 3KB 미만

    const vdir = join(d, '.voice')
    const v = new VoiceVault(vdir, () => 1e9)
    v.setup('테스트-암호-123')
    v.add({ ts: Date.now(), heard: '에퍼리 다 내려봤다', final: '목소리 더 내려받기', corrected: true, sampleRate: 16000, packets, device: 'IB-P1 (Bluetooth)' })

    const cli = (pass: string, extra: string[] = []) => spawnSync('node', [join(root, 'scripts/voice-vault.mjs'), vdir, ...extra], { input: `${pass}\n`, encoding: 'utf8' })
    const bad = cli('틀린암호')
    expect(bad.status).toBe(2)
    expect(bad.stderr).toMatch(/암호가 맞지 않/)
    const ok = cli('테스트-암호-123', ['--ogg', join(d, 'ogg')])
    console.log(ok.stdout.trim())
    expect(ok.status).toBe(0)
    expect(ok.stdout).toMatch(/에퍼리 다 내려봤다.*바로잡음: "목소리 더 내려받기"/)

    // .ogg 를 다시 소리로 → 실제 인식 엔진으로 확인
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', join(d, 'ogg', '0001.ogg'), '-ar', '16000', '-ac', '1', join(d, 'back.wav')])
    const b = readFileSync(join(d, 'back.wav'))
    const di = b.indexOf('data') + 8
    const pcm = new Float32Array((b.length - di) >> 1).map((_, i) => b.readInt16LE(di + i * 2) / 32768)
    const md = join(d, 'models')
    mkdirSync(md)
    copyFileSync(modelSrc!, join(md, MODEL))
    const stt = new NativeStt({ binary, modelsDir: md, modelKey: () => 'large-v3-turbo', onState: () => undefined })
    expect(await stt.start()).toBe(true)
    const text = await stt.transcribe(pcm)
    stt.stop()
    console.log(`  풀어낸 소리 다시 인식: ${text}`)
    expect(text).toMatch(/목소리|내려/)
  }, 180_000)

  it('보기 도구로 기억 전부(--brain)를 암호로 확인', () => {
    const ud = mkdtempSync(join(tmpdir(), 'jv-ud-'))
    mkdirSync(join(ud, 'memory'), { recursive: true })
    writeFileSync(join(ud, 'memory/memory.json'), JSON.stringify([{ id: '1', text: '커밋 메시지는 한국어로', category: 'preference', source: 'user', createdAt: 'x' }]))
    writeFileSync(join(ud, 'memory/conversations.jsonl'), JSON.stringify({ ts: '2026-11-24T05:00:00Z', prompt: '목소리 바꿔줘', answer: '목소리를 바꿨습니다' }) + '\n')
    const v = new VoiceVault(join(ud, '.voice'), () => 1e9)
    v.setup('보기-암호-123')
    v.writeBrain(collectBrain(ud, { v: 1, words: { 엑스크롤: 4 }, fixes: {} }, '0.1.0'))
    const r = spawnSync('node', [join(root, 'scripts/voice-vault.mjs'), join(ud, '.voice'), '--brain'], { input: '보기-암호-123\n', encoding: 'utf8' })
    console.log(r.stdout)
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/커밋 메시지는 한국어로/)
    expect(r.stdout).toMatch(/목소리 바꿔줘/)
    expect(r.stdout).toMatch(/엑스크롤\(4\)/)
    expect(spawnSync('node', [join(root, 'scripts/voice-vault.mjs'), join(ud, '.voice'), '--brain'], { input: '틀림\n', encoding: 'utf8' }).status).toBe(2)
  })
})
