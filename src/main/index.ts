import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, Notification, powerMonitor, safeStorage, session, shell, systemPreferences, Tray } from 'electron'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AuditLog } from './audit'
import { SettingsStore, type DeepPartial } from './settings'
import { SecretStore, maskKey } from './secrets'
import { AuthService } from './auth'
import { GitService } from './git'
import { openBackup, SpeechLexicon, VoiceVault } from './voicevault'
import { collectBrain, mergeBrain, type BrainBundle } from './brain'
import { DialogContext } from './dialog'
import { CORRECT_BELOW_LOGPROB, SpeechCorrector } from './corrector'
import { enginesFor, TtsHub, voiceById, VOICE_CATALOG } from './tts'
import { cer, MIN_SAMPLES, usableSamples, VoiceTrainer } from './learn'
import { appWindows, mirrorClick, mirrorType, webAppUrl, windowBounds } from './mirror'
import { ClaudeProvider } from './providers/claude'
import { CodexProvider } from './providers/codex'
import { GeminiProvider } from './providers/gemini'
import type { AgentProvider } from './providers/types'
import { oneShot, commitMessagePrompt } from './oneshot'
import { parseOpenIntent, pickProjectPrompt, ProjectFinder, resolveProject } from './projects'
import { listApps, openApp, openUrl, parseQuitIntent, quitApp, resolveApp, resolveFolder, resolveSite, revealPath, type AppEntry } from './system'
import { createJarvisTools, JARVIS_TOOL_NAMES } from './jarvisTools'
import { mentionedProjects, needsPlanning, Orchestrator } from './orchestrator'
import { ApprovalLexicon, ConversationLog, extractMemoryPrompt, jobToRecord, MemoryStore, parseMemoryExtraction } from './memory'
import { JarvisBrowser, resolveSiteDef, SiteStore } from './browser'
import { isAuthError, isContinuation, isOtherRequest, isRepeatRequest, parsePanelIntent, parseSideIntent, timeAnswer, parseProviderIntent, parseVoiceLearnIntent, parseSiteLoginIntent, parseVoiceIntent, splitTargets } from './intents'
import { Asker, resolveChoice, type QuestionKind } from './asker'
import { DeviceHub, parseDeviceIntent, type Platform } from './devices'
import { androidReleasePlaybook, parseReleaseIntent } from './release'
import { brandName, DEFAULT_NAME, parseRenameIntent } from '../shared/wake'
import { FastChat, isCodeWork, needsAgent } from './fastchat'
import { isClamshell, KeepAwake, wakeDisplay } from './power'
import { buildVocabPrompt, defaultModelKey, MODELS, NativeStt, sttBinaryPath } from './stt'
import { APP_ALIASES } from './system'
import { classifyApprovalPrompt, parseClassification, ruleApproval, type ApprovalDecision } from '../shared/approval'
import {
  PROVIDER_LABEL,
  type AgentEvent,
  type AgentEventEnvelope,
  type ApprovalRequest,
  type ApprovalResponse,
  type AuthStatus,
  type JarvisSettings,
  type JobInfo,
  type ProviderId,
  type SessionInfo
} from '../shared/types'

// __dirname 은 electron-vite 가 ESM 번들에 주입한다
let win: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
const startHidden = process.argv.includes('--hidden') || (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin)

function showWindow(): void {
  if (!win) createWindow()
  if (win!.isMinimized()) win!.restore()
  win!.show()
  win!.focus()
  if (process.platform === 'darwin') app.focus({ steal: true })
}

function trayIcon(): Electron.NativeImage {
  const base = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'build')
  const f = join(base, process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png')
  const img = existsSync(f) ? nativeImage.createFromPath(f) : nativeImage.createEmpty()
  if (process.platform === 'darwin') img.setTemplateImage(true)
  return img
}

function buildTray(): void {
  if (!tray) {
    tray = new Tray(trayIcon())
    tray.on('click', () => showWindow())
  }
  // 이름을 바꾸면 트레이 이름도
  tray!.setToolTip(brandName(settings.get().assistantName))
  const s = settings.get()
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `${s.assistantName} 열기`, click: () => showWindow() },
      { label: '듣기 켜기/끄기', click: () => send('voice:toggle', {}) },
      { type: 'separator' },
      {
        label: '로그인 시 자동 실행',
        type: 'checkbox',
        checked: s.launchAtLogin,
        click: (item) => {
          settings.update({ launchAtLogin: item.checked })
          applyLoginItem()
          audit.record({ action: 'settings.changed', provider: 'jarvis', detail: { keys: ['launchAtLogin'], after: { launchAtLogin: item.checked }, via: 'tray' } })
        }
      },
      { type: 'separator' },
      {
        label: '종료',
        click: () => {
          quitting = true
          app.quit()
        }
      }
    ])
  )
}

/** 로그인 시 숨김 상태로 자동 실행 (설치된 앱에서만 — 개발 중에는 Electron 바이너리가 등록되므로 생략) */
function applyLoginItem(): void {
  if (!app.isPackaged) return
  const on = settings.get().launchAtLogin
  app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] })
}
let settings: SettingsStore
let audit: AuditLog
let secrets: SecretStore
let auth: AuthService
let gitSvc: GitService
let orch: Orchestrator
let convo: ConversationLog
let memory: MemoryStore
let lexicon: ApprovalLexicon
let sites: SiteStore
let fastChat: FastChat
const keepAwake = new KeepAwake()
function applyKeepAwake(): void {
  const s = settings.get()
  keepAwake.set(s.alwaysListen && s.keepAwake)
}
let stt: NativeStt
let vault: VoiceVault
let speechLex: SpeechLexicon
let corrector: SpeechCorrector
let tts: TtsHub
let trainer: VoiceTrainer
/** 마지막으로 받아 적은 말과 엔진 확신도 — 실행 직전에 문맥 보정을 할지 정한다 */
let lastHeard: { text: string; logprob: number; at: number } | null = null
const browser = new JarvisBrowser({
  window: () => win,
  requestShow: () => send('popup:open', 'browser'),
  onState: (st) => send('browser:state', st)
})
const devices = new DeviceHub()
/** 지금 묻고 있는 질문의 선택지를 인식 힌트 맨 앞에 — 대답을 선택지 단어로 알아듣게 */
function questionPrompt(): string {
  const q = asker.list().filter((x) => x.kind !== 'secret' && x.kind !== 'code').pop()
  if (!q) return ''
  const opts = (q.options ?? []).map((o) => o.replace(/\s*\(.*?\)/g, '')).slice(0, 12)
  return opts.length ? `${opts.join(', ')}. ` : ''
}

/** 질문을 소리로: 선택지가 많으면 다 읽지 않는다 (긴 목록을 듣느라 기다리지 않게) */
function spokenQuestion(q: { text: string; options?: string[] }): string {
  const o = q.options ?? []
  if (!o.length) return q.text
  if (o.length <= 3) return `${q.text} ${o.map((x, i) => `${i + 1}번 ${x}`).join(', ')}`
  return `${q.text} ${o.slice(0, 2).join(', ')} 등 ${o.length}가지가 있어요. 화면에서 고르시거나 이름을 말씀해 주세요.`
}

const asker = new Asker({
  show: (q) => {
    if (!win || win.isDestroyed()) return false
    send('jarvis:question', q)
    if (q.kind !== 'secret') send('jarvis:speak', spokenQuestion(q))
    return true
  },
  hide: (id) => send('jarvis:question-done', id),
  audit: (q, a) => {
    const masked = q.kind === 'secret' || q.kind === 'code'
    audit.record({ action: 'jarvis.ask', provider: 'jarvis', project: settings.get().projectDir, target: q.id, detail: { question: q.text, kind: q.kind, options: q.options, from: q.from } })
    audit.record({ action: 'jarvis.answer', provider: 'jarvis', project: settings.get().projectDir, target: q.id, detail: { answered: a !== null, answer: masked ? (a ? '***' : null) : a } })
  }
})

/** 사용자에게 되묻기 (선택지면 답을 선택지로 해석, 실패 시 한 번 더 묻기) */
/** 질문 도중 다른 요청으로 넘어갔을 때 askUser 가 돌려주는 값 — 부른 쪽은 조용히 끝낸다 */
const REDIRECTED = '\u0000redirected'

async function askUser(question: string, opts: { kind?: QuestionKind; options?: string[]; from?: string; strict?: boolean } = {}): Promise<string | null> {
  const a = await asker.ask(question, opts)
  if (a === null || !opts.options?.length) return a
  // 전에 배운 교정이 있으면 먼저
  const learned = settings.get().voice.learning ? speechLex.fix(a) : null
  const c = resolveChoice(learned ?? a, opts.options) ?? (learned ? resolveChoice(a, opts.options) : null)
  if (c) return c
  // AI 가 물은 질문이면 자연어 답을 그대로 넘긴다 (AI 가 해석). JARVIS 자체 선택지(목소리/기기 등)는 아래처럼
  if (!opts.strict) return a
  // 고르는 대신 다른 걸 말씀하셨으면 ("그거 말고 인터넷에서 찾아봐") — 묻기를 그만두고 그 말을 새 요청으로 처리
  if (isOtherRequest(a)) {
    startJob(a, 'voice')
    return REDIRECTED
  }
  const again = await asker.ask(`"${a}" 는 선택지에 없어요. 다시 말씀해 주세요.`, opts)
  if (again !== null && resolveChoice(again, opts.options) === null && isOtherRequest(again)) {
    startJob(again, 'voice')
    return REDIRECTED
  }
  // JARVIS 자체 선택지는 알아듣지 못한 말을 그대로 쓰지 않는다 (엉뚱한 값이 설정되지 않게)
  const chosen = again === null ? null : resolveChoice(again, opts.options)
  // 학습: 처음에 잘못 알아들은 말 → 다시 말해서 고른 것. 다음엔 처음 말로도 바로 알아듣는다
  if (chosen && settings.get().voice.learning) {
    speechLex.learnFix(a, chosen)
    markCorrected(a, chosen)
    audit.record({ action: 'voice.lexicon.fix', provider: 'jarvis', detail: { heard: a, meant: chosen, via: 'reask' } })
  }
  return chosen
}

const PLATFORM_LABEL: Record<Platform, string> = { ios: '아이폰 시뮬레이터', android: '안드로이드 에뮬레이터' }

function streamDevice(): void {
  devices.startStream((png, size) => send('device:frame', { data: png.toString('base64'), size, platform: devices.active }))
}

/** 기기 실행: 플랫폼/기기를 모르면 물어보고, 화면은 JARVIS 팝업으로 */
async function startDevice(platform?: Platform, name?: string): Promise<string> {
  // 기본값: 맥은 아이폰 시뮬레이터 (안드로이드는 "안드로이드"라고 분명히 말할 때만)
  if (!platform) platform = process.platform === 'darwin' ? 'ios' : 'android'
  const choices = await devices.choices(platform)
  if (!choices.length) return platform === 'ios' ? 'iOS 시뮬레이터가 없습니다. Xcode 를 설치하거나 시뮬레이터를 만들어 주세요.' : 'AVD 가 없습니다. Android Studio 의 Device Manager 에서 가상 기기를 먼저 만들어 주세요.'
  let c = name ? devices.match(choices, name) : null
  if (!c) {
    // 아이폰은 묻지 않고 기본 기기로 (켜져 있는 것 → 최신 iOS 아이폰). 다른 기기는 "iPhone 16 띄워줘"처럼 이름으로
    if (choices.length === 1 || platform === 'ios') c = devices.pickDefault(choices)
    else {
      const ans = await askUser(`어떤 ${PLATFORM_LABEL[platform]}를 띄울까요?`, { options: choices.map((x) => x.label), strict: true })
      if (ans === REDIRECTED) return ''
      c = choices.find((x) => x.label === ans) ?? null
    }
  }
  if (!c) return '기기 선택이 취소되었습니다.'
  send('popup:open', 'device')
  send('device:status', { platform, state: 'booting', name: c.label })
  const r = await devices.start(c, (line) => line && send('device:status', { platform, state: 'booting', name: c!.label, log: line.slice(0, 160) }))
  audit.record({ action: 'emulator.start', provider: 'jarvis', target: c.label, detail: { platform, id: c.id, ok: r.ok } })
  if (!r.ok) {
    send('device:status', { platform, state: 'error', name: c.label, log: r.message })
    return r.message
  }
  send('device:status', { platform, state: 'running', name: c.label })
  streamDevice()
  return `${r.message}. JARVIS 화면에 팝업으로 띄웠습니다.`
}

