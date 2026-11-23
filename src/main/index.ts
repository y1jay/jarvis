import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Notification, safeStorage, session, shell, systemPreferences } from 'electron'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AuditLog } from './audit'
import { SettingsStore, type DeepPartial } from './settings'
import { SecretStore, maskKey } from './secrets'
import { AuthService } from './auth'
import { GitService } from './git'
import { ClaudeProvider } from './providers/claude'
import { CodexProvider } from './providers/codex'
import { GeminiProvider } from './providers/gemini'
import type { AgentProvider } from './providers/types'
import { oneShot, commitMessagePrompt } from './oneshot'
import { parseOpenIntent, pickProjectPrompt, ProjectFinder, resolveProject } from './projects'
import { listApps, openApp, openUrl, parseQuitIntent, quitApp, resolveApp, resolveFolder, resolveSite, revealPath, type AppEntry } from './system'
import { createJarvisTools, JARVIS_TOOL_NAMES } from './jarvisTools'
import { Orchestrator } from './orchestrator'
import { ApprovalLexicon, ConversationLog, extractMemoryPrompt, jobToRecord, MemoryStore, parseMemoryExtraction } from './memory'
import { JarvisBrowser, resolveSiteDef, SiteStore } from './browser'
import { isAuthError, parseProviderIntent, parseSiteLoginIntent, parseVoiceIntent, splitTargets } from './intents'
import { Asker, resolveChoice, type QuestionKind } from './asker'
import { DeviceHub, parseDeviceIntent, type Platform } from './devices'
import { androidReleasePlaybook, parseReleaseIntent } from './release'
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
// ── E2E / 테스트용 격리 ─────────────────────────────────────────
if (process.env.JARVIS_USER_DATA) app.setPath('userData', process.env.JARVIS_USER_DATA)
if (process.env.JARVIS_E2E === '1') {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream')
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
  if (process.env.JARVIS_FAKE_AUDIO) {
    app.commandLine.appendSwitch('use-file-for-fake-audio-capture', process.env.JARVIS_FAKE_AUDIO)
    // 샌드박스된 오디오 서비스는 임의 경로 파일을 못 읽으므로 테스트에서만 in-process 로
    app.commandLine.appendSwitch('disable-features', 'AudioServiceOutOfProcess,AudioServiceSandbox')
  }
}

