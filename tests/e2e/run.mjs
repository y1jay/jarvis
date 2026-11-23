// E2E: 실제 Electron 앱을 띄워 사용자 시나리오 전체를 검증한다.
// 사용: npm run e2e [단계이름...]   (사용자의 실제 Claude 로그인 사용, 임시 git 저장소에서만 작업)
import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const art = join(root, 'tests/e2e/artifacts')
mkdirSync(art, { recursive: true })
const only = process.argv.slice(2)
const want = (name) => only.length === 0 || only.includes(name)
const mac = process.platform === 'darwin'

let failures = 0
const step = async (name, fn) => {
  const t0 = Date.now()
  try {
    await fn()
    console.log(`✓ ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
  } catch (e) {
    failures++
    console.log(`✗ ${name}: ${e.message}`)
    await denyAllOpen().catch(() => undefined)
  }
}
let denyAllOpen = async () => {}
const assert = (c, m) => {
  if (!c) throw new Error(m)
}
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

function makeRepo(prefix) {
  const repo = mkdtempSync(join(tmpdir(), prefix))
  sh(repo, 'init', '-q', '-b', 'main')
  sh(repo, 'config', 'user.email', 'e2e@example.com')
  sh(repo, 'config', 'user.name', 'E2E')
  sh(repo, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(repo, 'README.md'), '# e2e\n')
  sh(repo, 'add', '.')
  sh(repo, 'commit', '-qm', 'init')
  return repo
}
const repo = makeRepo('jarvis-e2e-repo-')
const alpha = makeRepo('jarvis-e2e-alpha-')
const beta = makeRepo('jarvis-e2e-beta-')
const count = (r = repo) => Number(sh(r, 'rev-list', '--count', 'HEAD'))

// 가짜 마이크 입력 (macOS say → 16kHz wav + 앞뒤 무음)
function makeVoiceWav(sentence) {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-e2e-audio-'))
  const aiff = join(dir, 'v.aiff')
  const wav = join(dir, 'v.wav')
  execFileSync('say', ['-v', 'Yuna', '-o', aiff, sentence])
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav])
  const src = readFileSync(wav)
  const pcm = src.subarray(src.indexOf('data') + 8)
  const silence = Buffer.alloc(16000 * 2 * 2)
  const body = Buffer.concat([silence, pcm, silence, silence, silence, silence])
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + body.length, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(16000, 24)
  h.writeUInt32LE(32000, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(body.length, 40)
  const out = join(dir, 'voice.wav')
  writeFileSync(out, Buffer.concat([h, body]))
  return out
}

// 여러 번 띄워도 Whisper 모델 캐시를 재사용하도록 userData 공유
const userData = mkdtempSync(join(tmpdir(), 'jarvis-e2e-ud-'))
const baseEnv = { ...process.env }
delete baseEnv.ELECTRON_RUN_AS_NODE
const launch = (extra = {}) => electron.launch({ executablePath: require('electron'), args: [root], cwd: root, env: { ...baseEnv, JARVIS_E2E: '1', JARVIS_USER_DATA: userData, JARVIS_FAKE_LOGIN_FAIL: 'gemini', ...extra } })
const audit = () => readFileSync(join(userData, 'audit', 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))

const voiceWav = mac ? makeVoiceWav('자비스, 일 더하기 일은 얼마야? 숫자만 말해.') : null
const app = await launch(voiceWav ? { JARVIS_FAKE_AUDIO: voiceWav } : {})
const page = await app.firstWindow()
const logs = []
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
await page.waitForSelector('.app', { timeout: 30000 })
denyAllOpen = async () => {
  for (let i = 0; i < 10 && (await page.$('[data-testid=approval-modal]')); i++) {
    await page.click('[data-testid=approval-deny]')
    await page.waitForTimeout(300)
  }
}
/** 승인창 출처를 확인한 뒤에만 승인 — 엉뚱한 요청 승인 방지 */
const approveExpected = async (pg, expectFrom, expectTitle) => {
  const from = await pg.textContent('.modal-from')
  const title = await pg.textContent('.modal-title')
  assert(from.includes(expectFrom) && title.includes(expectTitle), `예상과 다른 승인 요청: ${from} / ${title}`)
  await pg.waitForTimeout(900)
  await pg.click('[data-testid=approval-approve]')
}

const jobCount = () => page.$$eval('[data-testid=jarvis-job]', (els) => els.length)
const waitJob = (n, timeout = 300000) =>
  page.waitForFunction(
    (n) => {
      const j = document.querySelectorAll('[data-testid=jarvis-job]')
      const s = j.length > n && j[j.length - 1].getAttribute('data-status')
      return s === 'done' || s === 'error'
    },
    n,
    { timeout }
  )
const lastJob = () => page.$$eval('[data-testid=jarvis-job]', (els) => ({ text: els[els.length - 1].innerText, status: els[els.length - 1].getAttribute('data-status') }))

/** JARVIS 에게 요청 → 해당 job 이 끝날 때까지 대기 */
const ask = async (text, timeout = 300000) => {
  await page.click('[data-testid=tab-chat]')
  if (await page.$('[data-testid=session-view]')) await page.click('text=← JARVIS')
  const n = await jobCount()
  await page.fill('[data-testid=chat-input]', text)
  await page.click('[data-testid=chat-send]')
  await waitJob(n, timeout)
  return lastJob()
}

await step('창 표시 + 홀로그램 렌더링 (캔버스 픽셀 확인)', async () => {
  await page.waitForTimeout(1500)
  const lit = await page.evaluate(() => {
    const c = document.querySelector('[data-testid=hologram-canvas]')
    return new Promise((res) => {
      const img = new Image()
      img.onload = () => {
        const cv = document.createElement('canvas')
        cv.width = img.width
        cv.height = img.height
        const g = cv.getContext('2d')
        g.drawImage(img, 0, 0)
        const d = g.getImageData(0, 0, cv.width, cv.height).data
        let n = 0
        for (let i = 0; i < d.length; i += 16) if (d[i + 3] > 30) n++
        res(n)
      }
      img.src = c.toDataURL()
    })
  })
  assert(lit > 500, `홀로그램 픽셀 부족: ${lit}`)
  await page.screenshot({ path: join(art, '01-home.png') })
})

await step('모델 연결 상태: "모델 연결 상태 알려줘" (AI 없이 JARVIS 가 직접)', async () => {
  const r = await ask('모델 연결 상태 알려줘')
  assert(/Claude: 연결됨/.test(r.text) && /GPT \(Codex\): 연결됨/.test(r.text) && /Gemini: 끊김/.test(r.text), r.text)
})

await step('끊긴 모델로 전환 → JARVIS 가 스스로 로그인 시도 + 안내 (Gemini, 브라우저 대신 실패 시뮬레이션)', async () => {
  const r = await ask('제미나이로 바꿔줘')
  assert(/연결이 끊겨 있습니다. 로그인 창을 열겠습니다/.test(r.text), r.text)
  assert(/로그인이 완료되지 않았습니다/.test(r.text), r.text)
  assert(audit().some((e) => e.action === 'auth.login' && e.provider === 'gemini'), '로그인 시도 이력 없음')
  await page.screenshot({ path: join(art, '02-model-connect.png') })
  const back = await ask('클로드로 바꿔줘')
  assert(/Claude 로 작업합니다/.test(back.text), back.text)
})

await step('말로 프로젝트 열기: "Jarvis 프로젝트 열어줘" (실제 폴더 스캔)', async () => {
  const r = await ask('Jarvis 프로젝트 열어줘')
  const t = await page.textContent('.project-path')
  assert(t.endsWith('/Private/Jarvis') && r.text.includes('열었습니다'), `${t} / ${r.text}`)
  // 실제 프로젝트에서는 아무 작업도 하지 않는다: 해당 세션 닫고 테스트 저장소로
  const sess = await page.evaluate(() => window.jarvis.session.list())
  for (const x of sess.sessions.filter((x) => x.projectDir?.endsWith('/Private/Jarvis'))) await page.evaluate((id) => window.jarvis.session.close(id), x.id)
  await ask(`${repo} 열어줘`)
})

await step('여러 프로젝트 한 번에 열기 → 각각 세션', async () => {
  const r = await ask(`${alpha}랑 ${beta} 열어줘`)
  assert(r.text.includes('2개 프로젝트를 각각의 세션으로'), r.text)
  const titles = await page.$$eval('[data-testid=session-item] .sess-title', (els) => els.map((e) => e.textContent))
  assert(titles.includes(basename(alpha)) && titles.includes(basename(beta)), titles.join(','))
})

if (want('claude')) {
  await step('여러 프로젝트 작업을 한 번에 → 세션별 병렬 실행 → JARVIS 한 답변', async () => {
    const r = await ask(`${basename(alpha)} 와 ${basename(beta)} 에 각각 NOTE.md 파일을 만들고 내용은 그 프로젝트 폴더 이름 한 줄로 써줘. 커밋은 하지 마.`)
    assert(r.status === 'done', r.text)
    assert(readFileSync(join(alpha, 'NOTE.md'), 'utf8').includes(basename(alpha)), 'alpha NOTE.md')
    assert(readFileSync(join(beta, 'NOTE.md'), 'utf8').includes(basename(beta)), 'beta NOTE.md')
    const chips = await page.$$eval('[data-testid=jarvis-job]', (els) => [...els[els.length - 1].querySelectorAll('.task')].map((e) => e.className))
    assert(chips.length === 2 && chips.every((c) => c.includes('task-done')), `작업 칩: ${chips}`)
    console.log('   ', r.text.replace(/\n+/g, ' / ').slice(0, 200))
    await page.screenshot({ path: join(art, '03-multi-session.png') })
    await page.evaluate(() => {
      const els = document.querySelectorAll('[data-testid=jarvis-job]')
      els[els.length - 1].querySelector('.task').click()
    })
    await page.waitForSelector('[data-testid=session-view] [data-testid=assistant-turn]')
    await page.screenshot({ path: join(art, '04-session-view.png') })
    await page.click('text=← JARVIS')
  })

  await step('Claude: 파일 생성 + commit 시도 → 승인 창(세션 표시) → 거부', async () => {
    await ask(`${repo} 열어줘`)
    const n = await jobCount()
    await page.fill('[data-testid=chat-input]', 'e2e.txt 파일을 만들고 내용은 정확히 "hello jarvis" 한 줄로 써. 그 다음 Bash 로 `git add e2e.txt && git commit -m "test: e2e"` 실행해. 거부되면 재시도하지 마.')
    await page.click('[data-testid=chat-send]')
    await page.waitForSelector('[data-testid=approval-modal]', { timeout: 240000 })
    const title = await page.textContent('.modal-title')
    assert(title.includes(`[${basename(repo)}]`), `승인 창에 세션 표시 없음: ${title}`)
    await page.screenshot({ path: join(art, '05-approval.png') })
    await page.click('[data-testid=approval-deny]')
    await waitJob(n, 240000)
    assert(readFileSync(join(repo, 'e2e.txt'), 'utf8').includes('hello jarvis'), '파일')
    assert(count() === 1, `거부했는데 커밋됨 (${count()})`)
  })

  await step('학습: "기억해둬" → 기억 저장 → 기억 탭 표시', async () => {
    await ask('앞으로 커밋 메시지는 항상 한국어로 써줘. 이건 기억해둬. 답은 한 문장으로.')
    let items = []
    for (let i = 0; i < 120 && !items.some((m) => /한국어/.test(m.text)); i++) {
      items = (await page.evaluate(() => window.jarvis.memory.list())).items
      await page.waitForTimeout(1000)
    }
    assert(items.some((m) => /한국어/.test(m.text)), `기억 없음: ${JSON.stringify(items)}`)
    console.log('   기억:', items.map((m) => m.text).join(' | '))
    await page.click('[data-testid=tab-memory]')
    await page.waitForSelector('.mem')
    await page.screenshot({ path: join(art, '06-memory.png') })
    assert(audit().some((e) => e.action === 'memory.add'), 'memory.add 이력 없음')
  })
}

await step('Git 패널: 스테이징 → 커밋(승인) → 실제 커밋', async () => {
  await page.evaluate((d) => window.jarvis.project.set(d), repo)
  if (!existsSync(join(repo, 'e2e.txt'))) writeFileSync(join(repo, 'e2e.txt'), 'hello jarvis\n')
  await page.click('[data-testid=tab-git]')
  await page.waitForSelector('.git-file')
  await page.click('text=전체 올리기')
  await page.waitForSelector('text=스테이징됨 (1)')
  await page.fill('[data-testid=commit-msg]', 'feat: e2e 커밋')
  await page.click('[data-testid=commit-btn]')
  await page.waitForSelector('[data-testid=approval-modal]')
  await approveExpected(page, 'JARVIS Git 패널', 'Git 커밋 승인')
  await page.waitForFunction(() => document.querySelector('.git-subj')?.textContent?.includes('e2e 커밋'), null, { timeout: 15000 })
  assert(sh(repo, 'log', '-1', '--pretty=%s') === 'feat: e2e 커밋', '커밋 메시지 불일치')
})

await step('이력: 세션/승인/커밋/파일 수정 기록', async () => {
  await page.click('[data-testid=tab-history]')
  await page.waitForSelector('.hist')
  const raw = audit()
  for (const a of ['git.commit', 'approval.approved', 'project.open', 'session.open']) assert(raw.some((e) => e.action === a), `이력에 ${a} 없음`)
  if (want('claude')) for (const a of ['approval.denied', 'file.modified', 'agent.prompt']) assert(raw.some((e) => e.action === a), `이력에 ${a} 없음`)
  const c = raw.find((e) => e.action === 'git.commit')
  assert(c.actor && c.ts && c.source?.host && c.target, '이력 필드 누락')
})

if (mac && want('system')) {
  const running = () => {
    try {
      execFileSync('pgrep', ['-x', 'Calculator'])
      return true
    } catch {
      return false
    }
  }
  const waitFor = async (fn, ms = 10000) => {
    const t = Date.now()
    while (Date.now() - t < ms) {
      if (fn()) return true
      await new Promise((r) => setTimeout(r, 300))
    }
    return false
  }
  await step('다른 앱 열기/종료: "계산기 열어줘" / "계산기 종료해줘"', async () => {
    await ask('계산기 열어줘')
    assert(await waitFor(running), '계산기 미실행')
    await ask('계산기 종료해줘')
    assert(await waitFor(() => !running()), '계산기 아직 실행 중')
  })
  await step('사이트 로그인 연동: "깃허브 로그인해줘" → JARVIS 브라우저 로그인 페이지 (로그인 없이 닫으면 미완료)', async () => {
    await page.click('[data-testid=tab-chat]')
    const n = await jobCount()
    await page.fill('[data-testid=chat-input]', '깃허브 로그인해줘')
    await page.click('[data-testid=chat-send]')
    let url = ''
    for (let i = 0; i < 40 && !url.includes('github.com/login'); i++) {
      await page.waitForTimeout(500)
      url = (await page.evaluate(() => window.jarvis.browser.state())).url
    }
    assert(url.includes('github.com/login'), `로그인 페이지 없음: ${url}`)
    await page.waitForTimeout(1500)
    await page.screenshot({ path: join(art, '07-site-login.png') })
    await page.click('[data-testid=browser-panel-close]')
    await waitJob(n, 20000)
    const t = (await lastJob()).text
    assert(/로그인이 완료되지 않았습니다/.test(t), t)
    assert(audit().some((e) => e.action === 'auth.site.login' && e.target === 'github.com'), '사이트 로그인 이력 없음')
  })
}

await step('카메라 + 손 추적 초기화 (가짜 카메라)', async () => {
  await page.click('[data-testid=camera-toggle]')
  await page.waitForFunction(() => document.querySelector('.hud-tr .hud-v')?.textContent?.includes('HAND'), null, { timeout: 30000 })
  await page.waitForTimeout(2500)
  const v = await page.evaluate(() => ({ w: document.querySelector('video.cam').videoWidth, t: document.querySelector('video.cam').currentTime }))
  assert(v.w > 0 && v.t > 0, `카메라 영상 없음 ${JSON.stringify(v)}`)
  await page.click('[data-testid=camera-toggle]')
})

if (voiceWav && want('voice')) {
  await step('음성: "자비스, 일 더하기 일은?" → 호출어 → 명령 → 답변', async () => {
    await page.click('[data-testid=tab-chat]')
    const before = await jobCount()
    await page.click('[data-testid=mic-toggle]')
    await waitJob(before, 480000)
    const t = (await lastJob()).text
    console.log('   ', t.replace(/\n+/g, ' / ').slice(0, 120))
    assert(/🎙/.test(t) && /(^|\D)2(\D|$)|이입니다/.test(t.split('JARVIS').pop()), t)
    await page.screenshot({ path: join(art, '08-voice.png') })
    await page.click('[data-testid=mic-toggle]')
  })
}

await step('안전: 실제 Jarvis 프로젝트에서 실행된 작업 없음', async () => {
  const touched = audit().filter((e) => ['file.modified', 'git.commit', 'approval.requested'].includes(e.action) && (e.project ?? '').endsWith('/Private/Jarvis'))
  assert(touched.length === 0, JSON.stringify(touched.map((e) => e.action)))
})

writeFileSync(join(art, 'console.log'), logs.join('\n'))
await app.close()

// ── 음성 승인: 자연어 대답 ──
async function voiceApproval(sentence, expectApproved, tag) {
  const a = await launch({ JARVIS_FAKE_AUDIO: makeVoiceWav(sentence) })
  const pg = await a.firstWindow()
  try {
    await pg.waitForSelector('.app')
    await pg.evaluate((d) => window.jarvis.project.set(d), repo)
    await pg.reload()
    await pg.waitForSelector('[data-testid=mic-toggle]')
    await pg.click('[data-testid=mic-toggle]')
    await pg.waitForFunction(() => document.querySelector('.holo-progress')?.textContent?.includes('준비 완료'), null, { timeout: 420000 })
    const fname = `voice-${Date.now()}.txt`
    writeFileSync(join(repo, fname), sentence + '\n')
    await pg.evaluate((f) => window.jarvis.git.stage([f]), fname)
    const before = count()
    await pg.click('[data-testid=tab-git]')
    await pg.fill('[data-testid=commit-msg]', `test: voice ${tag}`)
    await pg.click('[data-testid=commit-btn]')
    await pg.waitForSelector('[data-testid=approval-voice-hint]', { timeout: 10000 })
    await pg.screenshot({ path: join(art, `09-voice-approval-${tag}.png`) })
    await pg.waitForSelector('[data-testid=approval-modal]', { state: 'detached', timeout: 120000 })
    await pg.waitForTimeout(800)
    const dec = audit().filter((e) => e.action === (expectApproved ? 'approval.approved' : 'approval.denied')).pop()
    console.log(`   인식: "${dec?.detail?.transcript}" via=${dec?.detail?.via}`)
    assert(dec?.detail?.via === 'voice', '음성 승인 이력 없음')
    if (expectApproved) assert(count() === before + 1, `커밋 안 됨 (${before}→${count()})`)
    else {
      assert(count() === before, '거부했는데 커밋됨')
      sh(repo, 'reset', '-q', 'HEAD', '--', fname)
    }
  } finally {
    await a.close()
  }
}
if (mac && want('voice-approval')) {
  await step('음성 승인(자연어): "응, 그렇게 해" → 커밋', () => voiceApproval('응, 그렇게 해.', true, 'ok'))
  await step('음성 거부(자연어): "잠깐, 하지 마" → 커밋 안 됨', () => voiceApproval('잠깐, 하지 마.', false, 'no'))
  await step('규칙에 없는 표현 "그걸로 가시죠" → AI 판정 → 승인 + 학습 사전 기록', async () => {
    await voiceApproval('그걸로 가시죠.', true, 'learn')
    const lex = JSON.parse(readFileSync(join(userData, 'memory', 'approval-lexicon.json'), 'utf8'))
    console.log('   학습된 표현:', lex.map((e) => `${e.example}→${e.decision}(${e.source})`).join(', '))
    assert(lex.some((e) => e.source === 'ai' && e.decision === 'approve'), '학습 기록 없음')
    assert(audit().some((e) => e.action === 'lexicon.learn'), 'lexicon.learn 이력 없음')
  })
}

console.log(failures ? `\n${failures} 단계 실패` : '\n모든 E2E 단계 통과')
console.log('스크린샷:', art)
process.exit(failures ? 1 : 0)