async function stopDevice(): Promise<string> {
  const msg = await devices.stop()
  send('device:status', { platform: null, state: 'stopped' })
  audit.record({ action: 'emulator.stop', provider: 'jarvis', detail: { message: msg } })
  return msg
}

function imageDataUrl(path?: string): string | undefined {
  if (!path) return undefined
  try {
    return `data:image/png;base64,${readFileSync(path).toString('base64')}`
  } catch {
    return undefined
  }
}
const finder = new ProjectFinder()
const pendingApprovals = new Map<string, (r: ApprovalResponse) => void>()
/** Claude 의 open_project 도구가 예약한 전환 (턴 종료 후 적용) */
let pendingSwitch: string | null = null
const authCache = new Map<ProviderId, { at: number; status: AuthStatus }>()
const loginInFlight = new Map<ProviderId, Promise<boolean>>()

const createProvider = (p: ProviderId): AgentProvider => (p === 'claude' ? new ClaudeProvider() : p === 'gpt' ? new CodexProvider() : new GeminiProvider())

function workspaceDir(): string {
  const ws = join(app.getPath('userData'), 'workspace')
  mkdirSync(ws, { recursive: true })
  return ws
}

/** 포커스된 세션의 프로젝트 (Git 패널 등) */
function cwd(): string {
  return settings.get().projectDir ?? workspaceDir()
}

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

/** 음성 인식 힌트 어휘: 이름·최근 프로젝트·연결 사이트·자주 쓰는 앱/용어 */
function vocabPrompt(): string {
  const s = settings.get()
  const projects = s.recentProjects.map((d) => d.split(/[\\/]/).pop() ?? '')
  return buildVocabPrompt([
    `헤이 ${s.assistantName}`,
    s.assistantName,
    '자비스',
    // 사용자가 자주 쓰는 말 (학습)
    ...(s.voice.learning ? speechLex.topWords(20) : []),
    ...projects,
    ...sites.list().map((x) => x.name),
    '깃허브', '커밋', '푸시', '풀 리퀘스트', 'API', 'README',
    ...Object.keys(APP_ALIASES).slice(0, 25),
    '에뮬레이터', '아이폰 시뮬레이터', '플레이 콘솔'
  ])
}

function memoryText(): string {
  const name = settings.get().assistantName
  const persona = name && name !== DEFAULT_NAME ? `[호칭] 사용자는 당신을 "${name}"(이)라고 부른다. 스스로를 ${name}(이)라고 소개한다.` : ''
  return [persona, settings.get().learning.enabled ? memory.asPrompt() : ''].filter(Boolean).join('\n\n')
}

/** 보조 호출(계획·요약·학습·승인 판정)용 모델 — 응답 대기 시간을 줄이려 Claude 는 빠른 모델 */
function sideModel(p: ProviderId): string | undefined {
  return p === 'claude' ? settings.get().fastModel || settings.model(p) : settings.model(p)
}

function ask(p: ProviderId, prompt: string): Promise<string> {
  const mem = memoryText()
  return oneShot(p, mem ? `${mem}\n\n${prompt}` : prompt, workspaceDir(), auth.envFor(p), sideModel(p))
}

// ── 승인 ──────────────────────────────────────────────────────────
/** renderer 에 승인 창을 띄우고 응답을 기다린다. 모든 요청/결과는 이력에 남는다. */
function requestApproval(req: Omit<ApprovalRequest, 'id'>, project: string | null = settings.get().projectDir): Promise<ApprovalResponse> {
  const id = randomUUID()
  const full: ApprovalRequest = { ...req, id }
  audit.record({ action: 'approval.requested', provider: req.provider, project, target: req.kind, detail: { title: req.title, detail: req.detail.slice(0, 2000), toolName: req.toolName } })
  if (!win || win.isDestroyed()) {
    audit.record({ action: 'approval.denied', provider: req.provider, project, target: req.kind, detail: { reason: 'no-window', requestId: id } })
    return Promise.resolve({ id, approved: false, reason: 'JARVIS 창이 없습니다' })
  }
  return new Promise((resolve) => {
    pendingApprovals.set(id, (r) => {
      audit.record({ action: r.approved ? 'approval.approved' : 'approval.denied', provider: req.provider, project, target: req.kind, detail: { requestId: id, reason: r.reason, title: req.title, via: r.via ?? 'click', transcript: r.transcript } })
      resolve(r)
    })
    if (win!.isMinimized()) win!.restore()
    win!.show()
    win!.focus()
    send('approval:request', full)
  })
}

// ── 모델 연결 (JARVIS 자체는 항상 동작, 모델이 끊기면 스스로 로그인 창을 연다) ──
async function authStatus(p: ProviderId, fresh = false): Promise<AuthStatus> {
  const c = authCache.get(p)
  if (!fresh && c && Date.now() - c.at < 5 * 60_000) return c.status
  const status = await auth.status(p)
  authCache.set(p, { at: Date.now(), status })
  send('auth:changed', status)
  return status
}

function loginProvider(p: ProviderId): Promise<boolean> {
  const inflight = loginInFlight.get(p)
  if (inflight) return inflight
  const run = (async () => {
    const ok = await auth.login(p, (line) => send('auth:log', { provider: p, line }))
    if (ok && p === 'gemini') settings.update({ geminiUseGoogleLogin: true })
    audit.record({ action: 'auth.login', provider: p, detail: { success: ok, method: 'browser' } })
    authCache.delete(p)
    await authStatus(p, true)
    return ok
  })().finally(() => loginInFlight.delete(p))
  loginInFlight.set(p, run)
  return run
}

// ── JARVIS 작업 (요청 1개 = 답변 1개) ───────────────────────────────
function emitJob(job: JobInfo): void {
  send('jarvis:job', structuredClone(job))
}

function note(job: JobInfo, msg: string): void {
  job.notes.push(msg)
  emitJob(job)
}

function finishJob(job: JobInfo, answer: string, status: JobInfo['status'] = 'done'): JobInfo {
  job.answer = answer
  job.status = status
  emitJob(job)
  return job
}

async function ensureConnected(job: JobInfo, p: ProviderId): Promise<boolean> {
  const st = await authStatus(p)
  if (st.loggedIn) return true
  const others: ProviderId[] = []
  for (const o of ['claude', 'gpt', 'gemini'] as ProviderId[]) if (o !== p && (await authStatus(o)).loggedIn) others.push(o)
  note(job, `${PROVIDER_LABEL[p]} 연결이 끊겨 있습니다. 로그인 창을 열겠습니다. 브라우저에서 로그인해 주세요.${others.length ? ` (지금 연결된 모델: ${others.map((o) => PROVIDER_LABEL[o]).join(', ')} — "${PROVIDER_LABEL[others[0]]}로 바꿔줘"라고 하셔도 됩니다)` : ''}`)
  send('jarvis:speak', `${PROVIDER_LABEL[p]} 연결이 필요합니다. 로그인 창을 열겠습니다.`)
  const ok = await loginProvider(p)
  if (ok) note(job, `${PROVIDER_LABEL[p]} 연결 완료. 요청을 이어서 처리합니다.`)
  return ok
}

async function siteLogin(query: string, job?: JobInfo): Promise<string> {
  const site = resolveSiteDef(query) ?? (resolveSite(query) ? resolveSiteDef(new URL(resolveSite(query)!).hostname.replace(/^www\./, '')) : null)
  if (!site) return `"${query}" 사이트를 찾지 못했습니다. 도메인(예: example.com)으로 말씀해 주세요.`
  if (job) note(job, `🔐 ${site.name} 로그인 페이지를 JARVIS 브라우저에 열었습니다. 로그인을 마치면 세션을 기억해 두겠습니다. ("구글로 로그인해"라고 하시면 제가 진행합니다)`)
  const r = await browser.login(site)
  audit.record({ action: 'auth.site.login', provider: 'jarvis', target: site.domain, detail: { site: site.key, ok: r.ok, reason: r.reason } })
  if (r.ok) {
    sites.upsert(site)
    send('sites:changed', sites.list())
    return `${site.name} 로그인 연동을 완료했습니다. 이제 이 세션으로 ${site.name} 작업을 할 수 있습니다.`
  }
  return `${site.name} 로그인이 완료되지 않았습니다 (${r.reason}).`
}

// MCP 서버 인스턴스는 한 번에 한 세션에만 연결되므로 세션마다 따로 만든다
const toolsBySession = new Map<string, ReturnType<typeof createJarvisTools>>()
function jarvisTools(sessionId: string): ReturnType<typeof createJarvisTools> {
  const existing = toolsBySession.get(sessionId)
  if (existing) return existing
  const created = createJarvisTools({
    audit: (i) => audit.record({ ...i, project: i.project ?? settings.get().projectDir }),
    requestProjectSwitch: async (query) => {
      const rr = resolveProject(query, finder.list(settings.get().recentProjects))
      if (!rr.path) return { message: rr.candidates.length ? `후보가 여러 개입니다: ${rr.candidates.map((c) => c.path).join(', ')}` : `프로젝트를 찾지 못했습니다: ${query}` }
      pendingSwitch = rr.path
      return { path: rr.path, message: `응답이 끝나면 ${rr.path} 세션으로 전환합니다. 그 전까지는 절대 경로로 접근하세요.` }
    },
    clipboardRead: () => clipboard.readText(),
    clipboardWrite: (t) => clipboard.writeText(t),
    notify: (title, body) => new Notification({ title, body }).show(),
    browser,
    devices,
    approve: async (title, detail, kind = 'tool', image) => (await requestApproval({ kind, provider: 'claude', title, detail, image: imageDataUrl(image) })).approved,
    ask: (question, opts) => askUser(question, { ...opts, from: 'Claude' }),
    siteLogin: (s) => siteLogin(s),
    startDevice: (platform, name) => startDevice(platform, name),
    stopDevice: () => stopDevice(),
    openAppInJarvis: (q, a, via) => openAppInJarvis(q, a, via)
  })
  toolsBySession.set(sessionId, created)
  return created
}

// 턴 기록용
const turnBuf = new Map<string, { sessionId: string; prompt: string; text: string; isError: boolean; jobId?: string }>()

function buildOrchestrator(): Orchestrator {
  return new Orchestrator({
    createProvider,
    ask,
    defaultCwd: workspaceDir,
    buildContext: (s, turnId, emit) => {
      const st = settings.get()
      const tools = s.provider === 'claude' ? jarvisTools(s.id) : null
      const project = s.projectDir
      return {
        turnId,
        cwd: project ?? workspaceDir(),
        // 프로젝트 없는 일반 세션 = 일상 행동 → 빠른 모델 (Opus 대비 행동 처리 약 2~3배 빠름)
        model: s.provider === 'claude' && !project && st.actionModel ? st.actionModel : settings.model(s.provider),
        permissionMode: st.claudePermissionMode,
        env: auth.envFor(s.provider),
        emit,
        memory: memoryText(),
        approve: async (req) => {
          const r = await requestApproval({ ...req, provider: s.provider, title: `[${s.title}] ${req.title}` }, project)
          return { approved: r.approved, reason: r.reason }
        },
        audit: (i) => audit.record({ ...i, project: i.project ?? project }),
        mcpServers: tools ? { jarvis: tools } : undefined,
        allowedTools: tools ? JARVIS_TOOL_NAMES : undefined
      }
    },
    onSessions: (list, focused) => {
      send('session:list', { sessions: list, focused })
      const f = list.find((x) => x.id === focused)
      if (f && f.projectDir !== settings.get().projectDir) {
        const next = settings.update({ projectDir: f.projectDir })
        send('settings:changed', next)
      }
    },
    onJob: (job) => emitJob(job),
    onEvent: (e) => {
      if (e.event.kind === 'followup') deliverFollowup(e.sessionId, e.event.text)
      const b = turnBuf.get(e.turnId)
      if (b) {
        const ev = e.event
        if (ev.kind === 'text' && ev.text) b.text = ev.text
        else if (ev.kind === 'text-delta') b.text += ev.text
        else if (ev.kind === 'result' && ev.text) b.text = ev.text
        else if (ev.kind === 'error') b.isError = true
      }
      send('agent:event', e satisfies AgentEventEnvelope)
    },
    onTurnStart: (e) => {
      turnBuf.set(e.turnId, { sessionId: e.sessionId, prompt: e.prompt, text: '', isError: false, jobId: e.jobId })
      send('agent:turn-start', e)
    },
    onTurnDone: (e) => {
      const b = turnBuf.get(e.turnId)
      turnBuf.delete(e.turnId)
      const s = orch.get(e.sessionId)
      if (b) convo.record({ type: 'turn', ts: new Date().toISOString(), sessionId: e.sessionId, title: s?.title ?? '', provider: e.provider, project: s?.projectDir ?? null, jobId: b.jobId, prompt: b.prompt.slice(0, 8000), answer: b.text.slice(0, 8000), isError: b.isError })
      send('agent:done', e)
      const sw = pendingSwitch
      pendingSwitch = null
      if (sw) openProject(sw, 'agent')
    },
    onSessionOpen: (s) => audit.record({ action: 'session.open', provider: s.provider, project: s.projectDir, target: s.id, detail: { title: s.title } }),
    onSessionClose: (s) => (toolsBySession.delete(s.id), audit.record({ action: 'session.close', provider: s.provider, project: s.projectDir, target: s.id, detail: { title: s.title, turns: s.turns } }))
  })
}

