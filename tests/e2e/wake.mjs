// E2E: "헤이 자비스" / "헤이 ○○" 로 부르면 숨어 있던 창이 뜨고 명령을 처리하는지 (설치된 앱으로도 실행 가능)
// 사용: node tests/e2e/wake.mjs [/path/to/JARVIS.app]
import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const appPath = process.argv[2]
const target = appPath ? { executablePath: join(appPath, 'Contents/MacOS/JARVIS'), args: ['--hidden'] } : { executablePath: require('electron'), args: [root, '--hidden'] }
console.log('대상:', appPath ?? '개발 빌드')

let failures = 0
const assert = (c, m) => {
  if (!c) throw new Error(m)
}
const step = async (name, fn) => {
  const t0 = Date.now()
  try {
    await fn()
    console.log(`✓ ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
  } catch (e) {
    failures++
    console.log(`✗ ${name}: ${e.message}`)
  }
}

function voiceWav(sentence) {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-wake-audio-'))
  execFileSync('say', ['-v', 'Yuna', '-o', join(dir, 'v.aiff'), sentence])
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', join(dir, 'v.aiff'), join(dir, 'v.wav')])
  const src = readFileSync(join(dir, 'v.wav'))
  const pcm = src.subarray(src.indexOf('data') + 8)
  const sil = Buffer.alloc(16000 * 2 * 2)
  const body = Buffer.concat([sil, pcm, sil, sil, sil, sil, sil])
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + body.length, 4); h.write('WAVE', 8); h.write('fmt ', 12)
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24)
  h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(body.length, 40)
  const out = join(dir, 'voice.wav')
  writeFileSync(out, Buffer.concat([h, body]))
  return out
}

// Whisper 모델 캐시를 공유해 두 번째 실행은 빠르게
const userData = mkdtempSync(join(tmpdir(), 'jarvis-wake-ud-'))
// 테스트 전용 실행 옵션: 앱 코드에는 테스트 장치가 없고, Electron/Chromium 표준 옵션으로만 격리한다
const isolate = (userData, wav) => [
  `--user-data-dir=${userData}`,
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  ...(wav ? [`--use-file-for-fake-audio-capture=${wav}`, '--disable-features=AudioServiceOutOfProcess,AudioServiceSandbox'] : [])
]
const env0 = { ...process.env }
delete env0.ELECTRON_RUN_AS_NODE

async function scenario(sentence, settingsPatch, expect) {
  writeFileSync(join(userData, 'settings.json'), JSON.stringify(settingsPatch))
  const app = await electron.launch({ ...target, args: [...target.args, ...isolate(userData, voiceWav(sentence))], env: env0 })
  try {
    const page = await app.firstWindow()
    await page.waitForSelector('.app', { timeout: 60000 })
    const visible = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false)
    assert((await visible()) === false, '숨김 상태로 시작하지 않음')
    // 마이크 버튼을 누르지 않아도 자동으로 듣기 시작해야 한다
    await page.waitForFunction(() => document.querySelector('[data-testid=mic-toggle]')?.classList.contains('orb-on'), null, { timeout: 30000 })
    // 호출 → 창이 뜨고 → 명령 처리
    const t0 = Date.now()
    let shown = false
    while (Date.now() - t0 < 480000) {
      if (await visible()) {
        shown = true
        break
      }
      await page.waitForTimeout(500)
    }
    assert(shown, '호출했는데 창이 뜨지 않음')
    await page.waitForFunction(() => {
      const j = document.querySelectorAll('[data-testid=jarvis-job]')
      return j.length && j[j.length - 1].getAttribute('data-status') === 'done'
    }, null, { timeout: 240000 })
    const t = await page.$$eval('[data-testid=jarvis-job]', (e) => e[e.length - 1].innerText.replace(/\n+/g, ' / '))
    console.log('   ', t.slice(0, 140))
    assert(expect.test(t), `답이 예상과 다름: ${t}`)
    return { app, page, visible }
  } catch (e) {
    await app.close()
    throw e
  }
}

await step('"헤이 자비스, 일 더하기 일은?" → 숨어 있던 창이 뜨고 답함 (마이크 버튼 안 누름)', async () => {
  const { app, page, visible } = await scenario('헤이 자비스, 일 더하기 일은 얼마야? 숫자만 말해.', {}, /(^|\D)2(\D|$)|이입니다/)
  // 창을 닫아도 종료되지 않고 뒤에서 대기 → 부르면 다시 뜸
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  await page.waitForTimeout(800)
  assert((await visible()) === false, '닫은 뒤에도 보임')
  const alive = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
  assert(alive === 1, '창을 닫았더니 앱이 종료됨')
  const tray = await app.evaluate(() => process.platform)
  await page.evaluate(() => window.jarvis.win.summon())
  await page.waitForTimeout(500)
  assert((await visible()) === true, '다시 부르기 실패')
  console.log(`   창 닫기 → 계속 실행 → 다시 호출 OK (${tray})`)
  await app.close()
})

await step('이름을 "프라이데이"로 → "헤이 프라이데이, 이 더하기 삼은?" 으로 호출', async () => {
  const { app } = await scenario('헤이 프라이데이, 이 더하기 삼은 얼마야? 숫자만 말해.', { assistantName: '프라이데이' }, /(^|\D)5(\D|$)|오입니다/)
  await app.close()
})

console.log(failures ? `\n${failures} 단계 실패` : '\n호출어 E2E 통과')
process.exit(failures ? 1 : 0)
