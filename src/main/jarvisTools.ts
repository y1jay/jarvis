// Claude 에게 주는 JARVIS 도구 (in-process MCP 서버). 모든 실행형 호출은 이력에 남는다.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { AuditInput } from './audit'
import { SENSITIVE_CLICK, type JarvisBrowser } from './browser'
import { activateApp, click as mouseClick, discardPrepared, keyCombo, prepareMessage, resolveMessenger, sendPrepared, typeText } from './computer'
import type { DeviceHub, Platform } from './devices'
import { listApps, openApp, openFile, openUrl, quitApp, resolveApp, resolveFolder, revealPath, screenshot } from './system'
import { normalizeCode, type QuestionKind } from './asker'

export interface JarvisToolHost {
  audit: (i: AuditInput) => void
  requestProjectSwitch: (query: string) => Promise<{ path?: string; message: string }>
  clipboardRead: () => string | Promise<string>
  clipboardWrite: (t: string) => void
  notify: (title: string, body: string) => void
  browser: JarvisBrowser
  devices: DeviceHub
  /** 사용자 승인 (이미지 첨부 가능) */
  approve: (title: string, detail: string, kind?: 'destructive' | 'tool', image?: string) => Promise<boolean>
  /** 사용자에게 되묻기 */
  ask: (question: string, opts: { kind?: QuestionKind; options?: string[] }) => Promise<string | null>
  siteLogin: (site: string) => Promise<string>
  startDevice: (platform?: Platform, name?: string) => Promise<string>
  stopDevice: () => Promise<string>
}

const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], isError })
const guard = async (fn: () => Promise<ReturnType<typeof text>>): Promise<ReturnType<typeof text>> => {
  try {
    return await fn()
  } catch (e) {
    return text((e as Error).message, true)
  }
}

/** 출시/전송/제출 등 되돌리기 어려운 웹 동작 */
export const FINAL_ACTION = /(검토를 위해|검토\s*전송|출시\s*시작|출시하기|게시하기|send for review|start rollout|roll\s*out|publish|submit|제출|전송하기)/i