function openProject(dir: string, via: 'user' | 'agent' = 'user'): JarvisSettings {
  const s = settings.get()
  const recent = [dir, ...s.recentProjects.filter((d) => d !== dir)].slice(0, 10)
  audit.record({ action: 'project.open', provider: 'jarvis', project: dir, target: dir, detail: { via, previous: s.projectDir } })
  settings.update({ recentProjects: recent })
  orch.sessionFor(s.provider, dir, true) // 프로젝트 = 세션 (없으면 생성, 있으면 포커스)
  const next = settings.update({ projectDir: dir })
  send('settings:changed', next)
  return next
}

/** 학습: 대화에서 사용자 정보 추출 → 기억 (백그라운드) */
async function learnFrom(job: JobInfo, p: ProviderId): Promise<void> {
  if (!settings.get().learning.enabled || !job.answer || job.prompt.trim().length < 6) return
  try {
    const raw = await oneShot(p, extractMemoryPrompt(job.prompt, job.answer, memory.list()), workspaceDir(), auth.envFor(p), sideModel(p))
    const added = memory.add(parseMemoryExtraction(raw), job.id)
    for (const m of added) audit.record({ action: 'memory.add', provider: 'jarvis', target: m.id, detail: { text: m.text, category: m.category, source: job.id } })
    if (added.length) send('memory:changed', memory.list())
  } catch {
    /* 학습 실패는 무시 */
  }
}


/** 목소리 바꾸기: 사용 가능한 목소리를 알려주고 고르게 한다 */
/** 목소리 바꾸기 — 필요하면 엔진 설치 (Qwen3 는 용량이 커서 승인 후). 결과 메시지 */
async function useVoice(voiceId: string): Promise<string> {
  const v = voiceById(voiceId)
  const before = settings.get().voice.ttsVoiceId
  if (v && !enginesFor(process.platform, process.arch).includes(v.engine)) return `${v.label} 목소리는 이 컴퓨터에서 쓸 수 없습니다.`
  if (v && !tts.installed(v.engine)) {
    if (v.engine === 'qwen3') {
      const r = await requestApproval({ kind: 'tool', provider: 'jarvis', title: `${v.label} 목소리를 쓰려면 Qwen3 목소리 엔진을 설치해야 해요 (약 3GB). 설치할까요?`, detail: '내 맥에서만 돌아가는 오픈소스 엔진(mlx-audio, Qwen3-TTS)을 JARVIS 폴더에 설치합니다. 처음 한 번만 받고, 이후엔 인터넷 없이 동작합니다.' }, null)
      if (!r.approved) return '설치하지 않아 목소리를 그대로 두었습니다.'
    }
    send('jarvis:speak', v.engine === 'qwen3' ? '목소리 엔진을 설치할게요. 몇 분 걸릴 수 있어요.' : '목소리 모델을 받을게요. 잠시만요.')
    try {
      await tts.install(v.engine)
      audit.record({ action: 'tts.install', provider: 'jarvis', target: v.engine, detail: { voice: v.id } })
    } catch (e) {
      audit.record({ action: 'tts.install', provider: 'jarvis', target: v.engine, detail: { voice: v.id, error: (e as Error).message } })
      return `목소리 엔진 설치에 실패했습니다: ${(e as Error).message}`
    }
  }
  if (v?.engine === 'qwen3') {
    send('tts:state', { engine: 'qwen3', state: 'installing', message: `${v.label} 목소리 모델을 준비하는 중 (처음이면 모델을 받느라 몇 분 걸려요)` })
    try {
      await tts.warm(v.id)
      send('tts:state', { engine: 'qwen3', state: 'ready' })
    } catch (e) {
      return `목소리를 준비하지 못했습니다: ${(e as Error).message}`
    }
  }
  const id = v ? v.id : 'system'
  send('settings:changed', settings.update({ voice: { ttsVoiceId: id } }))
  audit.record({ action: 'settings.changed', provider: 'jarvis', detail: { keys: ['voice'], before: { ttsVoiceId: before }, after: { ttsVoiceId: id }, via: 'voice-select' } })
  return v ? `이제 ${v.label} 목소리로 말씀드릴게요.` : '기본 목소리로 바꿨습니다.'
}

async function handleVoiceIntent(action: 'choose' | 'faster' | 'slower' | 'lower' | 'higher' | 'reset' | 'more'): Promise<string> {
  const v = settings.get().voice
  const apply = (patch: Partial<JarvisSettings['voice']>, msg: string): string => {
    const before = { ...v }
    const next = settings.update({ voice: patch })
    send('settings:changed', next)
    audit.record({ action: 'settings.changed', provider: 'jarvis', detail: { keys: ['voice'], before: pick(before, Object.keys(patch)), after: patch, via: 'command' } })
    return msg
  }
  const clamp = (x: number, lo: number, hi: number): number => Math.round(Math.min(hi, Math.max(lo, x)) * 100) / 100
  if (action === 'faster') return apply({ ttsRate: clamp(v.ttsRate + 0.15, 0.6, 1.8) }, '조금 더 빠르게 말씀드리겠습니다.')
  if (action === 'slower') return apply({ ttsRate: clamp(v.ttsRate - 0.15, 0.6, 1.8) }, '조금 더 천천히 말씀드리겠습니다.')
  if (action === 'lower') return apply({ ttsPitch: clamp(v.ttsPitch - 0.15, 0.5, 1.6) }, '목소리를 조금 낮췄습니다.')
  if (action === 'higher') return apply({ ttsPitch: clamp(v.ttsPitch + 0.15, 0.5, 1.6) }, '목소리를 조금 높였습니다.')
  if (action === 'reset') return apply({ ttsVoice: null, ttsRate: 1.05, ttsPitch: 0.95 }, '기본 목소리로 되돌렸습니다.')
  const openDownload = async (): Promise<string> => {
    await shell.openExternal(process.platform === 'darwin' ? 'x-apple.systempreferences:com.apple.preference.universalaccess?SpokenContent' : 'ms-settings:speech')
    return process.platform === 'darwin'
      ? '음성 설정을 열었습니다. "시스템 음성 → 음성 관리"에서 한국어 목소리(예: 유나 고품질, 수현, 민수 등)를 내려받은 뒤 다시 "목소리 바꿔줘"라고 해 주세요.'
      : '음성 설정을 열었습니다. 한국어 음성을 추가한 뒤 다시 "목소리 바꿔줘"라고 해 주세요.'
  }
  if (action === 'more') return openDownload()
  // 고르기: 자주 쓰는 목소리(미리듣기에서 고른 것) 먼저
  const fav = settings.get().voice.ttsFavorites.map((id) => voiceById(id)).filter((x): x is NonNullable<typeof x> => !!x && enginesFor(process.platform, process.arch).includes(x.engine))
  const MORE = '다른 목소리 미리듣기'
  const SYSTEM = '기본 목소리'
  const label = (x: { label: string; engine: string }): string => (x.engine === 'supertonic' ? x.label.replace('Supertonic 목소리', '슈퍼토닉') : x.label)
  const options = [...fav.map(label), SYSTEM, MORE]
  const cur = voiceById(v.ttsVoiceId)
  const ans = await askUser(`지금은 ${cur ? label(cur) : '기본'} 목소리예요. 어떤 목소리로 바꿀까요?`, { options, from: 'JARVIS', strict: true })
  if (ans === REDIRECTED) return ''
  if (!ans) return '목소리 변경을 취소했습니다.'
  if (ans === MORE) {
    send('ui:panel', true)
    send('ui:tab', 'settings')
    return '설정의 목소리 목록을 열었어요. ▶ 로 들어 보시고 "사용"을 누르시면 바로 바뀝니다.'
  }
  if (ans === SYSTEM) return useVoice('system')
  const picked = fav.find((x) => label(x) === ans)
  return picked ? useVoice(picked.id) : '목소리 변경을 취소했습니다.'
}

/** 요청 처리: 로컬 명령 → 모델 연결 확인 → 오케스트레이터 → 학습 */
// ── 음성 학습 샘플: 잠깐 들고 있다가(교정되면 표시) 잠가서 저장 ─────────────
const heldSamples: Array<{ s: import('./voicevault').VoiceSample; timer: NodeJS.Timeout }> = []
function holdSample(s: import('./voicevault').VoiceSample): void {
  const item = { s, timer: setTimeout(() => flushSample(item), 30_000) }
  heldSamples.push(item)
}
function flushSample(item: { s: import('./voicevault').VoiceSample; timer: NodeJS.Timeout }): void {
  clearTimeout(item.timer)
  const i = heldSamples.indexOf(item)
  if (i >= 0) heldSamples.splice(i, 1)
  try {
    vault.add(item.s)
  } catch (e) {
    console.warn('[voice] 샘플 저장 실패', (e as Error).message)
  }
}
/** 잘못 알아들었던 샘플에 '실제로 뜻한 말'을 붙인다 (이런 샘플은 용량이 차도 가장 나중에 지움) */
function markCorrected(heard: string, meant: string): void {
  const n = (t: string): string => t.replace(/[.!?,\s]/g, '')
  // 호출어를 뺀 명령이어도 같은 말소리로 본다 ("자비스 지금 몇 시야" 샘플 ← "지금 몇 시야")
  const h = [...heldSamples].reverse().find((x) => n(x.s.heard) === n(heard) || (n(heard).length >= 3 && n(x.s.heard).includes(n(heard))))
  if (!h) return
  h.s.corrected = true
  h.s.final = meant
  flushSample(h)
}

const BRAIN_DIR = 'jarvis-memory'
let brainTimer: NodeJS.Timeout | null = null
/** 기억 전부를 잠근 파일(.voice/brain.jvs)로 갱신 — 바뀐 뒤 잠깐 모아서 */
function refreshBrain(now = false): void {
  if (!vault?.ready) return
  const run = (): void => {
    brainTimer = null
    try {
      vault.writeBrain(collectBrain(app.getPath('userData'), speechLex.data, app.getVersion()))
    } catch (e) {
      console.warn('[brain] 갱신 실패', (e as Error).message)
    }
  }
  if (brainTimer) clearTimeout(brainTimer)
  if (now) run()
  else brainTimer = setTimeout(run, 20_000)
}

/** 다른 기기에서 만든 백업을 이 기기로 되살리기 (지우지 않고 합치기) */
async function restoreBrain(): Promise<string> {
  const a = await askUser(`복원할 백업 폴더를 알려 주세요. git 저장소를 받은 폴더나 그 안의 ${BRAIN_DIR} 폴더 (예: ~/Private/jarvis-memory-repo)`, { kind: 'text', from: 'JARVIS' })
  if (!a) return '복원을 취소했습니다.'
  const base = a.trim().replace(/^~(?=\/)/, app.getPath('home'))
  const dir = existsSync(join(base, 'vault.json')) ? base : join(base, BRAIN_DIR)
  if (!existsSync(join(dir, 'vault.json'))) return `${base} 에서 JARVIS 백업을 찾지 못했어요.`
  const pass = await askUser('백업을 잠근 음성 학습 암호를 입력해 주세요.', { kind: 'secret', from: 'JARVIS' })
  if (!pass) return '복원을 취소했습니다.'
  const b = openBackup(dir, pass)
  if (!b) return '암호가 맞지 않아 복원하지 않았습니다.'
  const ud = app.getPath('userData')
  const parts: string[] = []
  const raw = b.read('brain.jvs')
  if (raw) {
    const { result, lexicon: lex } = mergeBrain(ud, JSON.parse(raw.toString()) as BrainBundle, speechLex.data)
    speechLex.replace(lex)
    // 합친 파일로 다시 읽기
    memory = new MemoryStore(join(ud, 'memory', 'memory.json'))
    lexicon = new ApprovalLexicon(join(ud, 'memory', 'approval-lexicon.json'))
    sites = new SiteStore(join(ud, 'sites.json'))
    settings = new SettingsStore(join(ud, 'settings.json'))
    send('settings:changed', settings.get())
    send('memory:changed', memory.list())
    parts.push(`기억 ${result.memory}개, 대화 ${result.conversations}개, 승인 표현 ${result.approvals}개, 단어 ${result.words}개, 바로잡은 말 ${result.fixes}개, 사이트 ${result.sites}개를 더했고, 설정 ${result.settings.length}가지를 맞췄습니다`)
    audit.record({ action: 'voice.vault.restore', provider: 'jarvis', target: dir, detail: { ...result, from: b.info.createdAt } })
  } else {
    const lexRaw = b.read('lexicon.jvs')
    if (lexRaw) {
      const { lexicon: lex } = mergeBrain(ud, { v: 1, createdAt: new Date().toISOString(), app: '', files: {}, speechLexicon: JSON.parse(lexRaw.toString()) }, speechLex.data)
      speechLex.replace(lex)
    }
  }
  const v = vault.adoptFrom(dir)
  parts.push(v.conflict ? '말소리는 이 기기의 보관함이 다른 암호라 가져오지 않았어요' : `말소리 ${v.samples}개를 가져왔습니다`)
  refreshBrain(true)
  return `복원했습니다. ${parts.join('. ')}.`
}

