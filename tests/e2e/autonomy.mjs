// E2E (자율 기능): 되묻기 / 목소리 변경 대화 / 내장 브라우저 / 가짜 Play Console 출시 / 에뮬레이터 / 데스크톱 입력·메시지 승인
// 실제 Play Console · 실제 메신저 전송은 하지 않는다.
import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { startMockConsole } from './mock-play-console.mjs'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const art = join(root, 'tests/e2e/artifacts')
mkdirSync(art, { recursive: true })
const only = process.argv.slice(2)
const want = (n) => only.length === 0 || only.includes(n)
let failures = 0
const assert = (c, m) => {
  if (!c) throw new Error(m)
}
const sh = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim()

// 가짜 앱 프로젝트 (Expo 형태 + 미리 만든 AAB)
const appDir = mkdtempSync(join(tmpdir(), 'jarvis-e2e-mockapp-'))
sh(appDir, 'init', '-q', '-b', 'main')
sh(appDir, 'config', 'user.email', 'e2e@example.com')
sh(appDir, 'config', 'user.name', 'E2E')
sh(appDir, 'config', 'commit.gpgsign', 'false')
writeFileSync(join(appDir, 'app.json'), JSON.stringify({ expo: { name: 'Mock App', android: { package: 'com.example.mockapp', versionCode: 12 }, version: '1.0.11' } }, null, 2))
mkdirSync(join(appDir, 'build'))
writeFileSync(join(appDir, 'build', 'app-release.aab'), 'PK-dummy-aab')
sh(appDir, 'add', '.')
sh(appDir, 'commit', '-qm', 'feat: 결제 화면 개선')

const mock = await startMockConsole()
const userData = mkdtempSync(join(tmpdir(), 'jarvis-e2e-auto-ud-'))
const env = { ...process.env, JARVIS_E2E: '1', JARVIS_USER_DATA: userData, JARVIS_PLAY_CONSOLE_URL: mock.url }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ executablePath: require('electron'), args: [root], cwd: root, env })
const page = await app.firstWindow()
await page.waitForSelector('.app', { timeout: 30000 })
const audit = () => readFileSync(join(userData, 'audit', 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))

