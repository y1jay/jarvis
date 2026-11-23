// 번들된 공식 CLI(Claude / Codex / Gemini) 경로 해석과 실행 헬퍼.
// Windows 의 .cmd 셸 인용 문제를 피하려고 JS 엔트리는 Electron 자체를 Node 로 실행한다(ELECTRON_RUN_AS_NODE).
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, sep } from 'node:path'

const req = createRequire(import.meta.url)

/** asar 내부 경로를 unpacked 경로로 (네이티브 바이너리는 asar 안에서 실행 불가) */
export function unpacked(p: string): string {
  return p.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
}

function pkgDir(name: string): string | null {
  try {
    return unpacked(dirname(req.resolve(`${name}/package.json`)))
  } catch {
    return null
  }
}

function binEntry(name: string, bin: string): string | null {
  const dir = pkgDir(name)
  if (!dir) return null
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[bin]
  if (!rel) return null
  const p = join(dir, rel)
  return existsSync(p) ? p : null
}

export interface CliCommand {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
}

/** Node 로 실행할 JS 엔트리 → [electron|node, entry, ...args] */
function viaNode(entry: string, args: string[]): CliCommand {
  return {
    command: process.execPath,
    args: [entry, ...args],
    env: { ELECTRON_RUN_AS_NODE: '1' }
  }
}

export function codexCommand(args: string[]): CliCommand {
  const entry = binEntry('@openai/codex', 'codex')
  if (entry) return viaNode(entry, args)
  return { command: process.platform === 'win32' ? 'codex.cmd' : 'codex', args, env: {} }
}

export function geminiCommand(args: string[]): CliCommand {
  const entry = binEntry('@google/gemini-cli', 'gemini')
  if (entry) return viaNode(entry, args)
  return { command: process.platform === 'win32' ? 'gemini.cmd' : 'gemini', args, env: {} }
}

/** Agent SDK 와 함께 설치되는 플랫폼별 claude 네이티브 바이너리 */
export function claudeBinary(): string {
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude'
  const candidates = [
    `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`,
    `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}-musl`
  ]
  for (const c of candidates) {
    const dir = pkgDir(c)
    if (dir && existsSync(join(dir, exe))) return join(dir, exe)
  }
  return exe // PATH 의 claude 로 폴백
}

export function claudeCommand(args: string[]): CliCommand {
  return { command: claudeBinary(), args, env: {} }
}

export function spawnCli(cmd: CliCommand, opts: SpawnOptions & { extraEnv?: NodeJS.ProcessEnv } = {}): ChildProcess {
  const { extraEnv, ...rest } = opts
  return spawn(cmd.command, cmd.args, {
    windowsHide: true,
    ...rest,
    env: { ...process.env, ...cmd.env, ...extraEnv }
  })
}

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

export function runCli(
  cmd: CliCommand,
  opts: { cwd?: string; input?: string; timeoutMs?: number; extraEnv?: NodeJS.ProcessEnv } = {}
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawnCli(cmd, { cwd: opts.cwd, extraEnv: opts.extraEnv, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d) => (stdout += d))
    child.stderr?.on('data', (d) => (stderr += d))
    const t = opts.timeoutMs ? setTimeout(() => child.kill(), opts.timeoutMs) : null
    child.on('error', (e) => {
      if (t) clearTimeout(t)
      resolve({ code: -1, stdout, stderr: stderr + String(e) })
    })
    child.on('close', (code) => {
      if (t) clearTimeout(t)
      resolve({ code, stdout, stderr })
    })
    if (opts.input !== undefined) child.stdin?.end(opts.input)
    else child.stdin?.end()
  })
}

/** 줄 단위 JSON 스트림 파서 */
export class JsonLineParser {
  private buf = ''
  constructor(private readonly onObject: (o: Record<string, unknown>) => void, private readonly onText?: (line: string) => void) {}
  push(chunk: string | Buffer): void {
    this.buf += chunk.toString()
    let i: number
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim()
      this.buf = this.buf.slice(i + 1)
      this.handle(line)
    }
  }
  flush(): void {
    const line = this.buf.trim()
    this.buf = ''
    this.handle(line)
  }
  private handle(line: string): void {
    if (!line) return
    if (line.startsWith('{')) {
      try {
        this.onObject(JSON.parse(line))
        return
      } catch {
        /* fallthrough */
      }
    }
    this.onText?.(line)
  }
}