let training = false
/** 내 목소리 맞춤 학습: 모인 말소리 → 학습 → 비교 → 더 나을 때만 바꾸기 */
async function trainVoice(): Promise<string> {
  if (training) return '이미 학습 중이에요. 끝나면 알려 드릴게요.'
  if (!vault.ready) return '먼저 "음성 학습 암호 정해줘"로 암호를 정해 주세요. 그때부터 말소리가 모이고, 모인 말소리로 학습합니다.'
  const pass = await askUser('저장된 말소리를 열려면 음성 학습 암호가 필요해요. 입력해 주세요.', { kind: 'secret', from: 'JARVIS' })
  if (!pass) return '학습을 취소했습니다.'
  let all
  try {
    all = vault.readAll(pass)
  } catch {
    return '암호가 맞지 않아 학습하지 않았습니다.'
  }
  const items = usableSamples(all)
  if (items.length < MIN_SAMPLES) return `학습에 쓸 수 있는 말소리가 ${items.length}개예요. 최소 ${MIN_SAMPLES}개가 필요하고, 200~300개면 확실히 좋아집니다. (모은 말소리 ${all.length}개 중 정답이 믿을 만한 것만 씁니다) 조금 더 대화한 뒤 다시 말씀해 주세요.`
  if (!trainer.installed) {
    const r = await requestApproval({ kind: 'tool', provider: 'jarvis', title: '내 목소리 학습 도구를 설치할까요? (약 1GB, 처음 한 번)', detail: '이 맥에서만 도는 학습 도구(PyTorch, Transformers)와 기본 모델(약 1.6GB)을 JARVIS 폴더에 받습니다. 학습 중 메모리는 약 5GB 이하로 제한합니다.' }, null)
    if (!r.approved) return '설치하지 않아 학습하지 않았습니다.'
  }
  training = true
  const t0 = Date.now()
  try {
    await trainer.install()
    const { dataDir, train, evalItems } = trainer.prepare(items)
    send('jarvis:speak', `말소리 ${train}개로 학습을 시작할게요. 끝나면 알려 드릴게요.`)
    const model = await trainer.train(dataDir, 3)
    // 비교: 학습에 안 쓴 말소리로 지금 모델 vs 새 모델
    send('tts:state', { engine: 'learn', state: 'installing', message: '지금 모델과 새 모델을 비교하는 중' })
    const pcms = await trainer.decode(evalItems.map((x) => x.audio))
    const { mkdtempSync, symlinkSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const md = mkdtempSync(join(tmpdir(), 'jarvis-eval-'))
    const cur = settings.get().voice.nativeModel
    const curFile = MODELS[cur]?.file ?? MODELS[defaultModelKey()].file
    symlinkSync(join(app.getPath('userData'), 'models', curFile), join(md, curFile))
    symlinkSync(model, join(md, MODELS.personal.file))
    const score = async (key: string): Promise<number> => {
      const s2 = new NativeStt({ binary: sttBinaryPath(app.getAppPath(), process.resourcesPath, app.isPackaged), modelsDir: md, modelKey: () => key, onState: () => undefined })
      if (!(await s2.start())) throw new Error('비교용 음성 엔진을 띄우지 못했습니다')
      let err = 0
      for (let i = 0; i < evalItems.length; i++) err += cer(evalItems[i].text, await s2.transcribe(pcms[i]))
      s2.stop()
      return 1 - err / evalItems.length
    }
    const before = await score(cur in MODELS ? cur : defaultModelKey())
    const after = await score('personal')
    const better = after > before + 0.01
    if (better) {
      trainer.adopt(model, join(app.getPath('userData'), 'models'))
      send('settings:changed', settings.update({ voice: { nativeModel: 'personal' } }))
      void stt.restart()
    }
    audit.record({ action: 'voice.train', provider: 'jarvis', detail: { samples: items.length, train, eval: evalItems.length, before: Math.round(before * 1000) / 10, after: Math.round(after * 1000) / 10, adopted: better, seconds: Math.round((Date.now() - t0) / 1000) } })
    send('tts:state', { engine: 'learn', state: 'ready' })
    return better
      ? `학습을 마쳤어요. 학습에 안 쓴 말소리로 비교해 보니 알아듣기가 ${(before * 100).toFixed(1)}%에서 ${(after * 100).toFixed(1)}%로 좋아져서, 새 모델로 바꿨습니다.`
      : `학습은 했지만 비교해 보니 ${(before * 100).toFixed(1)}% → ${(after * 100).toFixed(1)}%로 나아지지 않아서, 지금 모델을 그대로 씁니다. 말소리가 더 모이면 다시 해 볼게요.`
  } catch (e) {
    audit.record({ action: 'voice.train', provider: 'jarvis', detail: { samples: items.length, error: (e as Error).message.slice(0, 300) } })
    send('tts:state', { engine: 'learn', state: 'error', message: `학습 실패: ${(e as Error).message.slice(0, 120)}` })
    return `학습 중 문제가 생겼어요: ${(e as Error).message.slice(0, 200)}`
  } finally {
    training = false
  }
}

/** 음성 학습 명령: 암호 정하기 / 상태 / 백업 / 지우기 */
async function handleVoiceLearn(action: 'setup' | 'status' | 'backup' | 'clear' | 'restore' | 'train' | 'revert'): Promise<string> {
  const mb = (b: number): string => `${(b / 1024 / 1024).toFixed(1)}MB`
  if (action === 'status') {
    const st = vault.stats()
    const words = speechLex.topWords(8)
    return [
      st.ready ? `말소리 샘플 ${st.samples}개 (${mb(st.bytes)} / 최대 ${mb(st.limitBytes)}) — 내 암호로 잠겨 있습니다.` : '말소리 샘플은 아직 저장하지 않고 있어요. "음성 학습 암호 정해줘"라고 하시면 시작합니다.',
      `바로잡은 말 ${Object.keys(speechLex.data.fixes).length}개, 배운 단어 ${Object.keys(speechLex.data.words).length}개.`,
      words.length ? `자주 쓰시는 말: ${words.join(', ')}` : ''
    ]
      .filter(Boolean)
      .join('\n')
  }
  if (action === 'setup') {
    if (vault.ready) {
      const ok = await askUser('이미 음성 학습 암호가 있어요. 확인을 위해 지금 암호를 입력해 주세요. (새 암호로 바꾸면 예전 샘플은 예전 암호로만 열립니다)', { kind: 'secret', from: 'JARVIS' })
      if (!ok || !vault.check(ok)) return '암호가 맞지 않아 그대로 두었습니다.'
    }
    const p1 = await askUser('음성 학습 암호를 정해 주세요. 이 암호를 아는 사람만 저장된 목소리를 열 수 있고, JARVIS 도 암호를 저장하지 않습니다. 잊으면 복구할 수 없어요. (6자 이상)', { kind: 'secret', from: 'JARVIS' })
    if (!p1) return '암호 설정을 취소했습니다.'
    const p2 = await askUser('확인을 위해 한 번 더 입력해 주세요.', { kind: 'secret', from: 'JARVIS' })
    if (p1 !== p2) return '두 암호가 달라서 설정하지 않았습니다. 다시 "음성 학습 암호 정해줘"라고 해 주세요.'
    try {
      vault.setup(p1)
    } catch (e) {
      return (e as Error).message
    }
    audit.record({ action: 'voice.vault.setup', provider: 'jarvis', detail: { replaced: false } })
    refreshBrain(true)
    return '음성 학습을 시작합니다. 이제부터 제가 들은 말소리를 암호로 잠가 숨김 폴더에 모아 두고, 자주 쓰시는 말과 바로잡아 주신 말을 배웁니다.'
  }
  if (action === 'clear') {
    const st = vault.stats()
    const r = await requestApproval({ kind: 'tool', provider: 'jarvis', title: `음성 학습 샘플 ${st.samples}개를 모두 지울까요?`, detail: '지운 샘플은 되돌릴 수 없습니다. (말투 학습은 그대로 둡니다)' }, null)
    if (!r.approved) return '지우지 않았습니다.'
    const n = vault.clearSamples()
    audit.record({ action: 'voice.vault.clear', provider: 'jarvis', detail: { removed: n } })
    return `음성 학습 샘플 ${n}개를 지웠습니다.`
  }
  if (action === 'restore') return restoreBrain()
  if (action === 'train') return trainVoice()
  if (action === 'revert') {
    const before = settings.get().voice.nativeModel
    if (before !== 'personal') return '지금은 기본 인식 모델을 쓰고 있어요.'
    send('settings:changed', settings.update({ voice: { nativeModel: process.platform === 'darwin' ? 'large-v3' : 'small' } }))
    audit.record({ action: 'settings.changed', provider: 'jarvis', detail: { keys: ['voice'], before: { nativeModel: before }, after: { nativeModel: settings.get().voice.nativeModel }, via: 'revert-personal' } })
    void stt.restart()
    return '기본 인식 모델로 되돌렸습니다. 학습한 모델은 지우지 않고 보관해 둘게요.'
  }
  // backup
  if (!vault.ready) return '먼저 "음성 학습 암호 정해줘"로 암호를 정해 주세요. 백업은 그 암호로 잠긴 채 올라갑니다.'
  refreshBrain(true)
  let repo = settings.get().voice.learnRepo
  if (!repo) {
    const a = await askUser('백업할 git 저장소 폴더 경로를 알려 주세요. 목소리 데이터라 비공개 저장소를 권장합니다. (예: ~/Private/jarvis-voice)', { kind: 'text', from: 'JARVIS' })
    if (!a) return '백업을 취소했습니다.'
    repo = a.trim().replace(/^~(?=\/)/, app.getPath('home'))
    if (!existsSync(join(repo, '.git'))) return `${repo} 는 git 저장소가 아니에요. 비공개 저장소를 만들어 clone 한 폴더를 알려 주세요.`
    send('settings:changed', settings.update({ voice: { learnRepo: repo } }))
  }
  const target = join(repo, BRAIN_DIR)
  const r = vault.exportTo(target, { 'lexicon.jvs': speechLex.exportPlain() })
  await gitSvc.stage(repo, [BRAIN_DIR])
  const c = await gitSvc.commit(repo, `memory: JARVIS 기억 백업 (암호화, 말소리 +${r.copied})`)
  audit.record({ action: 'voice.vault.backup', provider: 'jarvis', project: repo, detail: { copied: r.copied, committed: c.approved && c.code === 0 } })
  if (!c.approved) return `백업 파일 ${r.copied}개를 ${target} 에 잠근 채로 넣었고, 커밋은 하지 않았습니다.`
  if (c.code !== 0) return `커밋하지 못했습니다: ${(c.stderr || c.stdout).slice(0, 200)}`
  const ps = await gitSvc.push(repo)
  if (ps.approved) audit.record({ action: 'git.push', provider: 'jarvis', project: repo, detail: { code: ps.code, via: 'voice-backup' } })
  return ps.approved && ps.code === 0 ? `기억 전부(대화·기억·승인/말투 학습·설정·말소리)를 암호로 잠근 채 백업하고 푸시했습니다. (새 말소리 ${r.copied}개)` : `커밋까지 했고 푸시는 ${ps.approved ? `실패했습니다: ${(ps.stderr || '').slice(0, 200)}` : '하지 않았습니다.'}`
}

// ── 최근 대화 (대화가 이어지게) ──────────────────────────────────
/** 최근 주고받은 말 (대화가 이어지게) — 어느 경로로 답했는지(jobLane)와 함께 */
const talk = new DialogContext()
const jobLane = new Map<string, string>()

function rememberDialog(job: JobInfo): void {
  talk.add({ user: job.prompt, jarvis: job.answer ?? '', lane: jobLane.get(job.id) ?? 'local' })
  jobLane.delete(job.id)
}

function withRecentDialog(text: string, lane: string): string {
  return talk.wrap(text, lane, settings.get().assistantName)
}


/** 작업을 어느 세션에서 돌릴지: 생성된 지시문 → 현재 프로젝트, 일상 행동 → 일반 세션(빠른 모델), 그 외 → 자동 */
function jobRoute(text: string, p: ProviderId, known: string[], generated: boolean): { project: string | null; focus?: boolean } | undefined {
  if (generated) return { project: settings.get().projectDir }
  if (p === 'claude' && settings.get().actionModel && !isCodeWork(text) && mentionedProjects(text, known).length === 0) return { project: null, focus: false }
  return undefined
}

async function handleRequest(job: JobInfo): Promise<void> {
  const prompt = job.prompt
  let p = settings.get().provider
  let text = prompt
  /** true 면 text 는 JARVIS 가 만든 지시문 → 아래 로컬 명령 해석(사이트/앱/열기)을 건너뛴다 */
  let generated = false

  // 0-0) "다시 말해줘", "뭐라고?" — 방금 한 말을 그대로 다시 (AI 를 거치지 않아 즉시)
  if (isRepeatRequest(text)) {
    const last = talk.last()
    return void finishJob(job, last ? last.jarvis : '아직 드린 말씀이 없어요. 무엇을 도와드릴까요?')
  }

  // 0) 이름 바꾸기: "이제부터 네 이름은 프라이데이야"
  const newName = parseRenameIntent(text)
  if (newName) {
    const before = settings.get().assistantName
    const next = settings.update({ assistantName: newName })
    send('settings:changed', next)
    audit.record({ action: 'settings.changed', provider: 'jarvis', detail: { keys: ['assistantName'], before: { assistantName: before }, after: { assistantName: newName }, via: 'command' } })
    // 화면·트레이 이름, 말투(빠른 대화 모델의 자기소개)도 새 이름으로
    buildTray()
    fastChat.close()
    return void finishJob(job, `알겠습니다. 이제 제 이름은 ${newName}예요. "헤이 ${newName}" 또는 "${newName}"라고 불러 주세요. "헤이 자비스"도 계속 됩니다.`)
  }

  // 1) 모델 연결/전환/해제
  const pi = parseProviderIntent(text)
  if (pi) {
    const target = pi.provider ?? p
    if (pi.action === 'status') {
      const lines: string[] = []
      for (const o of ['claude', 'gpt', 'gemini'] as ProviderId[]) {
        const st = await authStatus(o, true)
        lines.push(`- ${PROVIDER_LABEL[o]}: ${st.loggedIn ? '연결됨' : '끊김'}${o === p ? ' (사용 중)' : ''}`)
      }
      return void finishJob(job, `모델 연결 상태입니다.\n${lines.join('\n')}`)
    }
    if (pi.action === 'logout') {
      const ok = await requestApproval({ kind: 'tool', provider: 'jarvis', title: `${PROVIDER_LABEL[target]} 연결 해제`, detail: target === 'claude' ? '이 컴퓨터의 Claude Code CLI 전체에서 로그아웃됩니다.' : target === 'gpt' ? 'Codex CLI 에서 로그아웃됩니다.' : 'JARVIS 에서 Google 로그인 연결을 해제합니다.' })
      if (!ok.approved) return void finishJob(job, '연결 해제를 취소했습니다.')
      await auth.logout(target)
      if (target === 'gemini') settings.update({ geminiUseGoogleLogin: false })
      audit.record({ action: 'auth.logout', provider: target, detail: { via: 'command' } })
      authCache.delete(target)
      await authStatus(target, true)
      return void finishJob(job, `${PROVIDER_LABEL[target]} 연결을 해제했습니다.`)
    }
    if (pi.action === 'switch') {
      if (target !== p) {
        const before = p
        send('settings:changed', settings.update({ provider: target }))
        audit.record({ action: 'settings.changed', provider: 'jarvis', detail: { keys: ['provider'], before: { provider: before }, after: { provider: target }, via: 'command' } })
        p = target
      }
      note(job, `${PROVIDER_LABEL[target]} 로 전환했습니다.`)
      if (!(await ensureConnected(job, target))) return void finishJob(job, `${PROVIDER_LABEL[target]} 로그인이 완료되지 않았습니다.`, 'error')
      if (!pi.rest) return void finishJob(job, `이제 ${PROVIDER_LABEL[target]} 로 작업합니다.`)
      text = pi.rest
    }
    if (pi.action === 'login') {
      const st = await authStatus(target, true)
      if (st.loggedIn) return void finishJob(job, `${PROVIDER_LABEL[target]} 은(는) 이미 연결되어 있습니다${st.account ? ` (${st.account})` : ''}.`)
      note(job, `${PROVIDER_LABEL[target]} 로그인 창을 열었습니다. 브라우저에서 로그인해 주세요.`)
      const ok = await loginProvider(target)
      return void finishJob(job, ok ? `${PROVIDER_LABEL[target]} 연결을 완료했습니다.` : `${PROVIDER_LABEL[target]} 로그인이 완료되지 않았습니다.`, ok ? 'done' : 'error')
    }
  }

  // 0-0-1) 시간·날짜는 시계로 바로 (AI 는 지금 시각을 모른다)
  const clock = timeAnswer(text)
  if (clock) return void finishJob(job, clock)

  // 0-1) 왼쪽 AI 연결 창 / 대화창 열기·닫기
  const side = parseSideIntent(text)
  if (side !== null) {
    send('ui:side', side)
    return void finishJob(job, side ? '왼쪽 창을 열었습니다.' : '왼쪽 창을 닫았습니다.')
  }
  const panel = parsePanelIntent(text)
  if (panel !== null) {
    send('ui:panel', panel)
    return void finishJob(job, panel ? '대화창을 열었습니다.' : '대화창을 닫았습니다.')
  }

  // 1-0) 음성 학습 (암호/상태/백업/지우기)
  const vl = parseVoiceLearnIntent(text)
  if (vl) return void finishJob(job, await handleVoiceLearn(vl))

  // 1-1) 목소리 바꾸기 (대화로)
  const vi = parseVoiceIntent(text)
  if (vi) return void finishJob(job, await handleVoiceIntent(vi.action))

  // 1-2) 테스트 기기 (안드로이드 에뮬레이터 / 아이폰 시뮬레이터)
  const di = parseDeviceIntent(text)
  if (di) {
    if (di.action === 'stop') return void finishJob(job, await stopDevice())
    note(job, '📱 기기를 준비합니다…')
    const msg = await startDevice(di.platform ?? undefined, di.name)
    note(job, msg)
    if (!di.rest || !devices.active) return void finishJob(job, msg)
    // "띄워서 앱 확인해" → 나머지는 Claude 가 기기 도구로 수행 (생성된 지시문은 로컬 명령 해석을 건너뛴다)
    text = `${di.rest}\n\n(${devices.active === 'ios' ? '아이폰 시뮬레이터' : '안드로이드 에뮬레이터'} 가 실행 중이다. device 도구들로 앱을 설치/실행하고 device_screenshot 을 Read 로 보며 확인한 뒤 결과를 보고하라.)`
    generated = true
    if (p !== 'claude' && (await authStatus('claude')).loggedIn) {
      note(job, '기기 조작은 Claude 로 진행합니다.')
      p = 'claude'
    }
  }

  // 1-3) 안드로이드 출시
  const ri = parseReleaseIntent(text)
  if (ri) {
    if (p !== 'claude') {
      if (!(await authStatus('claude')).loggedIn && !(await ensureConnected(job, 'claude'))) return void finishJob(job, '출시 작업은 Claude 연결이 필요합니다.', 'error')
      note(job, '출시 작업은 Claude 로 진행합니다 (브라우저·터미널 도구 사용).')
      p = 'claude'
    }
    audit.record({ action: 'release.start', provider: 'claude', project: settings.get().projectDir, detail: { request: text } })
    note(job, '🚀 Google Play 출시 플레이북을 시작합니다. 트랙 선택과 최종 전송은 꼭 여쭤보겠습니다.')
    text = androidReleasePlaybook(text, settings.get().projectDir)
    generated = true
  }

  // 2) 사이트 로그인 연동
  const sl = generated ? null : parseSiteLoginIntent(text)
  if (sl) {
    const site = resolveSiteDef(sl.site)
    if (site) {
      if (sl.action === 'logout') {
        const n = await browser.logout(site.domain)
        sites.remove(site.key)
        send('sites:changed', sites.list())
        audit.record({ action: 'auth.site.logout', provider: 'jarvis', target: site.domain, detail: { cookies: n } })
        return void finishJob(job, `${site.name} 로그인 연동을 해제했습니다.`)
      }
      return void finishJob(job, await siteLogin(sl.site, job))
    }
  }

  // 3) 앱 종료
  const quit = generated ? null : parseQuitIntent(text)
  if (quit) {
    // "창 닫아", "그거 닫아", "다 닫아" → JARVIS 화면에 떠 있는 팝업 닫기
    if (/^(창|그거|이거|저거|팝업|화면|브라우저|웹|웹\s*창|전부|다|모두|열린\s*거|띄운\s*거)$/.test(quit.target)) {
      browser.close()
      send('popup:close', 'all')
      audit.record({ action: 'system.app.quit', provider: 'jarvis', target: 'popups', detail: { query: quit.target, via: 'command' } })
      if (!quit.rest) return void finishJob(job, '닫았습니다.')
      text = quit.rest
    } else if (webAppUrl(quit.target)) {
      // 웹으로 연 앱(슬랙·크롬 …)은 JARVIS 브라우저를 닫는다
      browser.close()
      send('popup:close', 'browser')
      audit.record({ action: 'system.app.quit', provider: 'jarvis', target: quit.target, detail: { inJarvis: true, via: 'command' } })
      if (!quit.rest) return void finishJob(job, `${quit.target} 을(를) 닫았습니다.`)
      text = quit.rest
    }
  }
  const quitApp2 = quit && text === quit.rest ? null : quit
  if (quitApp2) {
    const quit = quitApp2
    const a = resolveApp(quit.target, listApps())
    if (a) {
      send('mirror:close', a.name)
      const r = await quitApp(a.name)
      audit.record({ action: 'system.app.quit', provider: 'jarvis', target: a.name, detail: { query: quit.target, ok: r.ok, via: 'command' } })
      note(job, `⏻ ${r.message}`)
      if (!quit.rest) return void finishJob(job, r.ok ? `${a.name} 을(를) 종료했습니다.` : `${a.name} 종료에 실패했습니다: ${r.message}`, r.ok ? 'done' : 'error')
      text = quit.rest
    }
  }

  // 4) 열기: 프로젝트(여러 개 가능) / 폴더 / 앱 / 웹사이트
  const intent = generated ? null : parseOpenIntent(text)
  if (intent) {
    const known = finder.list(settings.get().recentProjects)
    // 여러 프로젝트 동시에: "xcroll-be랑 xcroll-app 열어줘"
    const parts = splitTargets(intent.query)
    const multi = parts.length > 1 ? parts.map((q) => resolveProject(q, known).path) : []
    if (multi.length > 1 && multi.every(Boolean)) {
      for (const dir of multi as string[]) {
        openProject(dir, 'agent')
        note(job, `📁 세션 열기: ${dir}`)
      }
      text = intent.rest
      if (!text) return void finishJob(job, `${multi.length}개 프로젝트를 각각의 세션으로 열었습니다. 무엇을 할까요?`)
    } else {
      let r = resolveProject(intent.query, known)
      let target: { kind: 'project'; path: string } | { kind: 'app'; app: AppEntry } | { kind: 'url'; url: string } | { kind: 'folder'; path: string } | null = r.path ? { kind: 'project', path: r.path } : null
      if (!target && r.candidates.length === 0) {
        const folder = resolveFolder(intent.query)
        const a = folder ? null : resolveApp(intent.query, listApps())
        const url = folder || a ? null : resolveSite(intent.query)
        if (folder) target = { kind: 'folder', path: folder }
        else if (a) target = { kind: 'app', app: a }
        else if (url) target = { kind: 'url', url }
      }
      // AI 에게 후보 선택 맡김 (음성 인식으로 영어 이름이 한글로 적힌 경우 등) — 모델이 연결돼 있을 때만
      if (!target && r.candidates.length === 0 && (await authStatus(p)).loggedIn) {
        const apps = listApps()
        const pool = [...known, ...apps.map((x) => `app:${x.name}`)]
        note(job, `🔎 "${intent.query}" 찾는 중…`)
        try {
          const ans = (await ask(p, pickProjectPrompt(intent.query, pool))).trim().split('\n')[0].trim()
          if (ans.startsWith('app:')) {
            const a = apps.find((x) => `app:${x.name}` === ans)
            if (a) target = { kind: 'app', app: a }
          } else if (known.includes(ans)) {
            target = { kind: 'project', path: ans }
            r = { path: ans, candidates: [] }
          }
        } catch {
          /* 일반 요청으로 */
        }
      }
      if (target) {
        if (target.kind === 'project') {
          openProject(target.path, 'agent')
          note(job, `📁 프로젝트 열기: ${target.path}`)
        } else if (target.kind === 'app') {
          const res = await openAppInJarvis(intent.query, target.app, 'command')
          note(job, `▶ ${res.message}`)
          if (!res.ok) return void finishJob(job, `${target.app.name} 실행에 실패했습니다: ${res.message}`, 'error')
          if (!intent.rest) return void finishJob(job, res.message)
        } else if (target.kind === 'url') {
          const res = await openUrl(target.url)
          audit.record({ action: 'system.url.open', provider: 'jarvis', target: target.url, detail: { query: intent.query, via: 'command' } })
          note(job, `🌐 ${res.message}`)
        } else {
          const res = await revealPath(target.path)
          audit.record({ action: 'system.path.open', provider: 'jarvis', target: target.path, detail: { query: intent.query, via: 'command' } })
          note(job, `📂 ${res.message}`)
        }
        text = intent.rest
        if (!text) {
          const label = target.kind === 'project' ? `${target.path.split(/[\\/]/).pop()} 프로젝트를` : target.kind === 'app' ? `${target.app.name} 을(를)` : target.kind === 'url' ? '웹사이트를' : '폴더를'
          return void finishJob(job, `${label} 열었습니다.${target.kind === 'project' ? ' 무엇을 할까요?' : ''}`)
        }
      } else if (r.candidates.length > 1) {
        return void finishJob(job, `"${intent.query}" 에 해당하는 프로젝트가 여러 개입니다. 어느 것을 열까요?\n${r.candidates.slice(0, 5).map((c) => `- ${c.path}`).join('\n')}`)
      }
    }
  }

  // 5) 모델 연결 확인 (끊겨 있으면 JARVIS 가 직접 로그인 창을 연다)
  if (!(await ensureConnected(job, p))) return void finishJob(job, `${PROVIDER_LABEL[p]} 에 연결되지 않아 요청을 처리하지 못했습니다. 다시 "${PROVIDER_LABEL[p]} 연결해줘"라고 말씀해 주세요.`, 'error')

  // 6-0) 빠른 대화: 도구가 필요 없는 말은 가벼운 모델로 바로 답한다 (필요하면 스스로 에이전트로 넘김)
  if (!generated && p === 'claude' && settings.get().fastLane && !needsAgent(text)) {
    try {
      job.status = 'running'
      emitJob(job)
      const ans = await fastChat.ask(withRecentDialog(text, 'fast'), (d) => send('jarvis:job-delta', { jobId: job.id, text: d }))
      if (ans !== null) {
        jobLane.set(job.id, 'fast')
        return void finishJob(job, ans)
      }
    } catch {
      /* 빠른 경로 실패 → 전체 에이전트로 */
    }
  }
  // (오래 걸릴 때 먼저 하는 대답은 음성 엔진이 알아서 — "네, 잠깐만요" → 5초 뒤 "확인하고 있어요")

  // 6) 세션별 작업 실행 → 한 답변
  const known = finder.list(settings.get().recentProjects)
  // JARVIS 가 만든 지시문(출시 플레이북 등)은 프로젝트 이름 분석 없이 현재 프로젝트에서 실행.
  // 프로젝트와 무관한 일상 행동은 빠른 모델의 일반 세션에서 (보고 있던 프로젝트 포커스는 그대로)
  let route = jobRoute(text, p, known, generated)
  // 어느 프로젝트 세션인지는 원래 문장으로 먼저 정한다 (앞 대화에 나온 프로젝트 이름에 끌려가지 않게)
  if (!route) {
    const m = mentionedProjects(text, known)
    if (m.length <= 1 && !needsPlanning(text, m)) route = { project: m[0] ?? settings.get().projectDir }
  }
  // 에이전트 세션에도 방금까지의 대화를 이어 준다 (여러 프로젝트 분배·생성된 지시문은 제외)
  const lane = `agent:${route ? (route.project ?? 'general') : 'multi'}`
  jobLane.set(job.id, lane)
  if (!generated && route) text = withRecentDialog(text, lane)
  await orch.runJob(job, text, p, known, route)

  // 7) 실행 중 인증이 끊긴 경우: 재연결 후 1회 재시도
  const authFailed = job.tasks.some((t) => t.status === 'error' && t.result && isAuthError(t.result))
  if (authFailed) {
    authCache.delete(p)
    if (!(await authStatus(p, true)).loggedIn) {
      job.tasks = []
      job.answer = undefined
      note(job, `${PROVIDER_LABEL[p]} 연결이 끊겼습니다. 다시 연결한 뒤 재시도합니다.`)
      if (await ensureConnected(job, p)) {
        for (const s of orch.list()) if (s.provider === p) orch.close(s.id)
        await orch.runJob(job, text, p, known, route)
      } else finishJob(job, `${PROVIDER_LABEL[p]} 재연결에 실패했습니다.`, 'error')
    }
  }
}

/** 권한 설정 화면은 실행당 한 번만 자동으로 연다 */
const openedPrivacy = new Set<string>()

/**
 * 앱을 JARVIS 화면 안에서 연다
 *  - 웹 버전이 있는 앱(슬랙·크롬·노션 …) → JARVIS 브라우저 팝업
 *  - 그 외(카카오톡 등) → 실제 앱을 열고, 그 창을 JARVIS 팝업에 비춘다 (팝업에서 클릭·입력 가능)
 */
async function openAppInJarvis(query: string, app: AppEntry | null, via: string): Promise<{ ok: boolean; message: string }> {
  const web = webAppUrl(query) ?? (app ? webAppUrl(app.name) : null)
  if (web) {
    await browser.open(web)
    audit.record({ action: 'system.url.open', provider: 'jarvis', target: web, detail: { query, via, inJarvis: true } })
    return { ok: true, message: `JARVIS 화면에서 ${app?.name ?? query} 을(를) 열었습니다.` }
  }
  if (!app) return { ok: false, message: `${query} 앱을 찾지 못했습니다.` }
  const r = await openApp(app)
  audit.record({ action: 'system.app.open', provider: 'jarvis', target: app.name, detail: { query, path: app.path, ok: r.ok, via, mirror: true } })
  if (!r.ok) return r
  if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
    void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture').catch(() => undefined)
    return { ok: true, message: `${app.name} 을(를) 열었어요. JARVIS 화면 안에 비춰 보이려면 "화면 및 시스템 오디오 기록"에서 JARVIS 를 허용해 주세요 (설정 화면을 열었어요).` }
  }
  send('mirror:open', { app: app.name })
  return { ok: true, message: `${app.name} 을(를) JARVIS 화면에 띄웠어요.` }
}

