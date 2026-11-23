// JARVIS 내장 브라우저: 메인 창 가운데(스테이지)에 붙는 WebContentsView. 영구 세션(로그인 유지).
// 클릭/입력/업로드는 CDP 로 실제 입력 이벤트를 보내 React/Angular 같은 웹앱에서도 동작한다.
// 비밀번호·인증번호는 fillSecret 으로만 입력 — AI 는 값을 보지 못한다.
import { WebContentsView, session as electronSession, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { type SiteDef } from './sites'

export { resolveSiteDef, SENSITIVE_CLICK, SiteStore, SITES, type SiteDef, type ConnectedSite } from './sites'

export const PARTITION = 'persist:jarvis-web'

export interface BrowserState {
  open: boolean
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
}

export interface BrowserHost {
  window: () => BrowserWindow | null
  /** 스테이지를 브라우저 모드로 전환 요청 (renderer 가 영역 좌표를 보내 준다) */
  requestShow: () => void
  onState: (s: BrowserState) => void
}

interface Target {
  x: number
  y: number
  label: string
  tag: string
  type: string
}

const LOCATE_JS = (target: string) => `(() => {
  const t = ${JSON.stringify(target)};
  const visible = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const label = (e) => ((e.innerText || e.value || e.getAttribute('aria-label') || e.getAttribute('title') || e.getAttribute('placeholder') || e.getAttribute('data-identifier') || e.tagName) + '').trim().replace(/\\s+/g, ' ');
  let el = null;
  try { el = [...document.querySelectorAll(t)].find(visible) || null } catch {}
  if (!el) {
    const lt = t.toLowerCase();
    // 실제로 동작하는 요소(링크/버튼/입력)를 먼저, 그 다음 일반 요소. 같은 조건이면 더 작은(안쪽) 요소.
    const primary = [...document.querySelectorAll('a[href],button,[role=button],[role=link],[role=tab],[role=option],[role=menuitem],[role=radio],[role=checkbox],input,textarea,select,summary,[data-identifier]')].filter(visible);
    const secondary = [...document.querySelectorAll('label,li,[tabindex],[onclick]')].filter(visible);
    const area = (e) => { const r = e.getBoundingClientRect(); return r.width * r.height; };
    const pick = (list, fn) => list.filter(fn).sort((a, b) => area(a) - area(b))[0] || null;
    el = pick(primary, e => label(e).toLowerCase() === lt) || pick(primary, e => label(e).toLowerCase().includes(lt))
      || pick(secondary, e => label(e).toLowerCase() === lt) || pick(secondary, e => label(e).toLowerCase().includes(lt));
    // 일반 요소가 잡히면 그 안의 링크/버튼을 누른다
    if (el && !primary.includes(el)) el = el.querySelector('a[href],button,[role=button],input') || el;
  }
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, label: label(el).slice(0, 120), tag: el.tagName.toLowerCase(), type: (el.getAttribute('type') || '').toLowerCase() };
})()`

export class JarvisBrowser {
  private view: WebContentsView | null = null
  private loginCancelled = false

  constructor(private readonly host: BrowserHost) {}

  get isOpen(): boolean {
    return !!this.view && !this.view.webContents.isDestroyed()
  }

  private ensure(): WebContentsView {
    if (this.view && !this.view.webContents.isDestroyed()) return this.view
    const win = this.host.window()
    if (!win) throw new Error('JARVIS 창이 없습니다.')
    const view = new WebContentsView({ webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false } })
    view.setBackgroundColor('#ffffff')
    view.setVisible(false)
    win.contentView.addChildView(view)
    const wc = view.webContents
    const emit = (): void => this.host.onState(this.state())
    wc.on('did-navigate', emit)
    wc.on('did-navigate-in-page', emit)
    wc.on('page-title-updated', emit)
    wc.on('did-start-loading', emit)
    wc.on('did-stop-loading', emit)
    // 새 창 요청(OAuth 팝업 등)은 같은 뷰에서 연다
    wc.setWindowOpenHandler(({ url }) => {
      void wc.loadURL(url)
      return { action: 'deny' }
    })
    this.view = view
    return view
  }

  state(): BrowserState {
    if (!this.isOpen) return { open: false, url: '', title: '', canGoBack: false, canGoForward: false, loading: false }
    const wc = this.view!.webContents
    return { open: true, url: wc.getURL(), title: wc.getTitle(), canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward(), loading: wc.isLoading() }
  }

  /** renderer 가 알려준 스테이지 영역에 맞춘다. null 이면 숨김 (모달이 떠 있을 때 등) */
  setBounds(rect: { x: number; y: number; width: number; height: number } | null): void {
    if (!this.isOpen) return
    if (!rect || rect.width < 10 || rect.height < 10) {
      this.view!.setVisible(false)
      return
    }
    this.view!.setBounds({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) })
    this.view!.setVisible(true)
  }

  async open(url: string): Promise<BrowserState> {
    if (!/^[a-z]+:\/\//i.test(url)) url = `https://${url}`
    const v = this.ensure()
    this.host.requestShow()
    await v.webContents.loadURL(url).catch(() => undefined)
    return this.state()
  }

  back(): void {
    if (this.isOpen && this.view!.webContents.navigationHistory.canGoBack()) this.view!.webContents.navigationHistory.goBack()
  }
  forward(): void {
    if (this.isOpen && this.view!.webContents.navigationHistory.canGoForward()) this.view!.webContents.navigationHistory.goForward()
  }
  reload(): void {
    if (this.isOpen) this.view!.webContents.reload()
  }

  close(): void {
    this.loginCancelled = true
    if (!this.view) return
    const win = this.host.window()
    try {
      win?.contentView.removeChildView(this.view)
    } catch {
      /* ignore */
    }
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close()
    this.view = null
    this.host.onState(this.state())
  }

  /**
   * 로그인 페이지를 띄우고 사용자가(또는 JARVIS 가 사용자 답변으로) 로그인을 마칠 때까지 기다린다.
   * 완료: 해당 사이트에서 로그인 경로를 벗어나 2초 유지 + 쿠키 존재. 브라우저를 닫으면 취소.
   */
  async login(site: SiteDef, timeoutMs = 15 * 60_000): Promise<{ ok: boolean; reason: string }> {
    this.loginCancelled = false
    await this.open(site.url)
    const started = Date.now()
    let awaySince = 0
    for (;;) {
      await new Promise((r) => setTimeout(r, 700))
      if (this.loginCancelled || !this.isOpen) return { ok: false, reason: 'cancelled' }
      const url = this.view!.webContents.getURL()
      let onLogin = true
      let onSite = false
      try {
        const u = new URL(url)
        onSite = u.hostname.endsWith(site.domain)
        onLogin = site.loginPath.test(u.pathname + u.hostname)
      } catch {
        /* about:blank */
      }
      if (onSite && !onLogin && (await this.hasCookies(site.domain))) {
        awaySince ||= Date.now()
        if (Date.now() - awaySince > 2000) return { ok: true, reason: 'logged-in' }
      } else awaySince = 0
      if (Date.now() - started > timeoutMs) return { ok: false, reason: 'timeout' }
    }
  }

  async hasCookies(domain: string): Promise<boolean> {
    return (await electronSession.fromPartition(PARTITION).cookies.get({ domain })).length > 0
  }

  async logout(domain: string): Promise<number> {
    const ses = electronSession.fromPartition(PARTITION)
    const cookies = await ses.cookies.get({ domain })
    for (const c of cookies) {
      const url = `http${c.secure ? 's' : ''}://${(c.domain ?? domain).replace(/^\./, '')}${c.path ?? '/'}`
      await ses.cookies.remove(url, c.name).catch(() => undefined)
    }
    return cookies.length
  }

  private get wc() {
    if (!this.isOpen) throw new Error('JARVIS 브라우저가 열려 있지 않습니다. browser_open 으로 먼저 여세요.')
    return this.view!.webContents
  }

  private async cdp<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const d = this.wc.debugger
    if (!d.isAttached()) d.attach('1.3')
    return d.sendCommand(method, params) as Promise<T>
  }

  async read(maxChars = 20000): Promise<string> {
    const wc = this.wc
    const text: string = await wc.executeJavaScript('document.body ? document.body.innerText : ""')
    const controls: Array<{ t: string; k: string }> = await wc.executeJavaScript(
      `[...document.querySelectorAll('a[href],button,[role=button],input,textarea,select,[role=tab],[role=option]')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0}).slice(0,120).map(e=>({t:((e.innerText||e.value||e.getAttribute('aria-label')||e.getAttribute('placeholder')||e.getAttribute('name')||'')+'').trim().replace(/\\s+/g,' ').slice(0,60),k:e.tagName.toLowerCase()+(e.type?':'+e.type:'')+(e.id?'#'+e.id:'')+(e.name?'[name='+e.name+']':'')}))`
    )
    return `URL: ${wc.getURL()}\nTITLE: ${wc.getTitle()}\n\n${text.slice(0, maxChars)}\n\n[CONTROLS]\n${controls.map((c) => `- ${c.k} "${c.t}"`).join('\n')}`
  }

  async describeTarget(target: string): Promise<Target | null> {
    return this.wc.executeJavaScript(LOCATE_JS(target))
  }

  async click(target: string): Promise<string> {
    const t = await this.describeTarget(target)
    if (!t) return `NOT_FOUND: ${target}`
    await new Promise((r) => setTimeout(r, 120))
    const t2 = (await this.describeTarget(target)) ?? t // 스크롤 후 좌표 갱신
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await this.cdp('Input.dispatchMouseEvent', { type, x: t2.x, y: t2.y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 })
    }
    await new Promise((r) => setTimeout(r, 900))
    return `CLICKED "${t2.label}" → URL: ${this.wc.getURL()}`
  }

  private async focus(selector: string): Promise<Target | null> {
    const t = await this.describeTarget(selector)
    if (!t) return null
    await this.wc.executeJavaScript(`(() => { let el=null; try{el=document.querySelector(${JSON.stringify(selector)})}catch{}; if(!el) el=document.activeElement; el && el.focus && el.focus(); if (el && el.select) try{el.select()}catch{}; })()`)
    for (const type of ['mousePressed', 'mouseReleased']) await this.cdp('Input.dispatchMouseEvent', { type, x: t.x, y: t.y, button: 'left', clickCount: 1 })
    // 기존 값 지우기
    await this.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: process.platform === 'darwin' ? 4 : 2, windowsVirtualKeyCode: 65 })
    await this.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: process.platform === 'darwin' ? 4 : 2, windowsVirtualKeyCode: 65 })
    await this.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
    await this.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
    return t
  }

  async pressEnter(): Promise<void> {
    await this.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
    await this.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  }

  async type(selector: string, text: string, submit = false): Promise<string> {
    const t = await this.describeTarget(selector)
    if (!t) return `NOT_FOUND: ${selector}`
    if (t.type === 'password') return 'REFUSED: 비밀번호 칸은 browser_fill_secret 으로 사용자에게 물어서 입력하세요.'
    await this.focus(selector)
    await this.cdp('Input.insertText', { text })
    if (submit) await this.pressEnter()
    await new Promise((r) => setTimeout(r, 400))
    return `TYPED into "${t.label || selector}"${submit ? ' + Enter' : ''}`
  }

  /** 비밀값 입력 (반환값에 값 미포함) */
  async fillSecret(selector: string, value: string, submit = false): Promise<string> {
    const t = await this.focus(selector)
    if (!t) return `NOT_FOUND: ${selector}`
    await this.cdp('Input.insertText', { text: value })
    if (submit) await this.pressEnter()
    await new Promise((r) => setTimeout(r, 400))
    return `FILLED secret into "${t.label || selector}"${submit ? ' + Enter' : ''}`
  }

  async upload(selector: string, files: string[]): Promise<string> {
    const doc = await this.cdp<{ root: { nodeId: number } }>('DOM.getDocument', { depth: -1, pierce: true })
    const q = await this.cdp<{ nodeId: number }>('DOM.querySelector', { nodeId: doc.root.nodeId, selector: selector || 'input[type=file]' })
    if (!q.nodeId) return `NOT_FOUND: ${selector}`
    await this.cdp('DOM.setFileInputFiles', { nodeId: q.nodeId, files })
    await new Promise((r) => setTimeout(r, 800))
    return `UPLOADED ${files.map((f) => f.split(/[\\/]/).pop()).join(', ')}`
  }

  async screenshot(): Promise<string> {
    const img = await this.wc.capturePage()
    const file = join(tmpdir(), `jarvis-browser-${Date.now()}.png`)
    writeFileSync(file, img.toPNG())
    return file
  }
}