export function createJarvisTools(host: JarvisToolHost) {
  const clip = { read: host.clipboardRead, write: host.clipboardWrite }
  return createSdkMcpServer({
    name: 'jarvis',
    version: '2.0.0',
    instructions: [
      'JARVIS 데스크톱 제어 도구. 사용자의 컴퓨터에서 거의 모든 일을 직접 수행한다.',
      '- 사용자 선택/정보가 필요하면 추측하지 말고 ask_user 로 묻는다 (선택지가 있으면 options 제공).',
      '- 웹 작업은 JARVIS 내장 브라우저(browser_*)를 쓴다 — 로그인 세션이 유지되고 사용자 화면에 보인다.',
      '- 비밀번호/인증번호는 browser_fill_secret 또는 type_secret 으로만 입력한다. 값을 ask_user 로 묻지 않는다.',
      '- "구글로 로그인": 페이지의 "Google로 로그인/Sign in with Google" 을 클릭 → 계정 선택 화면이면 계정 목록을 ask_user(options) 로 묻고 클릭 → 비밀번호는 browser_fill_secret.',
      '- 데스크톱 앱 조작은 screenshot → Read 로 화면 확인 → click/type_text/key. 카톡/슬랙 메시지는 send_message.',
      '- 앱 확인은 device_* 도구 (안드로이드 에뮬레이터 / 아이폰 시뮬레이터). 화면은 device_screenshot 후 Read 로 보고, 좌표는 그 이미지 픽셀 기준. iOS 는 device_tap_label 로 버튼 이름을 눌러도 된다.'
    ].join('\n'),
    tools: [
      // ── 되묻기 ──
      tool('ask_user', '사용자에게 질문하고 음성/텍스트 답을 기다린다. 선택지가 있으면 options 로 준다.', { question: z.string(), options: z.array(z.string()).optional() }, async ({ question, options }) => {
        const a = await host.ask(question, { kind: options?.length ? 'choice' : 'text', options })
        return a === null ? text('사용자가 답하지 않았습니다 (취소/시간 초과). 진행을 멈추고 보고하세요.', true) : text(`사용자 답변: ${a}`)
      }),

      // ── 앱 / 파일 / 시스템 ──
      tool('list_apps', '설치된 앱 목록 (이름 필터 가능)', { query: z.string().optional() }, async ({ query }) => {
        const q = query?.toLowerCase()
        return text(listApps().map((a) => a.name).filter((n) => !q || n.toLowerCase().includes(q)).slice(0, 300).join('\n') || '(없음)')
      }),
      tool('open_app', '앱 실행. 한국어 이름(크롬, 카톡, 슬랙 등)도 가능', { name: z.string() }, async ({ name }) => {
        const app = resolveApp(name, listApps())
        if (!app) return text(`앱을 찾지 못했습니다: ${name}. list_apps 로 확인하세요.`, true)
        const r = await openApp(app)
        host.audit({ action: 'system.app.open', provider: 'claude', target: app.name, detail: { query: name, ok: r.ok, via: 'claude-tool' } })
        return text(r.message, !r.ok)
      }),
      tool('quit_app', '앱 정상 종료 요청 (강제 종료 아님)', { name: z.string() }, async ({ name }) => {
        const app = resolveApp(name, listApps())
        const r = await quitApp(app?.name ?? name)
        host.audit({ action: 'system.app.quit', provider: 'claude', target: app?.name ?? name, detail: { ok: r.ok, via: 'claude-tool' } })
        return text(r.message, !r.ok)
      }),
      tool('open_url_external', '사용자의 기본 브라우저(크롬 등)로 URL 열기. 보통은 browser_open(JARVIS 내장) 을 쓴다.', { url: z.string() }, async ({ url }) => {
        const r = await openUrl(url)
        host.audit({ action: 'system.url.open', provider: 'claude', target: url, detail: { ok: r.ok, via: 'external' } })
        return text(r.message, !r.ok)
      }),
      tool('open_path', '폴더를 Finder/탐색기로 열거나 파일을 기본 앱으로 연다. "다운로드" 같은 별칭 가능', { path: z.string(), reveal_only: z.boolean().optional() }, async ({ path, reveal_only }) => {
        const p = resolveFolder(path) ?? path
        const r = reveal_only ? await revealPath(p) : await openFile(p)
        host.audit({ action: 'system.path.open', provider: 'claude', target: p, detail: { ok: r.ok, via: 'claude-tool' } })
        return text(r.message, !r.ok)
      }),
      tool('open_project', 'JARVIS 작업 프로젝트(세션) 전환. 이번 응답이 끝난 뒤 적용', { query: z.string() }, async ({ query }) => {
        const r = await host.requestProjectSwitch(query)
        return text(r.message, !r.path)
      }),
      tool('screenshot', '현재 화면 전체 캡처 → PNG 경로 (Read 로 보기). Retina 화면은 이미지 픽셀이 화면 좌표의 2배일 수 있다', {}, async () => {
        const r = await screenshot()
        host.audit({ action: 'system.screenshot', provider: 'claude', target: r.path, detail: { ok: r.ok } })
        return text(r.message, !r.ok)
      }),
      tool('clipboard_read', '클립보드 텍스트 읽기', {}, async () => text((await host.clipboardRead()) || '(비어 있음)')),
      tool('clipboard_write', '클립보드에 텍스트 쓰기', { text: z.string() }, async ({ text: t }) => {
        host.clipboardWrite(t)
        host.audit({ action: 'system.clipboard.write', provider: 'claude', detail: { length: t.length } })
        return text('클립보드에 복사했습니다.')
      }),
      tool('notify', '데스크톱 알림', { title: z.string(), body: z.string() }, async ({ title, body }) => {
        host.notify(title, body)
        return text('알림을 보냈습니다.')
      }),

      // ── 데스크톱 입력 ──
      tool('activate_app', '앱을 맨 앞으로 가져온다', { name: z.string() }, async ({ name }) =>
        guard(async () => {
          const app = resolveApp(name, listApps())
          const r = await activateApp(app?.name ?? name)
          return text(r.code === 0 ? `${app?.name ?? name} 활성화` : r.out, r.code !== 0)
        })
      ),
      tool('type_text', '현재 포커스된 곳에 텍스트 입력 (붙여넣기 방식, 한글 가능)', { text: z.string() }, async ({ text: t }) =>
        guard(async () => {
          const r = await typeText(t, clip)
          host.audit({ action: 'system.input', provider: 'claude', detail: { kind: 'type', length: t.length } })
          return text(r.code === 0 ? '입력했습니다.' : r.out, r.code !== 0)
        })
      ),
      tool('type_secret', '비밀번호/인증번호를 사용자에게 보안 입력으로 받아 현재 포커스된 칸에 입력 (값은 AI 에게 보이지 않음)', { question: z.string(), kind: z.enum(['secret', 'code']).optional(), press_enter: z.boolean().optional() }, async ({ question, kind, press_enter }) =>
        guard(async () => {
          const v = await host.ask(question, { kind: kind ?? 'secret' })
          if (v === null) return text('사용자가 입력하지 않았습니다.', true)
          await typeText(kind === 'code' ? normalizeCode(v) : v, clip)
          if (press_enter) await keyCombo('enter')
          host.audit({ action: 'system.input', provider: 'claude', detail: { kind: `secret:${kind ?? 'secret'}` } })
          return text('입력했습니다 (값은 비공개).')
        })
      ),
      tool('key', '키 입력. 예: "enter", "cmd+f", "ctrl+shift+t", "escape", "tab"', { combo: z.string() }, async ({ combo }) =>
        guard(async () => {
          const r = await keyCombo(combo)
          return text(r.code === 0 ? combo : r.out, r.code !== 0)
        })
      ),
      tool('click', '화면 좌표 클릭 (screenshot 으로 위치 확인 후)', { x: z.number(), y: z.number(), double: z.boolean().optional(), right: z.boolean().optional() }, async ({ x, y, double, right }) =>
        guard(async () => {
          const r = await mouseClick(x, y, { double, right })
          host.audit({ action: 'system.input', provider: 'claude', detail: { kind: 'click', x, y } })
          return text(r.code === 0 ? `클릭 ${x},${y}` : r.out, r.code !== 0)
        })
      ),
      tool('send_message', '카카오톡/슬랙 메시지 보내기: 대화방을 찾아 메시지를 입력한 뒤, 화면을 사용자에게 보여주고 승인받으면 전송', { app: z.string(), to: z.string(), message: z.string() }, async ({ app, to, message }) =>
        guard(async () => {
          const prof = resolveMessenger(app)
          if (!prof) return text(`지원하지 않는 메신저: ${app} (카카오톡, 슬랙). 다른 앱은 activate_app/type_text/key 로 직접 조작하세요.`, true)
          const installed = listApps()
          const appName = prof.apps.map((n) => resolveApp(n, installed)?.name).find(Boolean) ?? prof.apps[0]
          const prep = await prepareMessage(prof, appName, to, message, clip)
          if (prep.code !== 0) return text(prep.out, true)
          const shot = await screenshot()
          const ok = await host.approve(
            `${prof.name} 메시지 전송`,
            `받는 사람: ${to}\n메시지:\n${message}\n\n${shot.ok ? '화면에서 대화방이 맞는지 확인해 주세요.' : `(화면 캡처 불가: ${shot.message}) ${prof.name} 창에서 대화방이 맞는지 직접 확인해 주세요.`}`,
            'tool',
            shot.path
          )
          if (!ok) {
            await activateApp(appName)
            await discardPrepared()
            host.audit({ action: 'message.send', provider: 'claude', target: `${prof.key}:${to}`, detail: { sent: false, length: message.length } })
            return text('사용자가 전송을 거부해 입력한 메시지를 지웠습니다. 다시 시도하지 마세요.', true)
          }
          await activateApp(appName)
          const r = await sendPrepared()
          host.audit({ action: 'message.send', provider: 'claude', target: `${prof.key}:${to}`, detail: { sent: r.code === 0, length: message.length } })
          return text(r.code === 0 ? `${prof.name}: ${to} 에게 전송했습니다.` : r.out, r.code !== 0)
        })
      ),

      // ── JARVIS 내장 브라우저 ──
      tool('browser_login', '사이트 로그인 연동: 로그인 페이지를 JARVIS 브라우저에 띄우고 로그인 완료까지 대기 (github, notion, slack, google, naver, 도메인 등)', { site: z.string() }, async ({ site }) => text(await host.siteLogin(site))),
      tool('browser_open', 'JARVIS 내장 브라우저(로그인 세션 유지, 사용자 화면에 보임)로 URL 열기', { url: z.string() }, async ({ url }) =>
        guard(async () => {
          const s = await host.browser.open(url)
          host.audit({ action: 'system.url.open', provider: 'claude', target: s.url, detail: { via: 'jarvis-browser' } })
          return text(`열림: ${s.title} (${s.url})`)
        })
      ),
      tool('browser_read', '현재 페이지 텍스트와 클릭/입력 가능한 요소 목록', {}, async () => guard(async () => text(await host.browser.read()))),
      tool('browser_click', '보이는 텍스트 또는 CSS 선택자로 클릭. 결제/삭제/출시/전송 같은 최종 동작은 사용자 승인 필요', { target: z.string() }, async ({ target }) =>
        guard(async () => {
          const t = await host.browser.describeTarget(target)
          if (!t) return text(`NOT_FOUND: ${target} — browser_read 로 정확한 텍스트를 확인하세요.`, true)
          const label = t.label || target
          if (SENSITIVE_CLICK.test(label) || FINAL_ACTION.test(label)) {
            const shot = await host.browser.screenshot()
            const ok = await host.approve('최종 웹 동작 승인', `클릭: "${label}"\nURL: ${host.browser.state().url}\n\n되돌리기 어려운 동작입니다.`, 'destructive', shot)
            host.audit({ action: 'system.web.final', provider: 'claude', target: label, detail: { url: host.browser.state().url, approved: ok } })
            if (!ok) return text('사용자가 거부했습니다. 다시 시도하지 말고 보고하세요.', true)
          }
          return text(await host.browser.click(target))
        })
      ),
      tool('browser_type', '입력칸(보이는 라벨/placeholder 또는 CSS 선택자)에 텍스트 입력. 비밀번호 칸 불가 → browser_fill_secret', { target: z.string(), text: z.string(), submit: z.boolean().optional() }, async ({ target, text: t, submit }) => guard(async () => text(await host.browser.type(target, t, submit ?? false)))),
      tool('browser_fill_secret', '비밀번호/인증번호 칸: 사용자에게 보안 입력으로 받아 바로 채운다 (값은 AI 에게 보이지 않음)', { target: z.string(), question: z.string(), kind: z.enum(['secret', 'code']).optional(), submit: z.boolean().optional() }, async ({ target, question, kind, submit }) =>
        guard(async () => {
          const v = await host.ask(question, { kind: kind ?? 'secret' })
          if (v === null) return text('사용자가 입력하지 않았습니다.', true)
          const r = await host.browser.fillSecret(target, kind === 'code' ? normalizeCode(v) : v, submit ?? false)
          host.audit({ action: 'system.input', provider: 'claude', target: host.browser.state().url, detail: { kind: `web-secret:${kind ?? 'secret'}` } })
          return text(r)
        })
      ),
      tool('browser_upload', '파일 업로드 칸(input[type=file])에 로컬 파일 지정', { files: z.array(z.string()), selector: z.string().optional() }, async ({ files, selector }) =>
        guard(async () => {
          const r = await host.browser.upload(selector ?? 'input[type=file]', files)
          host.audit({ action: 'system.web.upload', provider: 'claude', target: host.browser.state().url, detail: { files } })
          return text(r)
        })
      ),
      tool('browser_navigate', '뒤로/앞으로/새로고침', { action: z.enum(['back', 'forward', 'reload']) }, async ({ action }) =>
        guard(async () => {
          if (action === 'back') host.browser.back()
          else if (action === 'forward') host.browser.forward()
          else host.browser.reload()
          await new Promise((r) => setTimeout(r, 1200))
          return text(host.browser.state().url)
        })
      ),
      tool('browser_screenshot', '내장 브라우저 화면 캡처 → PNG 경로 (Read 로 보기)', {}, async () => guard(async () => text(await host.browser.screenshot()))),

      // ── 테스트 기기 (안드로이드 에뮬레이터 / 아이폰 시뮬레이터) ──
      tool('device_list', '사용 가능한 기기 목록 (아이폰 시뮬레이터, 안드로이드 AVD)', {}, async () =>
        guard(async () => text((await host.devices.choices()).map((c) => `${c.platform}: ${c.label}`).join('\n') || '(없음)'))
      ),
      tool('device_start', '기기 실행 (JARVIS 팝업에 화면 표시). platform 생략 시 아이폰 시뮬레이터(기본값). 안드로이드는 사용자가 안드로이드를 요청했을 때만', { platform: z.enum(['ios', 'android']).optional(), name: z.string().optional() }, async ({ platform, name }) => text(await host.startDevice(platform, name))),
      tool('device_stop', '기기 끄기 (JARVIS 가 켠 것만 종료)', {}, async () => text(await host.stopDevice())),
      tool('device_screenshot', '기기 화면 캡처 → PNG 경로 (Read 로 보기). 탭 좌표는 이 이미지 픽셀 기준', {}, async () => guard(async () => text(await host.devices.screenshotFile()))),
      tool('device_tap', '화면 탭 (스크린샷 픽셀 좌표)', { x: z.number(), y: z.number() }, async ({ x, y }) => guard(async () => text(await host.devices.tap(x, y)))),
      tool('device_tap_label', 'iOS: 접근성 라벨(화면에 보이는 버튼/앱 이름)로 탭', { label: z.string() }, async ({ label }) => guard(async () => text(await host.devices.tapLabel(label)))),
      tool('device_swipe', '스와이프 (픽셀 좌표)', { x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number() }, async ({ x1, y1, x2, y2 }) => guard(async () => text(await host.devices.swipe(x1, y1, x2, y2)))),
      tool('device_type', '포커스된 입력칸에 텍스트 입력 (안드로이드는 영문/숫자)', { text: z.string() }, async ({ text: t }) => guard(async () => text(await host.devices.type(t)))),
      tool('device_key', '버튼: home, back(안드로이드), recent(안드로이드), enter', { key: z.string() }, async ({ key }) => guard(async () => text(await host.devices.key(key)))),
      tool('device_ui', '화면 요소 트리 (iOS 접근성 / 안드로이드 uiautomator)', {}, async () => guard(async () => text((await host.devices.describe()).slice(0, 30000)))),
      tool('device_install', '앱 설치 (.apk / iOS .app)', { path: z.string() }, async ({ path }) => guard(async () => text(await host.devices.install(path)))),
      tool('device_launch', '앱 실행 (안드로이드 패키지명 / iOS 번들 ID)', { id: z.string() }, async ({ id }) => guard(async () => text(await host.devices.launch(id))))
    ]
  })
}

export const JARVIS_TOOL_NAMES = [
  'ask_user', 'list_apps', 'open_app', 'quit_app', 'open_url_external', 'open_path', 'open_project', 'screenshot', 'clipboard_read', 'clipboard_write', 'notify',
  'activate_app', 'type_text', 'type_secret', 'key', 'click', 'send_message',
  'browser_login', 'browser_open', 'browser_read', 'browser_click', 'browser_type', 'browser_fill_secret', 'browser_upload', 'browser_navigate', 'browser_screenshot',
  'device_list', 'device_start', 'device_stop', 'device_screenshot', 'device_tap', 'device_tap_label', 'device_swipe', 'device_type', 'device_key', 'device_ui', 'device_install', 'device_launch'
].map((t) => `mcp__jarvis__${t}`)