const denyAll = async () => {
  for (let i = 0; i < 10 && (await page.$('[data-testid=approval-modal]')); i++) {
    await page.click('[data-testid=approval-deny]')
    await page.waitForTimeout(300)
  }
  for (let i = 0; i < 10 && (await page.$('[data-testid=question]')); i++) {
    await page.click('[data-testid=question] >> text=취소')
    await page.waitForTimeout(300)
  }
}
const step = async (name, fn) => {
  const t0 = Date.now()
  try {
    await fn()
    console.log(`✓ ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
  } catch (e) {
    failures++
    console.log(`✗ ${name}: ${e.message}`)
    await page.screenshot({ path: join(art, `fail-${name.slice(0, 20).replace(/\W+/g, '_')}.png`) }).catch(() => undefined)
    await denyAll().catch(() => undefined)
  }
}
const jobCount = () => page.$$eval('[data-testid=jarvis-job]', (e) => e.length)
const lastJob = () => page.$$eval('[data-testid=jarvis-job]', (e) => ({ text: e[e.length - 1].innerText, status: e[e.length - 1].getAttribute('data-status') }))
const submit = async (t) => {
  await page.click('[data-testid=tab-chat]')
  if (await page.$('[data-testid=session-view]')) await page.click('text=← JARVIS')
  const n = await jobCount()
  await page.fill('[data-testid=chat-input]', t)
  await page.click('[data-testid=chat-send]')
  return n
}
const jobDone = async (n) => {
  const j = await page.$$eval('[data-testid=jarvis-job]', (e) => e.map((x) => x.getAttribute('data-status')))
  return j.length > n && ['done', 'error'].includes(j[j.length - 1])
}
/** 질문에 답 (텍스트 입력 또는 보안 입력) */
const answerQuestion = async (v) => {
  await page.fill('[data-testid=question-input]', v)
  await page.click('[data-testid=question-submit]')
  await page.waitForTimeout(300)
}

await step('목소리 바꾸기 대화: "목소리 바꿔줘" → 선택지 질문 → "1번" → 설정 변경', async () => {
  const n = await submit('목소리 바꿔줘')
  await page.waitForSelector('[data-testid=question]', { timeout: 15000 })
  const q = await page.textContent('[data-testid=question]')
  assert(/어떤 목소리/.test(q) && /Yuna/.test(q), q)
  await page.screenshot({ path: join(art, '20-voice-question.png') })
  await answerQuestion('1번')
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid=jarvis-job]').length > n && document.querySelectorAll('[data-testid=jarvis-job]')[n].getAttribute('data-status') === 'done', n)
  const s = await page.evaluate(() => window.jarvis.settings.get())
  assert(s.voice.ttsVoice === 'Yuna', `ttsVoice=${s.voice.ttsVoice}`)
  const before = s.voice.ttsRate
  const n2 = await submit('말 좀 빠르게 해줘')
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid=jarvis-job]')[n]?.getAttribute('data-status') === 'done', n2)
  const s2 = await page.evaluate(() => window.jarvis.settings.get())
  assert(s2.voice.ttsRate > before, `rate ${before}→${s2.voice.ttsRate}`)
})

if (want('claude')) {
  await step('Claude 가 되묻기(ask_user) → 사용자 답으로 진행', async () => {
    const n = await submit('mcp__jarvis__ask_user 도구로 나에게 "좋아하는 색은?" 이라고 물어보고, 내 답을 그대로 한 단어로 답해. 다른 도구는 쓰지 마.')
    await page.waitForSelector('[data-testid=question]', { timeout: 120000 })
    await answerQuestion('청록색')
    for (let i = 0; i < 240 && !(await jobDone(n)); i++) await page.waitForTimeout(500)
    const j = await lastJob()
    assert(j.text.includes('청록색'), j.text)
  })
}

await step('내장 브라우저: "깃허브 로그인해줘" → JARVIS 창 안 브라우저에 로그인 페이지 → 닫으면 미완료', async () => {
  const n = await submit('깃허브 로그인해줘')
  await page.waitForSelector('[data-testid=browser-panel]', { timeout: 15000 })
  let st = null
  for (let i = 0; i < 40; i++) {
    st = await page.evaluate(() => window.jarvis.browser.state())
    if (st.url.includes('github.com/login')) break
    await page.waitForTimeout(500)
  }
  assert(st.url.includes('github.com/login'), JSON.stringify(st))
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
  assert(windows === 1, `별도 창이 생김: ${windows}`)
  await page.waitForTimeout(1500)
  await page.screenshot({ path: join(art, '21-embedded-browser.png') })
  // 팝업이 홀로그램 위에 떠 있는지 (본문 영역 위치)
  const box = await page.$eval('[data-testid=browser-panel]', (e) => { const r = e.getBoundingClientRect(); return { x: r.x, w: r.width, pos: getComputedStyle(e).position } })
  assert(box.pos === 'fixed' && box.w > 300, JSON.stringify(box))
  await page.click('[data-testid=browser-panel-close]')
  for (let i = 0; i < 40 && !(await jobDone(n)); i++) await page.waitForTimeout(500)
  assert(/로그인이 완료되지 않았습니다/.test((await lastJob()).text), (await lastJob()).text)
})

const mousePos = () => execFileSync('osascript', ['-l', 'JavaScript', '-e', 'ObjC.import("AppKit"); const p=$.NSEvent.mouseLocation; Math.round(p.x)+","+Math.round(p.y)'], { encoding: 'utf8' }).trim()
const deviceStep = async (prompt, stopPrompt, platform) => {
  const n = await submit(prompt)
  await page.waitForSelector('[data-testid=device-panel]', { timeout: 20000 })
  // 기기 선택 질문이 오면 첫 번째 선택
  for (let i = 0; i < 20 && !(await page.$('[data-testid=device-screen]')); i++) {
    if (await page.$('[data-testid=question]')) await answerQuestion('1번')
    await page.waitForTimeout(1000)
  }
  await page.waitForSelector('[data-testid=device-screen]', { timeout: 300000 })
  await page.waitForTimeout(2500)
  await page.screenshot({ path: join(art, `22-device-${platform}.png`) })
  const before = mousePos()
  const box = await page.$eval('[data-testid=device-screen]', (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height * 0.45 } })
  const tapRes = await page.evaluate(({ x, y }) => window.jarvis.device.tap(x, y), { x: 300, y: 900 })
  assert(/^tap/.test(tapRes), `탭 실패: ${tapRes}`)
  await page.mouse.click(box.x, box.y) // 팝업 화면 클릭 → 기기 탭
  await page.waitForTimeout(800)
  await page.click('[data-testid=device-home]')
  console.log(`   마우스 ${before} → ${mousePos()} (Playwright 가 창 안에서 누른 것 외에는 실제 커서 이동 없음)`)
  for (let i = 0; i < 60 && !(await jobDone(n)); i++) await page.waitForTimeout(500)
  assert(audit().some((e) => e.action === 'emulator.start' && e.detail?.ok && e.detail?.platform === platform), `${platform} 시작 이력 없음`)
  const n2 = await submit(stopPrompt)
  for (let i = 0; i < 60 && !(await jobDone(n2)); i++) await page.waitForTimeout(500)
  assert(/종료|닫았습니다/.test((await lastJob()).text), (await lastJob()).text)
}

if (want('ios') && process.platform === 'darwin') {
  await step('아이폰 시뮬레이터: 팝업에 화면 → AXe 탭(마우스 안 건드림) → 홈 → 닫기', () => deviceStep('아이폰 시뮬레이터 iPhone 17e 띄워줘', '시뮬레이터 꺼줘', 'ios'))
}
if (want('android')) {
  await step('안드로이드 에뮬레이터: 팝업에 화면 → 탭 → 홈 → 종료', () => deviceStep('에뮬레이터 Pixel_8 띄워줘', '에뮬레이터 꺼줘', 'android'))
}

if (want('claude') && process.platform === 'darwin') {
  await step('메시지 보내기 흐름: 입력 → 화면 캡처와 함께 승인 요청 → 거부 시 전송 안 함 (TextEdit 가짜 메신저)', async () => {
    execFileSync('osascript', ['-e', 'tell application "TextEdit" to make new document', '-e', 'tell application "TextEdit" to activate'])
    const n = await submit('mcp__jarvis__send_message 도구를 app="textedit-test", to="테스트", message="자비스 전송 테스트" 로 한 번만 호출하고 결과만 한 줄로 알려줘.')
    await page.waitForSelector('[data-testid=approval-modal]', { timeout: 180000 })
    const title = await page.textContent('.modal-title')
    assert(/메시지 전송/.test(title), title)
    const detail = await page.textContent('.modal-detail')
    assert((await page.$('[data-testid=approval-image]')) || /화면 기록 권한/.test(detail), '화면 캡처도 권한 안내도 없음')
    if (!(await page.$('[data-testid=approval-image]'))) console.log('   (이 실행 환경은 화면 기록 권한이 없어 캡처 대신 권한 안내 표시)')
    await page.screenshot({ path: join(art, '23-message-approval.png') })
    await page.click('[data-testid=approval-deny]')
    let m = null
    for (let i = 0; i < 120 && !m; i++) {
      m = audit().filter((e) => e.action === 'message.send').pop() ?? null
      if (!m) await page.waitForTimeout(500)
    }
    for (let i = 0; i < 240 && !(await jobDone(n)); i++) await page.waitForTimeout(500)
    assert(m && m.detail.sent === false, `전송 이력: ${JSON.stringify(m)}`)
    execFileSync('osascript', ['-e', 'tell application "TextEdit" to close every document saving no'])
  })

  await step('안드로이드 출시 (가짜 Play Console): 로그인 계정 질문 → 비밀번호 보안 입력 → 트랙 질문 → AAB 업로드 → 노트 확인 → 최종 승인 → 검토 전송', async () => {
    await submit(`${appDir} 열어줘`)
    await page.waitForTimeout(1500)
    const n = await submit('안드로이드 출시해')
    const SECRET = 'S3cret-PW-!92'
    const answered = []
    let approvedFinal = false
    const t0 = Date.now()
    while (Date.now() - t0 < 15 * 60_000) {
      if (await jobDone(n)) break
      const modal = await page.$('[data-testid=approval-modal]')
      if (modal) {
        const t = await page.textContent('.modal-title')
        const d = await page.textContent('.modal-detail')
        await page.waitForTimeout(900)
        if (/최종 웹 동작/.test(t)) {
          await page.screenshot({ path: join(art, '24-release-final-approval.png') })
          approvedFinal = true
          answered.push(`APPROVE:${d.split('\n')[0]}`)
          await page.click('[data-testid=approval-approve]')
        } else if (/push|푸시|위험/.test(t + d)) {
          answered.push(`DENY:${t}`)
          await page.click('[data-testid=approval-deny]')
        } else {
          answered.push(`APPROVE-tool:${t}`)
          await page.click('[data-testid=approval-approve]')
        }
        continue
      }
      const q = await page.$('[data-testid=question]')
      if (q) {
        const kind = await q.getAttribute('data-kind')
        const text = await page.textContent('[data-testid=question] .question-text')
        let a = '응 그대로 진행해'
        if (kind === 'secret') a = SECRET
        else if (kind === 'code') a = '123456'
        else if (/트랙/.test(text)) a = '비공개 테스트'
        else if (/계정/.test(text)) a = 'jarvis.test@example.com'
        else if (/(파일|빌드|aab)/i.test(text)) a = '이미 있는 build/app-release.aab 파일 그대로 써'
        else if (/(버전|version)/i.test(text)) a = '지금 버전 그대로 진행해'
        else if (/(앱|프로젝트)/.test(text)) a = 'Mock App (com.example.mockapp)'
        answered.push(`Q[${kind}] ${text.slice(0, 60)} → ${kind === 'secret' ? '***' : a}`)
        if (/트랙/.test(text)) await page.screenshot({ path: join(art, '25-release-track-question.png') })
        await answerQuestion(a)
        continue
      }
      await page.waitForTimeout(700)
    }
    console.log('   진행:', answered.join(' | '))
    const j = await lastJob()
    console.log('   답:', j.text.replace(/\n+/g, ' / ').slice(-300))
    assert(mock.state.signedInAs === 'jarvis.test@example.com', `로그인 계정: ${mock.state.signedInAs}`)
    assert(mock.state.password === SECRET, '비밀번호가 보안 입력값과 다름')
    assert(mock.state.track === 'closed', `트랙: ${mock.state.track}`)
    assert(mock.state.uploaded === 'app-release.aab', `업로드: ${mock.state.uploaded}`)
    assert(mock.state.notes && mock.state.notes.length > 0, '출시 노트 없음')
    assert(approvedFinal && mock.state.submitted, '최종 전송 안 됨')
    // 비밀번호가 어디에도 기록되지 않았는지
    for (const f of ['audit/audit.jsonl', 'memory/conversations.jsonl']) {
      const c = readFileSync(join(userData, f), 'utf8')
      assert(!c.includes(SECRET), `${f} 에 비밀번호 노출`)
    }
    await page.screenshot({ path: join(art, '26-release-done.png') })
  })
}

await step('안전: 실제 Jarvis 폴더에서 세션/작업이 일어나지 않음', async () => {
  const bad = audit().filter((e) => (e.project ?? '').endsWith('/Private/Jarvis') && ['session.open', 'file.modified', 'approval.requested', 'git.commit'].includes(e.action))
  assert(bad.length === 0, JSON.stringify(bad.map((e) => `${e.action}:${e.detail?.title ?? ''}`)))
})

await app.close()
mock.close()
console.log(failures ? `\n${failures} 단계 실패` : '\n모든 자율 기능 E2E 통과')
process.exit(failures ? 1 : 0)
