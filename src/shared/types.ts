// main ↔ preload ↔ renderer 공통 타입

export type ProviderId = 'claude' | 'gpt' | 'gemini'

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  claude: 'Claude',
  gpt: 'GPT (Codex)',
  gemini: 'Gemini'
}

export type AuthMethod = 'login' | 'apiKey'

export interface AuthStatus {
  provider: ProviderId
  loggedIn: boolean
  method?: AuthMethod
  account?: string
  detail?: string
}

/** 에이전트 → UI 로 흐르는 정규화된 이벤트 */
export type AgentEvent =
  | { kind: 'session'; sessionId: string; model?: string }
  | { kind: 'text-delta'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool-use'; id: string; name: string; input: unknown }
  | { kind: 'tool-result'; id: string; output: string; isError: boolean }
  | { kind: 'file-change'; paths: string[] }
  | { kind: 'status'; message: string }
  | { kind: 'result'; text: string; isError: boolean; costUsd?: number; durationMs?: number }
  | { kind: 'error'; message: string }

export interface AgentEventEnvelope {
  turnId: string
  sessionId: string
  provider: ProviderId
  event: AgentEvent
}

/** 세션 = (AI, 프로젝트) 단위의 독립 대화 */
export interface SessionInfo {
  id: string
  title: string
  provider: ProviderId
  projectDir: string | null
  status: 'idle' | 'running' | 'error'
  createdAt: number
  lastActive: number
  turns: number
}

export interface TaskInfo {
  id: string
  sessionId: string
  title: string
  instruction: string
  status: 'pending' | 'running' | 'done' | 'error'
  after: number[]
  result?: string
}

/** 사용자 요청 하나에 대한 JARVIS 작업 (여러 세션 작업을 묶어 한 답변) */
export interface JobInfo {
  id: string
  prompt: string
  status: 'planning' | 'running' | 'summarizing' | 'done' | 'error'
  tasks: TaskInfo[]
  answer?: string
  /** 진행 중 JARVIS 안내 (로그인 창 열림 등) */
  notes: string[]
  via: 'voice' | 'text'
  createdAt: number
}

export type ApprovalKind = 'git-commit' | 'git-push' | 'destructive' | 'tool'

export interface ApprovalRequest {
  id: string
  kind: ApprovalKind
  provider: ProviderId | 'jarvis'
  title: string
  detail: string
  toolName?: string
  input?: unknown
  /** 판단에 도움이 되는 화면 (data URL) */
  image?: string
}

export interface ApprovalResponse {
  id: string
  approved: boolean
  reason?: string
  /** 승인 수단 (이력용) */
  via?: 'click' | 'voice'
  /** 음성 승인 시 인식된 문장 */
  transcript?: string
}

export type PermissionModeSetting = 'default' | 'acceptEdits' | 'plan' | 'auto'

export interface JarvisSettings {
  provider: ProviderId
  projectDir: string | null
  recentProjects: string[]
  models: Record<ProviderId, string>
  claudePermissionMode: PermissionModeSetting
  /** Gemini 를 Google 계정 로그인으로 쓸지 */
  geminiUseGoogleLogin: boolean
  voice: {
    wakeWordEnabled: boolean
    wakeWords: string[]
    ttsEnabled: boolean
    ttsVoice: string | null
    ttsRate: number
    ttsPitch: number
    sttModel: string
    language: string
  }
  camera: {
    enabled: boolean
    deviceId: string | null
  }
  alwaysOnTop: boolean
  /** 대화에서 사용자 정보를 학습해 기억할지 */
  learning: { enabled: boolean }
}

export interface GitFileStatus {
  path: string
  index: string
  worktree: string
}

export interface GitStatus {
  isRepo: boolean
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  files: GitFileStatus[]
}

export interface GitCommitInfo {
  hash: string
  author: string
  date: string
  subject: string
}

export type AuditAction =
  | 'auth.login'
  | 'auth.logout'
  | 'auth.apikey.set'
  | 'auth.apikey.clear'
  | 'project.open'
  | 'file.modified'
  | 'git.stage'
  | 'git.unstage'
  | 'git.commit'
  | 'git.push'
  | 'approval.requested'
  | 'approval.approved'
  | 'approval.denied'
  | 'agent.prompt'
  | 'settings.changed'
  | 'system.app.open'
  | 'system.app.quit'
  | 'system.url.open'
  | 'system.path.open'
  | 'system.screenshot'
  | 'system.clipboard.write'
  | 'session.open'
  | 'session.close'
  | 'auth.site.login'
  | 'auth.site.logout'
  | 'system.input'
  | 'system.web.final'
  | 'system.web.upload'
  | 'message.send'
  | 'jarvis.ask'
  | 'jarvis.answer'
  | 'emulator.start'
  | 'emulator.stop'
  | 'release.start'
  | 'memory.add'
  | 'memory.delete'
  | 'lexicon.learn'
  | 'lexicon.delete'

export interface AuditEntry {
  id: string
  ts: string
  actor: string
  action: AuditAction
  provider?: ProviderId | 'jarvis'
  project?: string | null
  target?: string
  detail?: Record<string, unknown>
  source: { host: string; platform: string; app: string }
}

export interface MemoryItem {
  id: string
  text: string
  category: 'preference' | 'habit' | 'project' | 'fact'
  /** 어느 대화(jobId) 또는 'user' 에서 왔는지 */
  source: string
  createdAt: string
}

export interface LexiconEntry {
  /** 정규화된 표현 */
  phrase: string
  /** 처음 들은 원문 */
  example: string
  decision: 'approve' | 'deny'
  source: 'ai' | 'user'
  count: number
  updatedAt: string
}
