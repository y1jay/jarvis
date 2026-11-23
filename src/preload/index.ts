import { contextBridge, ipcRenderer } from 'electron'
import type {
  JobInfo,
  LexiconEntry,
  MemoryItem,
  SessionInfo,
  AgentEventEnvelope,
  ApprovalRequest,
  ApprovalResponse,
  AuditEntry,
  AuthStatus,
  GitCommitInfo,
  GitStatus,
  JarvisSettings,
  ProviderId
} from '../shared/types'

const invoke = <T>(ch: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(ch, ...args)
function on<T>(ch: string, cb: (p: T) => void): () => void {
  const fn = (_e: unknown, p: T): void => cb(p)
  ipcRenderer.on(ch, fn)
  return () => ipcRenderer.removeListener(ch, fn)
}

interface GitResult {
  code: number
  stdout: string
  stderr: string
  approved?: boolean
  hash?: string
}

const api = {
  settings: {
    get: () => invoke<JarvisSettings>('settings:get'),
    update: (patch: unknown) => invoke<JarvisSettings>('settings:update', patch),
    onChanged: (cb: (s: JarvisSettings) => void) => on('settings:changed', cb)
  },
  project: {
    choose: () => invoke<JarvisSettings>('project:choose'),
    set: (dir: string | null) => invoke<JarvisSettings>('project:set', dir),
    list: () => invoke<string[]>('project:list')
  },
  auth: {
    status: (p: ProviderId) => invoke<AuthStatus>('auth:status', p),
    login: (p: ProviderId) => invoke<AuthStatus>('auth:login', p),
    logout: (p: ProviderId) => invoke<AuthStatus>('auth:logout', p),
    setKey: (p: ProviderId, key: string) => invoke<AuthStatus>('auth:setKey', p, key),
    clearKey: (p: ProviderId) => invoke<AuthStatus>('auth:clearKey', p),
    onLog: (cb: (p: { provider: ProviderId; line: string }) => void) => on('auth:log', cb),
    onChanged: (cb: (s: AuthStatus) => void) => on('auth:changed', cb)
  },
  agent: {
    send: (prompt: string, via: 'voice' | 'text' = 'text') => invoke<{ jobId: string }>('agent:send', prompt, via),
    interrupt: (via: 'click' | 'voice' = 'click', transcript?: string) => invoke<void>('agent:interrupt', via, transcript),
    reset: () => invoke<void>('agent:reset'),
    onEvent: (cb: (e: AgentEventEnvelope) => void) => on('agent:event', cb),
    onTurnStart: (cb: (e: { turnId: string; sessionId: string; provider: ProviderId; prompt: string; jobId?: string }) => void) => on('agent:turn-start', cb),
    onDone: (cb: (e: { turnId: string; sessionId: string; provider: ProviderId }) => void) => on('agent:done', cb)
  },
  jarvis: {
    onJob: (cb: (j: JobInfo) => void) => on('jarvis:job', cb),
    onJobDone: (cb: (j: JobInfo) => void) => on('jarvis:job-done', cb),
    onJobDelta: (cb: (d: { jobId: string; text: string }) => void) => on('jarvis:job-delta', cb),
    onSpeak: (cb: (text: string) => void) => on('jarvis:speak', cb),
    history: (limit?: number) => invoke<Array<{ type: 'job'; ts: string; jobId: string; prompt: string; answer: string; status: string; via: string; tasks: Array<{ title: string; sessionId: string; status: string; instruction: string }> }>>('jarvis:history', limit)
  },
  session: {
    list: () => invoke<{ sessions: SessionInfo[]; focused: string | null }>('session:list'),
    create: (opts: { provider?: ProviderId; projectDir?: string | null } = {}) => invoke<SessionInfo>('session:new', opts),
    focus: (id: string) => invoke<SessionInfo | null>('session:focus', id),
    close: (id: string) => invoke<void>('session:close', id),
    send: (id: string, prompt: string) => invoke<{ ok: boolean }>('session:send', id, prompt),
    onList: (cb: (p: { sessions: SessionInfo[]; focused: string | null }) => void) => on('session:list', cb)
  },
  memory: {
    list: () => invoke<{ items: MemoryItem[]; lexicon: LexiconEntry[]; conversations: number; path: string }>('memory:list'),
    remove: (id: string) => invoke<MemoryItem[]>('memory:delete', id),
    add: (text: string) => invoke<MemoryItem[]>('memory:add', text),
    removePhrase: (phrase: string) => invoke<LexiconEntry[]>('lexicon:delete', phrase),
    onChanged: (cb: () => void) => {
      const a = on('memory:changed', cb)
      const b = on('lexicon:changed', cb)
      return () => {
        a()
        b()
      }
    }
  },
  question: {
    onAsk: (cb: (q: { id: string; text: string; kind: 'choice' | 'text' | 'secret' | 'code'; options?: string[]; from?: string; createdAt: number }) => void) => on('jarvis:question', cb),
    onDone: (cb: (id: string) => void) => on('jarvis:question-done', cb),
    answer: (id: string, value: string | null) => invoke<boolean>('question:answer', id, value),
    list: () => invoke<Array<{ id: string; text: string; kind: 'choice' | 'text' | 'secret' | 'code'; options?: string[]; from?: string; createdAt: number }>>('question:list')
  },
  browser: {
    setBounds: (r: { x: number; y: number; width: number; height: number } | null) => invoke<void>('browser:bounds', r),
    navigate: (url: string) => invoke<unknown>('browser:navigate', url),
    back: () => invoke<void>('browser:back'),
    forward: () => invoke<void>('browser:forward'),
    reload: () => invoke<void>('browser:reload'),
    close: () => invoke<void>('browser:close'),
    state: () => invoke<{ open: boolean; url: string; title: string; canGoBack: boolean; canGoForward: boolean; loading: boolean }>('browser:state'),
    onState: (cb: (s: { open: boolean; url: string; title: string; canGoBack: boolean; canGoForward: boolean; loading: boolean }) => void) => on('browser:state', cb)
  },
  device: {
    start: (platform?: 'ios' | 'android', name?: string) => invoke<string>('device:start', platform, name),
    startChoice: (platform: 'ios' | 'android', id: string) => invoke<string>('device:startChoice', platform, id),
    stop: () => invoke<string>('device:stop'),
    stream: (on: boolean) => invoke<void>('device:stream', on),
    tap: (x: number, y: number) => invoke<string>('device:tap', x, y),
    swipe: (x1: number, y1: number, x2: number, y2: number) => invoke<string>('device:swipe', x1, y1, x2, y2),
    key: (k: string) => invoke<string>('device:key', k),
    text: (t: string) => invoke<string>('device:text', t),
    choices: () => invoke<Array<{ platform: 'ios' | 'android'; id: string; label: string }>>('device:choices'),
    onFrame: (cb: (f: { data: string; size: { width: number; height: number } | null; platform: 'ios' | 'android' | null }) => void) => on('device:frame', cb),
    onStatus: (cb: (s: { platform: 'ios' | 'android' | null; state: 'booting' | 'running' | 'stopped' | 'error'; name?: string; log?: string }) => void) => on('device:status', cb)
  },
  popup: { onOpen: (cb: (kind: 'browser' | 'device') => void) => on('popup:open', cb) },
  power: {
    status: () => invoke<{ clamshell: boolean; keepAwake: boolean }>('power:status'),
    onVoiceRestart: (cb: (p: { reason: string }) => void) => on('voice:restart', cb)
  },
  stt: {
    status: () => invoke<{ available: boolean; state: string; progress?: number; message?: string; model?: string }>('stt:status'),
    start: () => invoke<boolean>('stt:start'),
    transcribe: (buf: ArrayBuffer) => invoke<string>('stt:transcribe', buf),
    onState: (cb: (s: { available: boolean; state: string; progress?: number; message?: string; model?: string }) => void) => on('stt:state', cb)
  },
  voice: {
    report: (list: Array<{ name: string; lang: string }>) => invoke<void>('voice:report', list),
    classifyApproval: (utterance: string, title: string, detail: string) => invoke<{ decision: 'approve' | 'deny' | null; source: string }>('voice:classifyApproval', utterance, title, detail),
    learnApproval: (utterance: string, decision: 'approve' | 'deny') => invoke<LexiconEntry | null>('voice:learnApproval', utterance, decision)
  },
  sites: {
    list: () => invoke<Array<{ key: string; name: string; domain: string; connectedAt: string }>>('sites:list'),
    login: (q: string) => invoke<string>('sites:login', q),
    logout: (key: string) => invoke<Array<{ key: string; name: string; domain: string; connectedAt: string }>>('sites:logout', key),
    onChanged: (cb: (l: Array<{ key: string; name: string; domain: string; connectedAt: string }>) => void) => on('sites:changed', cb)
  },
  approval: {
    onRequest: (cb: (r: ApprovalRequest) => void) => on('approval:request', cb),
    respond: (r: ApprovalResponse) => invoke<void>('approval:respond', r)
  },
  git: {
    status: () => invoke<GitStatus>('git:status'),
    diff: (opts: { path?: string; staged?: boolean } = {}) => invoke<string>('git:diff', opts),
    log: (n?: number) => invoke<GitCommitInfo[]>('git:log', n),
    stage: (paths: string[]) => invoke<GitResult>('git:stage', paths),
    unstage: (paths: string[]) => invoke<GitResult>('git:unstage', paths),
    commit: (message: string) => invoke<GitResult>('git:commit', message),
    push: () => invoke<GitResult>('git:push'),
    suggestMessage: () => invoke<string>('git:suggestMessage')
  },
  audit: {
    list: (opts: { limit?: number; action?: string; project?: string } = {}) => invoke<AuditEntry[]>('audit:list', opts),
    path: () => invoke<string>('audit:path')
  },
  media: { request: (kind: 'camera' | 'microphone') => invoke<boolean>('media:request', kind) },
  win: {
    minimize: () => invoke<void>('win:minimize'),
    toggleMaximize: () => invoke<void>('win:toggleMaximize'),
    close: () => invoke<void>('win:close'),
    summon: () => invoke<void>('win:summon')
  },
  app: {
    info: () => invoke<{ platform: string; version: string; userData: string; cwd: string }>('app:info'),
    onSummon: (cb: () => void) => on('jarvis:summon', cb),
    onToggleListen: (cb: () => void) => on('voice:toggle', cb)
  }
}

contextBridge.exposeInMainWorld('jarvis', api)
export type JarvisApi = typeof api