/** 뒤에서 하던 작업을 마치고 AI 가 낸 완료 보고 → 대화창에 JARVIS 메시지로, 말로도 알린다 */
function deliverFollowup(sessionId: string, text: string): void {
  const sess = orch.list().find((x) => x.id === sessionId)
  const job: JobInfo = { id: randomUUID(), prompt: `(${sess?.title ?? '작업'} — 뒤에서 하던 작업 완료)`, status: 'done', tasks: [], notes: [], via: 'voice', createdAt: Date.now(), answer: text }
  emitJob(job)
  send('jarvis:job-done', structuredClone(job))
  convo.record(jobToRecord(job, sess?.provider ?? settings.get().provider, 'voice'))
  jobLane.set(job.id, `agent:${sess?.projectDir ?? 'general'}`)
  rememberDialog(job)
  audit.record({ action: 'agent.followup', provider: sess?.provider ?? 'claude', project: sess?.projectDir ?? undefined, detail: { session: sess?.title, chars: text.length } })
  refreshBrain()
}

/** 방금 받아 적은 말에서 나온 문장인지 (호출어를 뺀 명령 포함) */
function heardJustNow(text: string): boolean {
  if (!lastHeard || Date.now() - lastHeard.at > 30_000) return false
  const n = (s: string): string => s.replace(/[\s.,!?]/g, '')
  return n(lastHeard.text).includes(n(text)) && n(text).length >= 2
}