let win: BrowserWindow | null = null
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
const browser = new JarvisBrowser({
  window: () => win,
  requestShow: () => send('popup:open', 'browser'),
  onState: (st) => send('browser:state', st)
})
const devices = new DeviceHub()
let voices: Array<{ name: string; lang: string }> = []
const asker = new Asker({
  show: (q) => {
    if (!win || win.isDestroyed()) return false
    send('jarvis:question', q)
    if (q.kind !== 'secret') send('jarvis:speak', q.options?.length ? `${q.text} ${q.options.map((o, i) => `${i + 1}번 ${o}`).join(', ')}` : q.text)
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
async function askUser(question: string, opts: { kind?: QuestionKind; options?: string[]; from?: string; strict?: boolean } = {}): Promise<string | null> {
  const a = await asker.ask(question, opts)
  if (a === null || !opts.options?.length) return a
  const c = resolveChoice(a, opts.options)
  if (c) return c
  // AI 가 물은 질문이면 자연어 답을 그대로 넘긴다 (AI 가 해석). JARVIS 자체 선택지(목소리/기기 등)는 다시 묻는다.
  if (!opts.strict) return a
  const again = await asker.ask(`"${a}" 를 이해하지 못했습니다. ${question}`, opts)
  return again === null ? null : (resolveChoice(again, opts.options) ?? again)
}

const PLATFORM_LABEL: Record<Platform, string> = { ios: '아이폰 시뮬레이터', android: '안드로이드 에뮬레이터' }

function streamDevice(): void {
  devices.startStream((png, size) => send('device:frame', { data: png.toString('base64'), size, platform: devices.active }))
}

/** 기기 실행: 플랫폼/기기를 모르면 물어보고, 화면은 JARVIS 팝업으로 */
async function startDevice(platform?: Platform, name?: string): Promise<string> {
  if (!platform) {
    const opts = [...(process.platform === 'darwin' ? [PLATFORM_LABEL.ios] : []), PLATFORM_LABEL.android]
    const a = opts.length === 1 ? opts[0] : await askUser('어떤 기기를 띄울까요?', { options: opts, strict: true })
    if (!a) return '기기 실행을 취소했습니다.'
    platform = a === PLATFORM_LABEL.ios ? 'ios' : 'android'
  }
  const choices = await devices.choices(platform)
  if (!choices.length) return platform === 'ios' ? 'iOS 시뮬레이터가 없습니다. Xcode 를 설치하거나 시뮬레이터를 만들어 주세요.' : 'AVD 가 없습니다. Android Studio 의 Device Manager 에서 가상 기기를 먼저 만들어 주세요.'
  let c = name ? devices.match(choices, name) : null
  if (!c) {
    if (choices.length === 1) c = choices[0]
    else {
      const ans = await askUser(`어떤 ${PLATFORM_LABEL[platform]}를 띄울까요?`, { options: choices.map((x) => x.label), strict: true })
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

function memoryText(): string {
  return settings.get().learning.enabled ? memory.asPrompt() : ''
}

function ask(p: ProviderId, prompt: string): Promise<string> {
  const mem = memoryText()
  return oneShot(p, mem ? `${mem}\n\n${prompt}` : prompt, workspaceDir(), auth.envFor(p), settings.model(p))
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
    // E2E 전용: 실제 브라우저 로그인 대신 실패 시뮬레이션
    const fake = process.env.JARVIS_E2E === '1' && (process.env.JARVIS_FAKE_LOGIN_FAIL ?? '').split(',').includes(p)
    const ok = fake ? await new Promise<boolean>((r) => setTimeout(() => r(false), 300)) : await auth.login(p, (line) => send('auth:log', { provider: p, line }))
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
    stopDevice: () => stopDevice()
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
        model: settings.model(s.provider),
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
    const raw = await oneShot(p, extractMemoryPrompt(job.prompt, job.answer, memory.list()), workspaceDir(), auth.envFor(p), settings.model(p))
    const added = memory.add(parseMemoryExtraction(raw), job.id)
    for (const m of added) audit.record({ action: 'memory.add', provider: 'jarvis', target: m.id, detail: { text: m.text, category: m.category, source: job.id } })
    if (added.length) send('memory:changed', memory.list())
  } catch {
    /* 학습 실패는 무시 */
  }
}

/** renderer 가 아직 목소리 목록을 못 보냈을 때 OS 에서 직접 읽는다 */
async function osVoices(): Promise<Array<{ name: string; lang: string }>> {
  const { execFile } = await import('node:child_process')
  const run = (cmd: string, args: string[]): Promise<string> => new Promise((r) => execFile(cmd, args, { windowsHide: true, timeout: 10000 }, (_e, out) => r(String(out ?? ''))))
  if (process.platform === 'darwin') {
    // "Yuna                ko_KR    # 안녕하세요…"
    return (await run('say', ['-v', '?']))
      .split('\n')
      .map((l) => /^(.+?)\s{2,}([a-z]{2}_[A-Z]{2})\s+#/.exec(l))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => ({ name: m[1].trim(), lang: m[2].replace('_', '-') }))
  }
  if (process.platform === 'win32') {
    const out = await run('powershell.exe', ['-NoProfile', '-Command', 'Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | % { $_.VoiceInfo.Name + "|" + $_.VoiceInfo.Culture.Name }'])
    return out.split(/\r?\n/).filter((l) => l.includes('|')).map((l) => ({ name: l.split('|')[0].trim(), lang: l.split('|')[1].trim() }))
  }
  return []
}

/** 목소리 바꾸기: 사용 가능한 목소리를 알려주고 고르게 한다 */
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
  if (!voices.length) voices = await osVoices()
  const ko = voices.filter((x) => x.lang.toLowerCase().replace('_', '-').startsWith('ko'))
  const others = voices.filter((x) => x.lang.toLowerCase().startsWith('en')).slice(0, 6)
  const DOWNLOAD = '목소리 더 내려받기'
  const options = [...ko.map((x) => x.name), ...others.map((x) => `${x.name} (영어)`), DOWNLOAD]
  if (options.length === 1) return openDownload()
  const cur = v.ttsVoice ?? ko[0]?.name ?? '기본'
  const ans = await askUser(`지금은 ${cur} 목소리입니다. 어떤 목소리로 바꿀까요?${ko.length <= 1 ? ' 한국어 목소리는 지금 하나뿐이라, 더 내려받을 수도 있습니다.' : ''}`, { options, from: 'JARVIS', strict: true })
  if (!ans) return '목소리 변경을 취소했습니다.'
  if (ans === DOWNLOAD) return openDownload()
  const name = ans.replace(/ \(영어\)$/, '')
  apply({ ttsVoice: name }, '')
  send('jarvis:speak', name.match(/[a-z]/i) && !ko.some((x) => x.name === name) ? 'Hello, this is my new voice.' : '이 목소리로 말씀드리겠습니다.')
  return `목소리를 ${name} 으로 바꿨습니다. 속도나 높낮이도 "좀 더 빠르게", "더 낮게"처럼 말씀하시면 조정합니다.`
}

/** 요청 처리: 로컬 명령 → 모델 연결 확인 → 오케스트레이터 → 학습 */
async function handleRequest(job: JobInfo): Promise<void> {
  const prompt = job.prompt
  let p = settings.get().provider
  let text = prompt
  /** true 면 text 는 JARVIS 가 만든 지시문 → 아래 로컬 명령 해석(사이트/앱/열기)을 건너뛴다 */
  let generated = false

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
    const a = resolveApp(quit.target, listApps())
    if (a) {
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
          const res = await openApp(target.app)
          audit.record({ action: 'system.app.open', provider: 'jarvis', target: target.app.name, detail: { query: intent.query, path: target.app.path, ok: res.ok, via: 'command' } })
          note(job, `▶ ${res.message}`)
          if (!res.ok) return void finishJob(job, `${target.app.name} 실행에 실패했습니다: ${res.message}`, 'error')
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

  // 6) 세션별 작업 실행 → 한 답변
  const known = finder.list(settings.get().recentProjects)
  // JARVIS 가 만든 지시문(출시 플레이북 등)은 프로젝트 이름 분석 없이 현재 프로젝트에서 실행
  await orch.runJob(job, text, p, known, generated ? { project: settings.get().projectDir } : undefined)

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
        await orch.runJob(job, text, p, known, generated ? { project: settings.get().projectDir } : undefined)
      } else finishJob(job, `${PROVIDER_LABEL[p]} 재연결에 실패했습니다.`, 'error')
    }
  }
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
  h('agent:send', (prompt: string, via: 'voice' | 'text' = 'text') => {
    const s = settings.get()
    const job: JobInfo = { id: randomUUID(), prompt, status: 'planning', tasks: [], notes: [], via, createdAt: Date.now() }
    audit.record({ action: 'agent.prompt', provider: s.provider, project: s.projectDir, detail: { prompt: prompt.slice(0, 2000), jobId: job.id, via } })
    // 응답(jobId)이 renderer 에 먼저 도착하도록 다음 틱에 시작
    setTimeout(() => {
      emitJob(job)
      void handleRequest(job)
        .catch((e: Error) => finishJob(job, `처리 중 오류가 발생했습니다: ${e.message}`, 'error'))
        .finally(() => {
          if (job.status !== 'done' && job.status !== 'error') finishJob(job, job.answer ?? '', 'done')
          convo.record(jobToRecord(job, settings.get().provider, via))
          send('jarvis:job-done', structuredClone(job))
          void learnFrom(job, settings.get().provider)
        })
    }, 0)
    return { jobId: job.id }
  })
  h('agent:interrupt', () => orch.interruptAll())
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
            decision = parseClassification(await oneShot(p, classifyApprovalPrompt(title, detail, utterance), workspaceDir(), auth.envFor(p), settings.model(p)))
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
  h('question:answer', (id: string, value: string | null) => asker.answer(id, value))
  h('question:list', () => asker.list())
  h('voice:report', (list: Array<{ name: string; lang: string }>) => {
    voices = list
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
    return systemPreferences.askForMediaAccess(kind)
  })
  h('win:minimize', () => win?.minimize())
  h('win:toggleMaximize', () => (win?.isMaximized() ? win.unmaximize() : win?.maximize()))
  h('win:close', () => win?.close())
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
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.once('ready-to-show', () => win?.show())
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

app.whenReady().then(() => {
  const ud = app.getPath('userData')
  settings = new SettingsStore(join(ud, 'settings.json'))
  audit = new AuditLog(join(ud, 'audit', 'audit.jsonl'), app.getVersion())
  secrets = new SecretStore(join(ud, 'secrets.json'), safeStorage)
  auth = new AuthService(secrets, { geminiUseGoogleLogin: () => settings.get().geminiUseGoogleLogin })
  gitSvc = new GitService(async (req) => (await requestApproval({ ...req, provider: 'jarvis' }, cwd())).approved)
  convo = new ConversationLog(join(ud, 'memory', 'conversations.jsonl'))
  memory = new MemoryStore(join(ud, 'memory', 'memory.json'))
  lexicon = new ApprovalLexicon(join(ud, 'memory', 'approval-lexicon.json'))
  sites = new SiteStore(join(ud, 'sites.json'))
  orch = buildOrchestrator()
  // 이전에 열려 있던 프로젝트로 첫 세션 준비
  const s0 = settings.get()
  orch.sessionFor(s0.provider, s0.projectDir, true)

  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media' || permission === 'clipboard-sanitized-write'))
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media')

  registerIpc()
  createWindow()
  // 프로젝트 후보 스캔을 미리 해 둔다 (첫 "열어줘" 응답 지연 방지)
  setTimeout(() => finder.list(), 4000)

  globalShortcut.register('CommandOrControl+Shift+J', () => {
    if (!win) createWindow()
    win?.show()
    win?.focus()
    send('jarvis:summon', {})
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  asker.cancelAll()
  void devices.stopStream()
})
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

export type { SessionInfo, AgentEvent }
