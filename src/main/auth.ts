// 로그인 연동: 각 사의 공식 CLI 로그인 플로우(브라우저 로그인 창)에 위임한다.
// JARVIS 는 비밀번호/토큰을 직접 다루지 않는다. 대안으로 API 키(OS 암호화 저장) 지원.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AuthStatus, ProviderId } from '../shared/types'
import { claudeCommand, codexCommand, geminiCommand, runCli, spawnCli } from './cli'
import type { SecretStore } from './secrets'

export function geminiCredsPath(): string {
  return join(process.env.GEMINI_CLI_HOME ?? homedir(), '.gemini', 'oauth_creds.json')
}

function geminiAccount(): string | undefined {
  try {
    const p = join(process.env.GEMINI_CLI_HOME ?? homedir(), '.gemini', 'google_accounts.json')
    const j = JSON.parse(readFileSync(p, 'utf8'))
    return j.active ?? undefined
  } catch {
    return undefined
  }
}

export class AuthService {
  constructor(
    private readonly secrets: SecretStore,
    private readonly opts: { geminiUseGoogleLogin: () => boolean }
  ) {}

  /** 각 프로바이더 실행 시 주입할 env */
  envFor(p: ProviderId): NodeJS.ProcessEnv {
    const key = this.secrets.get(p)
    if (p === 'claude') return key ? { ANTHROPIC_API_KEY: key } : {}
    if (p === 'gpt') return key ? { CODEX_API_KEY: key, OPENAI_API_KEY: key } : {}
    if (key) return { GEMINI_API_KEY: key }
    return this.opts.geminiUseGoogleLogin() ? { GOOGLE_GENAI_USE_GCA: 'true' } : {}
  }

  async status(p: ProviderId): Promise<AuthStatus> {
    const hasKey = this.secrets.has(p)
    if (p === 'claude') {
      const r = await runCli(claudeCommand(['auth', 'status', '--json']), { timeoutMs: 20000 })
      try {
        const j = JSON.parse(r.stdout)
        if (j.loggedIn) return { provider: p, loggedIn: true, method: 'login', account: j.email, detail: j.subscriptionType ?? j.authMethod }
      } catch {
        /* not json */
      }
      return hasKey ? { provider: p, loggedIn: true, method: 'apiKey' } : { provider: p, loggedIn: false, detail: r.stderr.trim().slice(0, 200) || undefined }
    }
    if (p === 'gpt') {
      const r = await runCli(codexCommand(['login', 'status']), { timeoutMs: 20000 })
      const out = (r.stdout + r.stderr).trim()
      if (r.code === 0 && /logged in/i.test(out)) return { provider: p, loggedIn: true, method: /api key/i.test(out) ? 'apiKey' : 'login', detail: out.split('\n')[0] }
      return hasKey ? { provider: p, loggedIn: true, method: 'apiKey' } : { provider: p, loggedIn: false, detail: out.slice(0, 200) || undefined }
    }
    if (hasKey) return { provider: p, loggedIn: true, method: 'apiKey' }
    if (!this.opts.geminiUseGoogleLogin()) return { provider: p, loggedIn: false, detail: 'JARVIS 에서 Google 로그인 연결 해제됨' }
    if (existsSync(geminiCredsPath())) return { provider: p, loggedIn: true, method: 'login', account: geminiAccount() }
    return { provider: p, loggedIn: false }
  }

  /**
   * 브라우저 로그인 창을 연다. 완료(또는 실패)까지 기다린다.
   * onLine: CLI 출력(로그인 URL 등)을 UI 로 전달
   */
  async login(p: ProviderId, onLine: (s: string) => void): Promise<boolean> {
    if (p === 'claude') {
      const r = await this.streamRun(claudeCommand(['auth', 'login']), onLine, 10 * 60_000)
      return r === 0
    }
    if (p === 'gpt') {
      const r = await this.streamRun(codexCommand(['login']), onLine, 10 * 60_000)
      return r === 0
    }
    // Gemini: 헤드리스 모드에서 OAuth 동의 프롬프트에 'y' 를 넣으면 브라우저 Google 로그인 창이 열린다.
    const code = await this.streamRun(
      geminiCommand(['-p', 'Reply with exactly: ok', '-o', 'text', '--skip-trust']),
      onLine,
      10 * 60_000,
      { GOOGLE_GENAI_USE_GCA: 'true' },
      'y\n'
    )
    return code === 0 && existsSync(geminiCredsPath())
  }

  async logout(p: ProviderId): Promise<void> {
    if (p === 'claude') await runCli(claudeCommand(['auth', 'logout']), { timeoutMs: 20000 })
    else if (p === 'gpt') await runCli(codexCommand(['logout']), { timeoutMs: 20000 })
    // Gemini CLI 는 logout 서브커맨드가 없다. 사용자 홈의 자격증명 파일은 삭제하지 않고,
    // 호출측(index.ts)에서 geminiUseGoogleLogin=false 로 JARVIS 연결만 해제한다.
  }

  private streamRun(cmd: ReturnType<typeof claudeCommand>, onLine: (s: string) => void, timeoutMs: number, extraEnv?: NodeJS.ProcessEnv, stdin?: string): Promise<number | null> {
    return new Promise((resolve) => {
      const child = spawnCli(cmd, { extraEnv, stdio: ['pipe', 'pipe', 'pipe'] })
      const t = setTimeout(() => child.kill(), timeoutMs)
      const forward = (d: Buffer): void => {
        for (const l of d.toString().split('\n')) if (l.trim()) onLine(l.trim())
      }
      child.stdout?.on('data', forward)
      child.stderr?.on('data', forward)
      child.on('error', (e) => onLine(`실행 실패: ${e.message}`))
      child.on('close', (code) => {
        clearTimeout(t)
        resolve(code)
      })
      if (stdin) child.stdin?.write(stdin)
    })
  }
}
