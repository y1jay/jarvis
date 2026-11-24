// JARVIS 의 기억 전부를 한 파일로 (잠가서 git 에 올리고, 다른 기기에서 되살리기)
// 담는 것: 기억(사용자 정보·선호), 승인 대답 학습, 전체 대화 기록, 말투 학습, 연결한 사이트 목록, 이력, 개인 설정
// 담지 않는 것: 로그인 토큰/API 키(secrets.json), 사이트 쿠키, 이 기기에만 맞는 값(마이크 장치, 폴더 경로)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { LexiconData } from './voicevault'

export interface BrainBundle {
  v: 1
  createdAt: string
  app: string
  files: Record<string, string>
  speechLexicon: LexiconData
}

/** 백업에 넣는 파일 (userData 기준 경로) */
export const BRAIN_FILES = ['memory/memory.json', 'memory/approval-lexicon.json', 'memory/conversations.jsonl', 'sites.json', 'settings.json', 'audit/audit.jsonl']

/** 다른 기기로 옮길 개인 설정 (기기마다 다른 값은 제외) */
const PORTABLE_SETTINGS = ['assistantName', 'provider', 'models', 'claudePermissionMode', 'fastLane', 'fastModel', 'actionModel', 'learning', 'launchAtLogin', 'alwaysListen', 'keepAwake']
const PORTABLE_VOICE = ['wakeWordEnabled', 'wakeWords', 'ttsEnabled', 'ttsVoice', 'ttsRate', 'ttsPitch', 'bargeIn', 'learning', 'learnLimitMB']

export function collectBrain(userData: string, speechLexicon: LexiconData, appVersion: string): Buffer {
  const files: Record<string, string> = {}
  for (const f of BRAIN_FILES) {
    const p = join(userData, f)
    if (existsSync(p)) files[f] = readFileSync(p, 'utf8')
  }
  const b: BrainBundle = { v: 1, createdAt: new Date().toISOString(), app: appVersion, files, speechLexicon }
  return Buffer.from(JSON.stringify(b))
}

export interface MergeResult {
  memory: number
  approvals: number
  conversations: number
  sites: number
  words: number
  fixes: number
  settings: string[]
  history: number
}

const keyOf = (s: string): string => s.toLowerCase().replace(/[\s.,!?~"'`]/g, '')
function readJson<T>(p: string, fb: T): T {
  try {
    return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : fb
  } catch {
    return fb
  }
}
function write(p: string, s: string): void {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, s, 'utf8')
}

/**
 * 백업을 이 기기의 기억에 합친다 (지우지 않고 더하기만). 이 기기에서 배운 것도 그대로 남는다.
 * 반환: 새로 더해진 개수
 */
export function mergeBrain(userData: string, b: BrainBundle, local: LexiconData): { result: MergeResult; lexicon: LexiconData } {
  const r: MergeResult = { memory: 0, approvals: 0, conversations: 0, sites: 0, words: 0, fixes: 0, settings: [], history: 0 }
  const f = b.files

  // 기억: 같은 내용이면 하나만
  if (f['memory/memory.json']) {
    const p = join(userData, 'memory/memory.json')
    const mine = readJson<Array<{ text: string }>>(p, [])
    const seen = new Set(mine.map((x) => keyOf(x.text)))
    const add = (JSON.parse(f['memory/memory.json']) as Array<{ text: string }>).filter((x) => x?.text && !seen.has(keyOf(x.text)))
    r.memory = add.length
    if (add.length) write(p, JSON.stringify([...mine, ...add], null, 2))
  }
  // 승인 대답 학습: 같은 표현이면 이 기기 것 우선
  if (f['memory/approval-lexicon.json']) {
    const p = join(userData, 'memory/approval-lexicon.json')
    const mine = readJson<Array<{ phrase: string }>>(p, [])
    const seen = new Set(mine.map((x) => x.phrase))
    const add = (JSON.parse(f['memory/approval-lexicon.json']) as Array<{ phrase: string }>).filter((x) => x?.phrase && !seen.has(x.phrase))
    r.approvals = add.length
    if (add.length) write(p, JSON.stringify([...mine, ...add], null, 2))
  }
  // 대화 기록: 줄 단위로 합치고 시간순
  if (f['memory/conversations.jsonl']) {
    const p = join(userData, 'memory/conversations.jsonl')
    const mine = existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean) : []
    const seen = new Set(mine)
    const add = f['memory/conversations.jsonl'].split('\n').filter((l) => l && !seen.has(l))
    r.conversations = add.length
    if (add.length) {
      const ts = (l: string): string => {
        try {
          return String((JSON.parse(l) as { ts?: string }).ts ?? '')
        } catch {
          return ''
        }
      }
      write(p, [...mine, ...add].sort((a, c) => ts(a).localeCompare(ts(c))).join('\n') + '\n')
    }
  }
  // 연결한 사이트 목록 (쿠키는 기기마다 다시 로그인)
  if (f['sites.json']) {
    const p = join(userData, 'sites.json')
    const mine = readJson<Array<{ id?: string; name?: string }>>(p, [])
    const k = (x: { id?: string; name?: string }): string => x.id ?? x.name ?? JSON.stringify(x)
    const seen = new Set(mine.map(k))
    const add = (JSON.parse(f['sites.json']) as Array<{ id?: string; name?: string }>).filter((x) => !seen.has(k(x)))
    r.sites = add.length
    if (add.length) write(p, JSON.stringify([...mine, ...add], null, 2))
  }
  // 개인 설정 (이름, 목소리, 모델 등 — 기기마다 다른 값은 그대로)
  if (f['settings.json']) {
    const p = join(userData, 'settings.json')
    const mine = readJson<Record<string, unknown>>(p, {})
    const theirs = JSON.parse(f['settings.json']) as Record<string, unknown>
    for (const k of PORTABLE_SETTINGS) {
      if (theirs[k] !== undefined && JSON.stringify(theirs[k]) !== JSON.stringify(mine[k])) {
        mine[k] = theirs[k]
        r.settings.push(k)
      }
    }
    const tv = (theirs.voice ?? {}) as Record<string, unknown>
    const mv = (mine.voice ?? {}) as Record<string, unknown>
    for (const k of PORTABLE_VOICE) {
      if (tv[k] !== undefined && JSON.stringify(tv[k]) !== JSON.stringify(mv[k])) {
        mv[k] = tv[k]
        r.settings.push(`voice.${k}`)
      }
    }
    mine.voice = mv
    write(p, JSON.stringify(mine, null, 2))
  }
  // 이력: 이 기기의 append-only 이력은 건드리지 않고, 가져온 이력은 따로 보관
  if (f['audit/audit.jsonl']) {
    const lines = f['audit/audit.jsonl'].split('\n').filter(Boolean)
    r.history = lines.length
    write(join(userData, 'audit', `imported-${b.createdAt.replace(/[:.]/g, '-')}.jsonl`), lines.join('\n') + '\n')
  }
  // 말투 학습: 단어는 횟수 더하기, 교정은 이 기기 것이 없을 때만
  const lex: LexiconData = { v: 1, words: { ...local.words }, fixes: { ...local.fixes } }
  for (const [w, c] of Object.entries(b.speechLexicon?.words ?? {})) {
    if (!(w in lex.words)) r.words++
    lex.words[w] = (lex.words[w] ?? 0) + c
  }
  for (const [k, v] of Object.entries(b.speechLexicon?.fixes ?? {})) {
    if (!lex.fixes[k]) {
      lex.fixes[k] = v
      r.fixes++
    }
  }
  return { result: r, lexicon: lex }
}