/** 문맥 보정 — 바뀌면 이력·학습 샘플에 남긴다 (내 목소리 학습용 정답으로 쓰임) */
/** 들은 그대로가 JARVIS 가 아는 명령이면 바로잡지 않는다 ("음성학습 암호 정해줘" 가 "코드 수정해줘" 로 바뀐 일이 있었다) */
function isKnownCommand(text: string): boolean {
  const t = text.trim()
  return !!(
    parseVoiceLearnIntent(t) ||
    parseVoiceIntent(t) ||
    timeAnswer(t) ||
    parsePanelIntent(t) !== null ||
    parseSideIntent(t) !== null ||
    parseDeviceIntent(t) ||
    isRepeatRequest(t) ||
    parseRenameIntent(t) ||
    parseProviderIntent(t) ||
    parseReleaseIntent(t) ||
    parseSiteLoginIntent(t) ||
    parseQuitIntent(t) ||
    parseOpenIntent(t)
  )
}

async function correctHeard(raw: string, q: { question?: string; options?: string[] }): Promise<string> {
  if (!settings.get().voice.contextCorrection || !(await authStatus('claude')).loggedIn) return raw
  if (!q.options?.length && isKnownCommand(raw)) return raw
  const t0 = Date.now()
  const recent = [talk.recentText(3, settings.get().assistantName), q.question ? `${settings.get().assistantName}: ${q.question}` : ''].filter(Boolean).join('\n')
  const fixed = await corrector.correct(raw, { recent, options: q.options, lastCommand: talk.lastUser() ?? undefined, words: [...speechLex.topWords(25), ...settings.get().recentProjects.map((d) => d.split(/[\\/]/).pop() ?? '')], name: settings.get().assistantName })
  if (fixed !== raw) {
    audit.record({ action: 'voice.correct', provider: 'jarvis', detail: { heard: raw, corrected: fixed, logprob: lastHeard?.logprob, ms: Date.now() - t0 } })
    markCorrected(raw, fixed)
  }
  return fixed
}

/** 방금 말로 시작한 작업 (이어지는 말이 오면 합치려고) */
let lastVoiceJob: { job: JobInfo; at: number } | null = null

/** 요청 하나를 작업(Job)으로 시작 — 화면/음성 입력, 그리고 질문 도중 다른 요청을 하신 경우 */
function startJob(prompt: string, via: 'voice' | 'text' = 'text'): { jobId: string } {
  // 말을 잠깐 쉬었다가 이어서 한 경우: 아직 처리 중인 앞 요청을 멈추고 둘을 합쳐서 다시
  const prev = lastVoiceJob
  if (via === 'voice' && prev && Date.now() - prev.at < 15_000 && ['planning', 'running'].includes(prev.job.status) && isContinuation(prompt)) {
    const merged = `${prev.job.prompt} ${prompt}`.replace(/\s+/g, ' ').trim()
    audit.record({ action: 'agent.interrupt', provider: settings.get().provider, detail: { via: 'continuation', before: prev.job.prompt, added: prompt } })
    void orch.interruptAll()
    prev.job.notes.push('이어서 하신 말과 합쳐서 다시 처리합니다')
    finishJob(prev.job, '', 'done')
    prompt = merged
  }
  const s = settings.get()
  const job: JobInfo = { id: randomUUID(), prompt, status: 'planning', tasks: [], notes: [], via, createdAt: Date.now() }
  if (via === 'voice') lastVoiceJob = { job, at: Date.now() }
  audit.record({ action: 'agent.prompt', provider: s.provider, project: s.projectDir, detail: { prompt: prompt.slice(0, 2000), jobId: job.id, via } })
  // 응답(jobId)이 renderer 에 먼저 도착하도록 다음 틱에 시작
  setTimeout(async () => {
    // 말로 한 요청을 엔진이 자신 없게 받아 적었으면, 실행 전에 문맥으로 바로잡는다
    if (via === 'voice' && heardJustNow(prompt) && lastHeard!.logprob < CORRECT_BELOW_LOGPROB) {
      const fixed = await correctHeard(prompt, {})
      if (fixed !== prompt) {
        job.prompt = fixed
        job.notes.push(`🎙 "${prompt}" → "${fixed}" 로 알아들었습니다`)
      }
    }
    emitJob(job)
    void handleRequest(job)
      .catch((e: Error) => finishJob(job, `처리 중 오류가 발생했습니다: ${e.message}`, 'error'))
      .finally(() => {
        if (job.status !== 'done' && job.status !== 'error') finishJob(job, job.answer ?? '', 'done')
        convo.record(jobToRecord(job, settings.get().provider, via))
        rememberDialog(job)
        if (via === 'voice' && job.status === 'done' && settings.get().voice.learning) speechLex.learnWords(job.prompt)
        refreshBrain()
        send('jarvis:job-done', structuredClone(job))
        void learnFrom(job, settings.get().provider)
      })
  }, 0)
  return { jobId: job.id }
}

