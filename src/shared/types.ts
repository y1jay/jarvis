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
    /** 마이크 장치 (null = 시스템 기본) */
    inputDeviceId: string | null
    /** 네이티브 음성 인식 모델 ('large-v3-turbo' | 'small') */
    nativeModel: string
    /** JARVIS 가 말하는 중에도 사용자가 말하면 멈추고 듣기 */
    bargeIn: boolean
    /** 내 목소리·말투 학습 (말소리는 내 암호로 잠가 숨김 폴더에, 말투는 키체인으로 잠가 저장) */
    learning: boolean
    /** 말소리 샘플 최대 용량 (MB) — 넘으면 오래된 것부터 지움 */
    learnLimitMB: number
    /** 학습 데이터 백업용 git 저장소 폴더 (비공개 저장소 권장) */
    learnRepo: string | null
    /** 문맥 보정: 엔진이 자신 없게 받아 적은 말을 대화 흐름으로 바로잡기 */
    contextCorrection: boolean
    /** 말하는 목소리 ('system' = 운영체제 목소리, 'qwen3:sohee', 'supertonic:3' …) */
    ttsVoiceId: string
    /** 자주 쓰는 목소리 (말로 "목소리 바꿔줘" 할 때 먼저 보여 줌) */
    ttsFavorites: string[]
  }
  camera: {
    enabled: boolean
    deviceId: string | null
  }
  alwaysOnTop: boolean
  /** 부르는 이름 ("헤이 ○○", "○○") — "자비스" 는 항상 함께 동작 */
  assistantName: string
  /** 앱이 켜지면 바로 마이크 대기 (창을 닫아도 뒤에서 듣는다) */
  alwaysListen: boolean
  /** 항상 듣기 중 시스템이 잠들지 않게 (화면은 꺼져도 됨) — 부르면 화면을 깨운다 */
  keepAwake: boolean
  /** 로그인 시 자동 실행 (숨김 상태로 대기) */
  launchAtLogin: boolean
  /** 간단한 대화는 빠른 모델로 바로 답하기 (도구가 필요하면 자동으로 전체 에이전트로) */
  fastLane: boolean
  /** 빠른 대화에 쓸 모델 */
  fastModel: string
  /** 프로젝트 밖 일상 행동(앱·폴더·웹·메시지·시스템 정보)을 처리할 일반 세션 모델. 비우면 기본 모델 */
  actionModel: string
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
  | 'agent.interrupt'
  | 'settings.changed'
  | 'system.app.open'
  | 'system.permission.missing'
  | 'voice.vault.setup'
  | 'voice.vault.backup'
  | 'voice.vault.restore'
  | 'voice.vault.clear'
  | 'voice.lexicon.fix'
  | 'voice.correct'
  | 'tts.install'
  | 'voice.train'
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
