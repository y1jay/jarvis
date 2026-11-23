// "자비스, xcroll-be 열어줘" → 프로젝트 폴더를 찾아서 연다.
// 1) 명령에서 '프로젝트 열기' 의도와 이름, 뒤따르는 작업을 분리 (순수 함수)
// 2) 개발 폴더들을 스캔해 git/패키지 프로젝트 후보 수집
// 3) 이름 퍼지 매칭 → 애매하면 호출측이 AI 에게 후보 목록 중 선택을 맡긴다
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

export interface OpenIntent {
  /** 사용자가 말한 프로젝트 이름/경로 */
  query: string
  /** 프로젝트를 연 뒤 이어서 할 일 (없으면 '') */
  rest: string
}

const OPEN_VERB = /(열어\s*줘|열어\s*주세요|열어\s*봐|열어라|열어|열고(?:\s*나서)?|열기|오픈\s*해\s*줘|오픈해|오픈|로\s*전환해?\s*줘?|으로\s*전환해?\s*줘?|로\s*이동해?\s*줘?|으로\s*이동해?\s*줘?|로\s*바꿔\s*줘?|으로\s*바꿔\s*줘?|띄워\s*줘|켜\s*줘)/i
const NOUN = /\s*(프로젝트|폴더|디렉토리|디렉터리|레포지토리|레포|저장소|repo|project|folder)\s*(를|을|좀)?\s*$/i

/**
 * "xcroll-be 프로젝트 열어줘" → { query: 'xcroll-be', rest: '' }
 * "moneytree 백엔드 열고 README 요약해줘" → { query: 'moneytree 백엔드', rest: 'README 요약해줘' }
 * "open ~/code/app and run tests" → { query: '~/code/app', rest: 'run tests' }
 * 파일 열기 같은 다른 요청과 구분하기 위해, 최종 판단은 실제로 프로젝트가 찾아졌는지로 한다.
 */
export function parseOpenIntent(text: string): OpenIntent | null {
  const t = text.trim().replace(/[.!?。]+$/, '')
  const en = /^open\s+(?:the\s+)?(?:project\s+|folder\s+)?(.+?)(?:\s+(?:project|folder|repo))?(?:\s*(?:,|and then|and|then)\s+(.+))?$/i.exec(t)
  if (en) return { query: en[1].trim(), rest: (en[2] ?? '').trim() }
  const m = OPEN_VERB.exec(t)
  if (!m || m.index === 0) return null
  let query = t.slice(0, m.index).trim()
  query = query.replace(NOUN, '').replace(/\s*(를|을|좀)$/, '').trim()
  // 앞에 붙은 요청어 제거 ("지금", "그럼")
  query = query.replace(/^(지금|그럼|이제|일단|먼저)\s+/, '').trim()
  // 긴 질의는 경로 목록일 때만 허용 ("/a/b랑 ~/c 열어줘")
  const pathy = query.split(/\s*(?:,|이랑|랑|하고|와|과|그리고)\s+/).every((x) => /^(~|\/|[A-Za-z]:\\)/.test(x.trim()))
  if (!query || query.length > (pathy ? 600 : 80)) return null
  // '파일'을 여는 요청은 제외
  if (/\.(ts|tsx|js|py|md|json|txt|yml|yaml|css|html)$/i.test(query) || /파일$/.test(query)) return null
  const rest = t
    .slice(m.index + m[0].length)
    .replace(/^[\s,.]*(줘|주세요|서|고|그리고|그 다음에?|다음에?|나서)?[\s,.]*/, '')
    .trim()
  return { query, rest }
}

export function norm(s: string): string {
  return s.toLowerCase().replace(/[\s\-_.]/g, '')
}

// 흔한 한국어 표현 → 영문 토큰 (음성으로 말한 경우 대비)
const KO_ALIASES: Array<[RegExp, string]> = [
  [/백엔드|백앤드|서버/g, 'be backend server api'],
  [/프론트엔드|프론트|프런트/g, 'fe frontend web'],
  [/어드민|관리자/g, 'admin'],
  [/앱|모바일/g, 'app mobile'],
  [/웹/g, 'web']
]

/** 0~1 점수. 1 = 이름이 정확히 일치 */
export function scoreProject(query: string, dir: string): number {
  const name = basename(dir)
  const n = norm(name)
  const q = norm(query)
  if (!q) return 0
  if (n === q) return 1
  let s = 0
  if (n.startsWith(q) || q.startsWith(n)) s = Math.max(s, 0.85)
  else if (n.includes(q)) s = Math.max(s, 0.75)
  // 토큰 매칭 (한국어 별칭 확장)
  let expanded = query.toLowerCase()
  for (const [re, en] of KO_ALIASES) expanded = expanded.replace(re, ` ${en} `)
  const qTokens = expanded.split(/[\s\-_/]+/).filter((x) => x.length >= 2)
  const nameTokens = name.toLowerCase().split(/[\s\-_.]+/).filter(Boolean)
  if (qTokens.length) {
    const hits = qTokens.filter((qt) => nameTokens.some((nt) => nt === qt || (qt.length >= 3 && (nt.startsWith(qt) || qt.startsWith(nt)))))
    // 별칭으로 늘어난 토큰은 '그룹 중 하나만' 맞으면 되므로 원래 단어 수 기준
    const words = query.trim().split(/\s+/).length
    const ratio = Math.min(1, hits.length / words)
    s = Math.max(s, ratio * 0.8)
  }
  return s
}

