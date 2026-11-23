// 사이트 정의 / 연결 목록 (Electron 비의존 — 단위 테스트 가능)
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface SiteDef {
  key: string
  name: string
  url: string
  domain: string
  /** 로그인 화면 경로 패턴 — 여기서 벗어나면 로그인 완료로 본다 */
  loginPath: RegExp
}

const S = (key: string, name: string, url: string, domain: string, loginPath = /(login|signin|sign_in|session|auth|accounts|oauth|sso)/i): SiteDef => ({ key, name, url, domain, loginPath })

export const SITES: SiteDef[] = [
  S('github', 'GitHub', 'https://github.com/login', 'github.com'),
  S('gitlab', 'GitLab', 'https://gitlab.com/users/sign_in', 'gitlab.com'),
  S('google', 'Google', 'https://accounts.google.com/', 'google.com', /(signin|servicelogin|accounts\.google)/i),
  S('gmail', 'Gmail', 'https://mail.google.com/', 'google.com', /(signin|servicelogin)/i),
  S('notion', 'Notion', 'https://www.notion.so/login', 'notion.so'),
  S('slack', 'Slack', 'https://slack.com/signin', 'slack.com'),
  S('figma', 'Figma', 'https://www.figma.com/login', 'figma.com'),
  S('linear', 'Linear', 'https://linear.app/login', 'linear.app'),
  S('jira', 'Atlassian (Jira/Confluence)', 'https://id.atlassian.com/login', 'atlassian.com'),
  S('vercel', 'Vercel', 'https://vercel.com/login', 'vercel.com'),
  S('aws', 'AWS Console', 'https://console.aws.amazon.com/', 'aws.amazon.com', /(signin|login)/i),
  S('azure', 'Azure Portal', 'https://portal.azure.com/', 'azure.com', /(login|signin|oauth)/i),
  S('naver', '네이버', 'https://nid.naver.com/nidlogin.login', 'naver.com', /(nidlogin|login)/i),
  S('kakao', '카카오', 'https://accounts.kakao.com/login', 'kakao.com'),
  S('discord', 'Discord', 'https://discord.com/login', 'discord.com'),
  S('x', 'X (Twitter)', 'https://x.com/login', 'x.com', /(login|flow)/i),
  S('youtube', 'YouTube', 'https://accounts.google.com/ServiceLogin?service=youtube', 'youtube.com', /(signin|servicelogin)/i),
  S('chatgpt', 'ChatGPT 웹', 'https://chatgpt.com/auth/login', 'chatgpt.com'),
  S('claude-web', 'Claude 웹', 'https://claude.ai/login', 'claude.ai')
]

const SITE_ALIASES: Record<string, string> = {
  깃허브: 'github', 깃헙: 'github', github: 'github', 깃랩: 'gitlab', gitlab: 'gitlab',
  구글: 'google', google: 'google', 지메일: 'gmail', gmail: 'gmail',
  노션: 'notion', notion: 'notion', 슬랙: 'slack', slack: 'slack', 피그마: 'figma', figma: 'figma',
  리니어: 'linear', linear: 'linear', 지라: 'jira', jira: 'jira', 컨플루언스: 'jira', 아틀라시안: 'jira',
  버셀: 'vercel', vercel: 'vercel', aws: 'aws', 아마존웹서비스: 'aws', 애저: 'azure', azure: 'azure',
  네이버: 'naver', naver: 'naver', 카카오: 'kakao', kakao: 'kakao', 디스코드: 'discord', discord: 'discord',
  트위터: 'x', 엑스: 'x', twitter: 'x', 유튜브: 'youtube', youtube: 'youtube', 챗지피티웹: 'chatgpt', 클로드웹: 'claude-web'
}

const n = (s: string): string => s.toLowerCase().replace(/[\s\-_.]/g, '')

export function resolveSiteDef(query: string): SiteDef | null {
  const q = n(query).replace(/(사이트|웹|계정|홈페이지)$/, '')
  const key = SITE_ALIASES[q]
  if (key) return SITES.find((s) => s.key === key) ?? null
  // 도메인 직접 지정: "example.com 로그인"
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(query.trim())) {
    const domain = query.trim().toLowerCase().replace(/^www\./, '')
    return { key: domain, name: domain, url: `https://${domain}/login`, domain, loginPath: /(login|signin|auth|session)/i }
  }
  return null
}

/** 클릭하면 안 되는(사용자 승인 필요) 요소 텍스트 */
export const SENSITIVE_CLICK = /(결제|구매|주문|송금|이체|입금|출금|환불|탈퇴|삭제|지우기|영구|pay|purchase|buy|checkout|order|transfer|withdraw|delete|remove|destroy|unsubscribe|close account)/i

export interface ConnectedSite {
  key: string
  name: string
  domain: string
  connectedAt: string
}

export class SiteStore {
  private list_: ConnectedSite[]
  constructor(private readonly file: string) {
    try {
      this.list_ = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []
    } catch {
      this.list_ = []
    }
  }
  list(): ConnectedSite[] {
    return this.list_.map((x) => ({ ...x }))
  }
  upsert(s: SiteDef): ConnectedSite {
    const c: ConnectedSite = { key: s.key, name: s.name, domain: s.domain, connectedAt: new Date().toISOString() }
    this.list_ = [...this.list_.filter((x) => x.key !== s.key), c]
    this.save()
    return c
  }
  remove(key: string): ConnectedSite | null {
    const c = this.list_.find((x) => x.key === key) ?? null
    this.list_ = this.list_.filter((x) => x.key !== key)
    this.save()
    return c
  }
  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(this.list_, null, 2))
  }
}