function registerIpc(): void {
  const h = <A extends unknown[], R>(ch: string, fn: (...a: A) => R | Promise<R>): void => {
    ipcMain.handle(ch, (_e, ...args) => fn(...(args as A)))
  }

  // ── settings / project ──
  h('settings:get', () => settings.get())
  h('settings:update', (patch: DeepPartial<JarvisSettings>) => {
    const before = settings.get()
    const next = settings.update(patch)
    if (patch.launchAtLogin !== undefined) applyLoginItem()
    if (patch.alwaysListen !== undefined || patch.keepAwake !== undefined) applyKeepAwake()
    if (patch.voice?.nativeModel && patch.voice.nativeModel !== before.voice.nativeModel) void stt.restart()
    if (patch.fastModel !== undefined || patch.assistantName !== undefined) fastChat.close()
    if (patch.assistantName !== undefined || patch.launchAtLogin !== undefined) buildTray()
    if (patch.alwaysOnTop !== undefined) win?.setAlwaysOnTop(next.alwaysOnTop)
    audit.record({ action: 'settings.changed', provider: 'jarvis', detail: { keys: Object.keys(patch), before: pick(before, Object.keys(patch)), after: pick(next, Object.keys(patch)) } })
    return next
  })
  h('project:choose', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'], title: '프로젝트 폴더 열기' })
    if (r.canceled || !r.filePaths[0]) return settings.get()
    return openProject(r.filePaths[0])
  })
  h('project:set', (dir: string | null) => (dir ? openProject(dir) : settings.update({ projectDir: null })))
  h('project:list', () => finder.list(settings.get().recentProjects))

  // ── auth ──
  h('auth:status', (p: ProviderId) => authStatus(p, true))
  h('auth:login', async (p: ProviderId) => {
    await loginProvider(p)
    return authStatus(p, true)
  })
  h('auth:logout', async (p: ProviderId) => {
    await auth.logout(p)
    if (p === 'gemini') settings.update({ geminiUseGoogleLogin: false })
    for (const s of orch.list()) if (s.provider === p) orch.close(s.id)
    audit.record({ action: 'auth.logout', provider: p })
    return authStatus(p, true)
  })
  h('auth:setKey', (p: ProviderId, key: string) => {
    secrets.set(p, key.trim())
    audit.record({ action: 'auth.apikey.set', provider: p, detail: { key: maskKey(key.trim()) } })
    return authStatus(p, true)
  })
  h('auth:clearKey', (p: ProviderId) => {
    secrets.clear(p)
    audit.record({ action: 'auth.apikey.clear', provider: p })
    return authStatus(p, true)
  })
  h('sites:list', () => sites.list())
  h('sites:login', async (q: string) => siteLogin(q))
  h('sites:logout', async (key: string) => {
    const c = sites.remove(key)
    if (c) {
      const n = await browser.logout(c.domain)
      audit.record({ action: 'auth.site.logout', provider: 'jarvis', target: c.domain, detail: { cookies: n } })
    }
    return sites.list()
  })

  // ── JARVIS 요청 ──
  h('agent:send', (prompt: string, via: 'voice' | 'text' = 'text') => startJob(prompt, via))
  h('agent:interrupt', async (via: 'click' | 'voice' = 'click', transcript?: string) => {
    const running = await orch.interruptAll()
    const s = settings.get()
    audit.record({ action: 'agent.interrupt', provider: s.provider, project: s.projectDir, detail: { via, running, ...(transcript ? { transcript: transcript.slice(0, 200) } : {}) } })
  })
  h('agent:reset', () => orch.resetAll())
  h('jarvis:history', (limit?: number) => convo.recent('job', limit ?? 30))

  // ── 세션 ──
  h('session:list', () => ({ sessions: orch.list(), focused: orch.focusedId() }))
  h('session:new', (opts: { provider?: ProviderId; projectDir?: string | null } = {}) => orch.newSession(opts.provider ?? settings.get().provider, opts.projectDir === undefined ? settings.get().projectDir : opts.projectDir, true))
  h('session:focus', (id: string) => orch.focus(id))
  h('session:close', (id: string) => orch.close(id))
  h('session:send', async (id: string, prompt: string) => {
    const s = orch.get(id)
    if (!s) throw new Error('세션이 없습니다.')
    audit.record({ action: 'agent.prompt', provider: s.provider, project: s.projectDir, detail: { prompt: prompt.slice(0, 2000), sessionId: id, direct: true } })
    void orch.runInSession(id, prompt)
    return { ok: true }
  })
  h('session:interrupt', async (id: string) => {
    // 개별 세션 중단은 전체 중단으로 대체 (provider 인스턴스는 orchestrator 내부)
    await orch.interruptAll()
    return id
  })

  // ── 승인 + 음성 승인 학습 ──
  h('approval:respond', (r: ApprovalResponse) => {
    const fn = pendingApprovals.get(r.id)
    pendingApprovals.delete(r.id)
    fn?.(r)
  })
  /** 음성 대답 판정: 학습 사전 → 규칙 → AI. AI 가 판정한 표현은 학습한다. */
  h('voice:classifyApproval', async (utterance: string, title: string, detail: string): Promise<{ decision: ApprovalDecision | null; source: string }> => {
    let decision: ApprovalDecision | null = null
    let source = 'unclear'
    const learned = lexicon.lookup(utterance)
    if (learned) {
      decision = learned.decision
      source = `learned:${learned.source}`
    } else {
      decision = ruleApproval(utterance)
      if (decision) source = 'rule'
      else {
        const p = settings.get().provider
        if ((await authStatus(p)).loggedIn) {
          try {
            decision = parseClassification(await oneShot(p, classifyApprovalPrompt(title, detail, utterance), workspaceDir(), auth.envFor(p), sideModel(p)))
            if (decision) {
              source = 'ai'
              const e = lexicon.learn(utterance, decision, 'ai')
              if (e) {
                audit.record({ action: 'lexicon.learn', provider: 'jarvis', target: e.phrase, detail: { example: e.example, decision: e.decision, source: 'ai' } })
                send('lexicon:changed', lexicon.list())
              }
            }
          } catch {
            /* unclear */
          }
        }
      }
    }
    convo.record({ type: 'approval-utterance', ts: new Date().toISOString(), title, utterance, decision: decision ?? 'unclear', source })
    return { decision, source }
  })
  /** 사용자가 애매했던 음성 대답 뒤에 버튼으로 결정 → 그 표현을 학습 */
  h('voice:learnApproval', (utterance: string, decision: ApprovalDecision) => {
    const e = lexicon.learn(utterance, decision, 'user')
    if (e) {
      audit.record({ action: 'lexicon.learn', provider: 'jarvis', target: e.phrase, detail: { example: e.example, decision, source: 'user' } })
      send('lexicon:changed', lexicon.list())
    }
    return e
  })

  // ── 되묻기 ──
  h('question:answer', async (id: string, value: string | null) => {
    const q = asker.list().find((x) => x.id === id)
    // 말로 한 대답이고 선택지로 바로 안 풀리면, 문맥(질문·선택지)으로 바로잡아 본다
    if (value && q && q.kind !== 'secret' && q.kind !== 'code' && heardJustNow(value)) {
      const needs = q.options?.length ? !resolveChoice(value, q.options) : lastHeard!.logprob < CORRECT_BELOW_LOGPROB
      if (needs) value = await correctHeard(value, { question: q.text, options: q.options })
    }
    return asker.answer(id, value)
  })
  h('question:list', () => asker.list())
  // ── 네이티브 음성 인식 ──
  h('stt:status', () => ({ available: stt.available, ...stt.state }))
  h('stt:start', () => stt.start())
  h('stt:transcribe', async (buf: ArrayBuffer) => {
    const d = await stt.transcribeDetailed(new Float32Array(buf), questionPrompt() + vocabPrompt())
    const heard = d.text
    lastHeard = { text: heard, logprob: d.logprob, at: Date.now() }
    // 전에 잘못 알아들었다가 바로잡은 말이면, 배운 대로 고친다
    const fixed = settings.get().voice.learning ? speechLex.fix(heard) : null
    return fixed ?? heard
  })
  // ── 앱 비춰 보기 ──
  h('mirror:windows', (app: string) => appWindows(app))
  h('mirror:bounds', (app: string, title: string) => windowBounds(app, title))
  h('mirror:click', async (app: string, title: string, rx: number, ry: number, o: { double?: boolean; right?: boolean } = {}) => {
    const r = await mirrorClick(app, title, rx, ry, o)
    audit.record({ action: 'mirror.click', provider: 'jarvis', target: app, detail: { title, rx: Math.round(rx * 1000) / 1000, ry: Math.round(ry * 1000) / 1000, ...o, ok: r.ok } })
    // 누른 뒤 JARVIS 를 다시 앞으로 (비춰 보는 화면이 가려지지 않게)
    setTimeout(() => showWindow(), 250)
    return r
  })
  h('mirror:type', async (app: string, text: string, enter: boolean) => {
    const r = await mirrorType(app, text, enter, { read: () => clipboard.readText(), write: (t) => clipboard.writeText(t) })
    audit.record({ action: 'mirror.type', provider: 'jarvis', target: app, detail: { chars: text.length, enter } })
    setTimeout(() => showWindow(), 250)
    return r
  })
  h('tts:speak', async (text: string) => {
    const id = settings.get().voice.ttsVoiceId
    if (!voiceById(id)) return null
    try {
      const b = await tts.speak(id, text)
      return b ? b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) : null
    } catch (e) {
      send('tts:state', { engine: voiceById(id)!.engine, state: 'error', message: `${(e as Error).message} — 기본 목소리로 읽습니다` })
      return null
    }
  })
  h('tts:preview', async (voiceId: string) => {
    const b = await tts.speak(voiceId, `안녕하세요, ${settings.get().assistantName}입니다. 이 목소리는 어떠세요?`)
    return b ? b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) : null
  })
  h('tts:voices', () => {
    const fav = settings.get().voice.ttsFavorites
    const ok = enginesFor(process.platform, process.arch)
    return [
      { id: 'system', engine: 'system', label: '기본 목소리', desc: '운영체제 목소리 (아래 "운영체제 목소리"에서 고름)', installed: true, favorite: fav.includes('system') },
      ...VOICE_CATALOG.filter((v) => ok.includes(v.engine)).map((v) => ({ ...v, installed: tts.installed(v.engine), favorite: fav.includes(v.id) }))
    ]
  })
  h('tts:use', (voiceId: string) => useVoice(voiceId))
  h('tts:favorite', (voiceId: string, on: boolean) => {
    const before = settings.get().voice.ttsFavorites
    const next = on ? [...new Set([...before, voiceId])] : before.filter((x) => x !== voiceId)
    send('settings:changed', settings.update({ voice: { ttsFavorites: next } }))
    audit.record({ action: 'settings.changed', provider: 'jarvis', detail: { keys: ['voice'], before: { ttsFavorites: before }, after: { ttsFavorites: next }, via: 'favorite' } })
    return next
  })
  h('stt:sample', (x: { heard: string; packets: ArrayBuffer[]; sampleRate: number; device?: string }) => {
    if (!settings.get().voice.learning || !vault.ready) return
    // 인증번호·비밀번호를 묻는 중엔 말소리를 절대 저장하지 않는다
    if (asker.list().some((q) => q.kind === 'secret' || q.kind === 'code')) return
    holdSample({ ts: Date.now(), heard: x.heard, logprob: lastHeard && lastHeard.text === x.heard ? lastHeard.logprob : undefined, packets: x.packets.map((b) => new Uint8Array(b)), sampleRate: x.sampleRate, device: x.device })
  })
  h('voice:report', (list: Array<{ name: string; lang: string }>) => {
    // 예전 버그로 목소리 이름 자리에 엉뚱한 말이 저장돼 있으면 기본 목소리로 되돌린다
    const cur = settings.get().voice.ttsVoice
    if (cur && list.length && !list.some((x) => x.name === cur)) {
      const next = settings.update({ voice: { ttsVoice: null } })
      send('settings:changed', next)
      audit.record({ action: 'settings.changed', provider: 'jarvis', detail: { keys: ['voice'], before: { ttsVoice: cur }, after: { ttsVoice: null }, via: 'invalid-voice-reset' } })
    }
  })

  // ── 내장 브라우저 ──
  h('browser:bounds', (rect: { x: number; y: number; width: number; height: number } | null) => browser.setBounds(rect))
  h('browser:navigate', (url: string) => browser.open(url))
  h('browser:back', () => browser.back())
  h('browser:forward', () => browser.forward())
  h('browser:reload', () => browser.reload())
  h('browser:close', () => browser.close())
  h('browser:state', () => browser.state())

  // ── 에뮬레이터 ──
  h('device:start', (platform?: Platform, name?: string) => startDevice(platform, name))
  h('device:stop', () => stopDevice())
  h('device:stream', (on: boolean) => {
    if (on && devices.active) streamDevice()
    else void devices.stopStream()
  })
  h('device:tap', (x: number, y: number) => devices.tap(x, y))
  h('device:swipe', (x1: number, y1: number, x2: number, y2: number) => devices.swipe(x1, y1, x2, y2))
  h('device:key', (k: string) => devices.key(k))
  h('device:text', (t: string) => devices.type(t))
  h('device:choices', () => devices.choices())
  h('device:startChoice', async (platform: Platform, id: string) => {
    const c = (await devices.choices(platform)).find((x) => x.id === id)
    return c ? startDevice(platform, c.label) : '기기를 찾지 못했습니다.'
  })

  // ── 기억 ──
  h('memory:list', () => ({ items: memory.list(), lexicon: lexicon.list(), conversations: convo.count(), path: convo.path }))
  h('memory:delete', (id: string) => {
    const m = memory.remove(id)
    if (m) audit.record({ action: 'memory.delete', provider: 'jarvis', target: id, detail: { text: m.text } })
    return memory.list()
  })
  h('memory:add', (text: string) => {
    const added = memory.add([{ text, category: 'fact' }], 'user')
    for (const m of added) audit.record({ action: 'memory.add', provider: 'jarvis', target: m.id, detail: { text: m.text, source: 'user' } })
    return memory.list()
  })
  h('lexicon:delete', (phrase: string) => {
    if (lexicon.remove(phrase)) audit.record({ action: 'lexicon.delete', provider: 'jarvis', target: phrase })
    return lexicon.list()
  })

  // ── git (포커스된 세션의 프로젝트) ──
  h('git:status', () => gitSvc.status(cwd()))
  h('git:diff', (opts: { path?: string; staged?: boolean }) => gitSvc.diff(cwd(), opts))
  h('git:log', (n?: number) => gitSvc.log(cwd(), n))
  h('git:stage', async (paths: string[]) => {
    const r = await gitSvc.stage(cwd(), paths)
    audit.record({ action: 'git.stage', provider: 'jarvis', project: cwd(), detail: { paths, code: r.code } })
    return r
  })
  h('git:unstage', async (paths: string[]) => {
    const r = await gitSvc.unstage(cwd(), paths)
    audit.record({ action: 'git.unstage', provider: 'jarvis', project: cwd(), detail: { paths, code: r.code } })
    return r
  })
  h('git:commit', async (message: string) => {
    const r = await gitSvc.commit(cwd(), message)
    if (r.approved) audit.record({ action: 'git.commit', provider: 'jarvis', project: cwd(), target: r.hash, detail: { message, code: r.code, stderr: r.stderr.slice(0, 500) } })
    return r
  })
  h('git:push', async () => {
    const r = await gitSvc.push(cwd())
    if (r.approved) audit.record({ action: 'git.push', provider: 'jarvis', project: cwd(), detail: { code: r.code, out: (r.stdout + r.stderr).slice(0, 1000) } })
    return r
  })
  h('git:suggestMessage', async () => {
    const dir = cwd()
    const diff = (await gitSvc.diff(dir, { staged: true })) || (await gitSvc.diff(dir))
    if (!diff.trim()) throw new Error('변경 사항이 없습니다.')
    return ask(settings.get().provider, commitMessagePrompt(diff))
  })

  // ── audit ──
  h('audit:list', (opts: { limit?: number; action?: string; project?: string }) => audit.list(opts))
  h('audit:path', () => audit.path)

  // ── window / media ──
  h('media:request', async (kind: 'camera' | 'microphone') => {
    if (process.platform !== 'darwin') return true
    if (systemPreferences.getMediaAccessStatus(kind) === 'granted') return true
    const ok = await systemPreferences.askForMediaAccess(kind)
    // 이미 거부된 상태면 macOS 가 다시 묻지 않는다 → 설정 화면을 한 번 열어 준다
    if (!ok && !openedPrivacy.has(kind)) {
      openedPrivacy.add(kind)
      audit.record({ action: 'system.permission.missing', provider: 'jarvis', target: kind, detail: { status: systemPreferences.getMediaAccessStatus(kind) } })
      void shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${kind === 'microphone' ? 'Privacy_Microphone' : 'Privacy_Camera'}`).catch(() => undefined)
    }
    return ok
  })
  h('win:minimize', () => win?.minimize())
  h('win:toggleMaximize', () => (win?.isMaximized() ? win.unmaximize() : win?.maximize()))
  h('win:close', () => win?.close())
  // 호출되면 잠든 화면도 깨운다
  h('win:summon', () => {
    wakeDisplay()
    showWindow()
  })
  h('power:status', async () => ({ clamshell: await isClamshell(), keepAwake: keepAwake.active }))
  h('app:info', () => ({ platform: process.platform, version: app.getVersion(), userData: app.getPath('userData'), cwd: cwd() }))
}

function pick(o: object, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of keys) out[k] = (o as Record<string, unknown>)[k]
  return out
}

function createWindow(): void {
  const s = settings.get()
  win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1040,
    minHeight: 660,
    backgroundColor: '#02070d',
    frame: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    titleBarOverlay: process.platform === 'win32' ? { color: '#02070d', symbolColor: '#7fe9ff', height: 36 } : undefined,
    alwaysOnTop: s.alwaysOnTop,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
      // 창이 숨겨져 있어도 마이크 대기/음성 인식이 멈추지 않게
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  // 로그인 시 자동 실행이면 숨김 상태로 시작 (호출어로 부르면 뜬다)
  win.once('ready-to-show', () => {
    if (!startHidden) win?.show()
  })
  // 창을 닫아도 종료하지 않고 뒤에서 계속 듣는다 (완전 종료는 트레이/메뉴의 "종료")
  win.on('close', (e) => {
    if (quitting) return
    e.preventDefault()
    win?.hide()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  win.on('closed', () => {
    win = null
    for (const [id, r] of pendingApprovals) r({ id, approved: false, reason: 'window closed' })
    pendingApprovals.clear()
  })
}

// 두 번 실행하면 기존 창을 띄운다
if (!app.requestSingleInstanceLock()) app.quit()
else app.on('second-instance', () => showWindow())

app.whenReady().then(() => {
  const ud = app.getPath('userData')
  settings = new SettingsStore(join(ud, 'settings.json'))
  audit = new AuditLog(join(ud, 'audit', 'audit.jsonl'), app.getVersion())
  secrets = new SecretStore(join(ud, 'secrets.json'), safeStorage)
  auth = new AuthService(secrets, { geminiUseGoogleLogin: () => settings.get().geminiUseGoogleLogin })
  gitSvc = new GitService(async (req) => (await requestApproval({ ...req, provider: 'jarvis' }, cwd())).approved)
  convo = new ConversationLog(join(ud, 'memory', 'conversations.jsonl'))
  // 음성 학습 — 숨김 폴더(.voice). 말소리는 사용자 암호(공개키)로, 말투는 키체인으로 잠근다
  vault = new VoiceVault(join(ud, '.voice'), () => Math.max(20, settings.get().voice.learnLimitMB) * 1024 * 1024)
  speechLex = new SpeechLexicon(join(ud, '.voice', 'lexicon.bin'), {
    encrypt: (x) => safeStorage.encryptString(x),
    decrypt: (b) => safeStorage.decryptString(b),
    available: () => safeStorage.isEncryptionAvailable()
  })
  memory = new MemoryStore(join(ud, 'memory', 'memory.json'))
  lexicon = new ApprovalLexicon(join(ud, 'memory', 'approval-lexicon.json'))
  sites = new SiteStore(join(ud, 'sites.json'))
  orch = buildOrchestrator()
  // 이전에 열려 있던 프로젝트로 첫 세션 준비
  const s0 = settings.get()
  orch.sessionFor(s0.provider, s0.projectDir, true)
  trainer = new VoiceTrainer(join(ud, 'learn'), app.isPackaged ? join(process.resourcesPath, 'learn') : join(app.getAppPath(), 'resources', 'learn'), (p) => send('tts:state', { engine: 'learn', state: p.stage === 'done' ? 'ready' : p.stage === 'error' ? 'error' : 'installing', message: p.message }))
  tts = new TtsHub(ud, app.isPackaged ? join(process.resourcesPath, 'tts') : join(app.getAppPath(), 'resources', 'tts'), (st) => send('tts:state', st))
  corrector = new SpeechCorrector({ env: () => auth.envFor('claude'), model: () => settings.get().fastModel || 'sonnet', cwd: () => workspaceDir() })
  fastChat = new FastChat({
    env: () => auth.envFor('claude'),
    name: () => settings.get().assistantName,
    memory: () => memoryText(),
    model: () => settings.get().fastModel,
    cwd: () => workspaceDir()
  })
  stt = new NativeStt({
    binary: sttBinaryPath(app.getAppPath(), process.resourcesPath, app.isPackaged),
    modelsDir: join(ud, 'models'),
    modelKey: () => (MODELS[settings.get().voice.nativeModel] ? settings.get().voice.nativeModel : 'small'),
    onState: (st) => send('stt:state', { available: stt.available, ...st })
  })
  // 항상 듣기면 음성 엔진(모델 다운로드 포함)을 미리 준비
  if (s0.alwaysListen) void stt.start()
  // 첫 대답이 느리지 않도록 AI 프로세스를 미리 띄워 둔다 (로그인되어 있을 때만)
  setTimeout(() => {
    void authStatus('claude').then((st) => {
      if (!st.loggedIn) return
      fastChat.warm()
      if (settings.get().voice.contextCorrection) corrector.warm()
      // 고른 목소리 엔진도 미리 올려 둔다 (첫 대답이 늦지 않게)
      void tts.warm(settings.get().voice.ttsVoiceId).catch(() => undefined)
      orch.prewarm()
      // 일상 행동용 일반 세션도 미리 띄워 둔다
      if (settings.get().actionModel && settings.get().provider === 'claude') orch.prewarmFor('claude', null)
    })
  }, 1500)

  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media' || permission === 'clipboard-sanitized-write'))
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media')

  registerIpc()
  createWindow()
  buildTray()
  applyLoginItem()
  applyKeepAwake()
  // 잠자기에서 깨어나거나 잠금 해제되면 마이크를 다시 연결 (장치가 바뀌었을 수 있음)
  powerMonitor.on('resume', () => send('voice:restart', { reason: 'resume' }))
  powerMonitor.on('unlock-screen', () => send('voice:restart', { reason: 'unlock' }))
  // 프로젝트 후보 스캔을 미리 해 둔다 (첫 "열어줘" 응답 지연 방지)
  setTimeout(() => finder.list(), 4000)

  globalShortcut.register('CommandOrControl+Shift+J', () => {
    showWindow()
    send('jarvis:summon', {})
  })

  app.on('activate', () => showWindow())
})

app.on('before-quit', () => {
  quitting = true
})
app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  asker.cancelAll()
  stt?.stop()
  tts?.stop()
  keepAwake.set(false)
  fastChat?.close()
  void devices.stopStream()
})
// 창이 없어도(숨김) 트레이에서 계속 실행 — 종료는 트레이 메뉴의 "종료"
app.on('window-all-closed', () => undefined)

export type { SessionInfo, AgentEvent }
