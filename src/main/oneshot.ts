// 도구 없이 한 번 묻고 답 받기 (커밋 메시지 제안 등)
import { query } from '@anthropic-ai/claude-agent-sdk'
import { claudeBinary, codexCommand, geminiCommand, JsonLineParser, runCli } from './cli'
import type { ProviderId } from '../shared/types'

export async function oneShot(provider: ProviderId, prompt: string, cwd: string, env: NodeJS.ProcessEnv, model?: string): Promise<string> {
  if (provider === 'claude') {
    let out = ''
    const q = query({
      prompt,
      options: {
        cwd,
        model,
        tools: [],
        maxTurns: 1,
        persistSession: false,
        settingSources: [],
        pathToClaudeCodeExecutable: claudeBinary(),
        env: { ...process.env, ...env }
      }
    })
    for await (const m of q) {
      if (m.type === 'result') {
        if (m.subtype !== 'success') throw new Error((m.errors ?? []).join('\n') || m.subtype)
        out = m.result
      }
    }
    return out.trim()
  }
  if (provider === 'gpt') {
    const args = ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '-C', cwd]
    if (model) args.push('-m', model)
    args.push('-')
    const r = await runCli(codexCommand(args), { cwd, input: prompt, extraEnv: env, timeoutMs: 180000 })
    let last = ''
    const p = new JsonLineParser((o) => {
      const item = o.item as Record<string, unknown> | undefined
      if (o.type === 'item.completed' && item?.type === 'agent_message') last = String(item.text ?? '')
    })
    p.push(r.stdout)
    p.flush()
    if (!last) throw new Error(r.stderr.trim().split('\n').slice(-3).join('\n') || 'Codex 응답 없음')
    return last.trim()
  }
  const args = ['-p', prompt, '-o', 'json', '--skip-trust', '--approval-mode', 'plan']
  if (model) args.push('-m', model)
  const r = await runCli(geminiCommand(args), { cwd, extraEnv: env, timeoutMs: 180000 })
  try {
    const j = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')))
    if (j.error) throw new Error(j.error.message ?? 'Gemini 오류')
    return String(j.response ?? '').trim()
  } catch (e) {
    throw new Error((e as Error).message || r.stderr.trim().slice(-300))
  }
}

export function commitMessagePrompt(diff: string): string {
  return [
    '다음 git diff 에 대한 커밋 메시지를 작성하라.',
    '규칙: Conventional Commits 형식(feat:, fix:, refactor: ...), 첫 줄 72자 이내, 필요하면 빈 줄 후 본문 bullet.',
    '커밋 메시지 텍스트만 출력하라. 코드블록/설명 금지.',
    '',
    diff.slice(0, 60000)
  ].join('\n')
}