const SKIP = new Set(['node_modules', '.git', 'Library', 'Applications', '.Trash', 'Pictures', 'Music', 'Movies', 'dist', 'build', 'out', '.cache', 'vendor', 'Pods', '.venv', 'venv', '__pycache__', 'AppData', 'target'])
const MARKERS = ['.git', 'package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'composer.json', 'Gemfile']

export function defaultRoots(): string[] {
  const h = homedir()
  const names = ['', 'Private', 'Projects', 'projects', 'Developer', 'dev', 'Dev', 'workspace', 'Workspace', 'code', 'Code', 'src', 'repos', 'git', 'GitHub', 'Documents', 'Desktop', 'work', 'Work']
  const roots = names.map((n) => (n ? join(h, n) : h)).filter((p) => existsSync(p))
  if (process.platform === 'win32') for (const d of ['C:\\dev', 'C:\\projects', 'D:\\dev', 'D:\\projects']) if (existsSync(d)) roots.push(d)
  return [...new Set(roots)]
}

/** 루트들 아래 depth 이내의 프로젝트 폴더 수집 (시간/개수 상한) */
export function scanProjects(roots: string[], opts: { depth?: number; limit?: number; timeMs?: number } = {}): string[] {
  const depth = opts.depth ?? 3
  const limit = opts.limit ?? 2000
  const deadline = Date.now() + (opts.timeMs ?? 2500)
  const found = new Set<string>()
  const walk = (dir: string, d: number): void => {
    if (found.size >= limit || Date.now() > deadline) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    if (dir !== homedir() && MARKERS.some((m) => entries.includes(m))) {
      found.add(dir)
      // 모노레포 하위 프로젝트도 후보로 (한 단계 더)
      if (!entries.includes('.git') || d <= 0) return
    }
    if (d <= 0) return
    for (const e of entries) {
      if (e.startsWith('.') || SKIP.has(e)) continue
      const p = join(dir, e)
      try {
        if (!statSync(p).isDirectory()) continue
      } catch {
        continue
      }
      walk(p, d - 1)
    }
  }
  for (const r of roots) walk(r, depth)
  return [...found]
}

export interface ResolveResult {
  /** 확정된 경로 */
  path?: string
  /** 후보 (점수순) */
  candidates: Array<{ path: string; score: number }>
}

/** 경로 직접 지정 또는 이름 매칭. 확신(점수 1 또는 2등과 큰 차이)이 있을 때만 path 를 준다 */
export function resolveProject(query: string, known: string[]): ResolveResult {
  const q = query.replace(/^["'`]|["'`]$/g, '').trim()
  const expanded = q.startsWith('~') ? join(homedir(), q.slice(1)) : q
  if (/^([a-zA-Z]:)?[\\/]/.test(expanded) || q.startsWith('~')) {
    const p = resolve(expanded)
    if (existsSync(p) && statSync(p).isDirectory()) return { path: p, candidates: [{ path: p, score: 1 }] }
    return { candidates: [] }
  }
  const scored = [...new Set(known)]
    .map((p) => ({ path: p, score: scoreProject(q, p) }))
    .filter((c) => c.score >= 0.5)
    .sort((a, b) => b.score - a.score || a.path.length - b.path.length)
  const top = scored[0]
  if (!top) return { candidates: [] }
  const exact = scored.filter((c) => c.score === 1)
  if (exact.length === 1) return { path: exact[0].path, candidates: scored.slice(0, 8) }
  if (exact.length > 1) return { candidates: exact.slice(0, 8) }
  const second = scored[1]
  if (top.score >= 0.75 && (!second || top.score - second.score >= 0.15)) return { path: top.path, candidates: scored.slice(0, 8) }
  return { candidates: scored.slice(0, 8) }
}

export class ProjectFinder {
  private cache: { at: number; list: string[] } | null = null
  constructor(private readonly roots: () => string[] = defaultRoots) {}

  list(extra: string[] = []): string[] {
    if (!this.cache || Date.now() - this.cache.at > 60_000) this.cache = { at: Date.now(), list: scanProjects(this.roots()) }
    return [...new Set([...extra, ...this.cache.list])]
  }

  invalidate(): void {
    this.cache = null
  }
}

/** 퍼지 매칭 실패 시 AI 에게 후보 중 선택을 맡기는 프롬프트 */
export function pickProjectPrompt(query: string, list: string[]): string {
  return [
    `사용자가 음성/텍스트로 "${query}" 을(를) 열어 달라고 했다. 음성 인식 때문에 영어 이름이 한글로 적혔을 수 있다 (예: "엑스크롤 비이" = xcroll-be, "피그마" = app:Figma).`,
    '아래 후보(프로젝트 경로 또는 app:앱이름) 중 가장 알맞은 것 하나를 그대로 출력하라. 확실한 후보가 없으면 NONE 만 출력하라. 설명 금지.',
    '',
    ...list.slice(0, 400)
  ].join('\n')
}
