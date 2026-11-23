import type { AgentEvent, ApprovalRequest, PermissionModeSetting, ProviderId } from '../../shared/types'
import type { AuditInput } from '../audit'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'

export interface TurnContext {
  turnId: string
  cwd: string
  model?: string
  permissionMode: PermissionModeSetting
  env: NodeJS.ProcessEnv
  emit: (event: AgentEvent) => void
  /** 사용자 승인 요청. true = 승인 */
  approve: (req: Omit<ApprovalRequest, 'id' | 'provider'>) => Promise<{ approved: boolean; reason?: string }>
  audit: (input: AuditInput) => void
  /** Claude 전용: JARVIS 시스템 도구 (in-process MCP) */
  mcpServers?: Record<string, McpServerConfig>
  allowedTools?: string[]
  /** JARVIS 기억 (학습된 사용자 정보) — 시스템 프롬프트에 주입 */
  memory?: string
}

export interface AgentProvider {
  readonly id: ProviderId
  send(prompt: string, ctx: TurnContext): Promise<void>
  /** 첫 요청 지연을 줄이려 미리 띄워 두기 (선택) */
  warm?(ctx: TurnContext): void
  interrupt(): Promise<void>
  /** 대화 초기화 (새 세션) */
  reset(): void
  sessionId(): string | null
}

/** CLI 기반 에이전트(Codex/Gemini)에 붙이는 Jarvis 규칙 */
export const CLI_AGENT_RULES = [
  '[JARVIS 규칙]',
  '- 사용자에게 한국어로 답한다.',
  '- git commit / git push 는 직접 실행하지 않는다. 필요하면 커밋 메시지만 제안하고, 사용자가 JARVIS 의 Git 패널에서 확인 후 실행한다.',
  '- rm -rf, git reset --hard 같은 복구 불가능한 명령은 실행하지 않는다.',
  '- 답변 마지막에 음성으로 읽어줄 1~2문장 요약을 둔다.'
].join('\n')
