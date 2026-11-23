// append-only 이력 로그 (JSONL). 수정/삭제 API 는 제공하지 않는다.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { hostname, userInfo } from 'node:os'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AuditAction, AuditEntry, ProviderId } from '../shared/types'

export interface AuditInput {
  action: AuditAction
  provider?: ProviderId | 'jarvis'
  project?: string | null
  target?: string
  detail?: Record<string, unknown>
  actor?: string
}

export class AuditLog {
  private actor: string
  constructor(
    private readonly file: string,
    private readonly appVersion = '0.0.0'
  ) {
    mkdirSync(dirname(file), { recursive: true })
    let name = 'user'
    try {
      name = userInfo().username
    } catch {
      /* ignore */
    }
    this.actor = `user:${name}`
  }

  get path(): string {
    return this.file
  }

  record(input: AuditInput): AuditEntry {
    const entry: AuditEntry = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      actor: input.actor ?? this.actor,
      action: input.action,
      provider: input.provider,
      project: input.project ?? null,
      target: input.target,
      detail: input.detail,
      source: { host: hostname(), platform: process.platform, app: `jarvis@${this.appVersion}` }
    }
    appendFileSync(this.file, JSON.stringify(entry) + '\n', 'utf8')
    return entry
  }

  /** 최신순으로 반환 */
  list(opts: { limit?: number; action?: string; project?: string } = {}): AuditEntry[] {
    if (!existsSync(this.file)) return []
    const lines = readFileSync(this.file, 'utf8').split('\n').filter(Boolean)
    const out: AuditEntry[] = []
    for (let i = lines.length - 1; i >= 0; i--) {
      let e: AuditEntry
      try {
        e = JSON.parse(lines[i])
      } catch {
        continue
      }
      if (opts.action && !e.action.startsWith(opts.action)) continue
      if (opts.project && e.project !== opts.project) continue
      out.push(e)
      if (opts.limit && out.length >= opts.limit) break
    }
    return out
  }
}
