// 테스트 전용 가짜 Google Play Console. 실제 콘솔에는 절대 접속하지 않는다.
// 흐름: /console (세션 없으면 /signin 계정 선택 → /password) → 앱 → 트랙 → 새 버전 → AAB 업로드 → 출시 노트 → 검토 → "검토를 위해 변경사항 전송"
import http from 'node:http'

const page = (title, body) => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:sans-serif;margin:24px}button,a.btn{display:inline-block;margin:6px 4px;padding:8px 14px;border:1px solid #1a73e8;border-radius:4px;background:#e8f0fe;color:#1a73e8;cursor:pointer;text-decoration:none}li{margin:6px 0}</style></head>
<body><h1>${title}</h1>${body}</body></html>`

export function startMockConsole() {
  const state = { signedInAs: null, password: null, track: null, uploaded: null, notes: null, submitted: false, events: [] }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const cookie = req.headers.cookie ?? ''
    const authed = /mock_session=ok/.test(cookie)
    const send = (html, code = 200, headers = {}) => {
      res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', ...headers })
      res.end(html)
    }
    const redirect = (to, headers = {}) => {
      res.writeHead(302, { location: to, ...headers })
      res.end()
    }
    const body = () => new Promise((r) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => r(new URLSearchParams(b))) })
    state.events.push(`${req.method} ${url.pathname}`)

    if (url.pathname === '/signin') {
      return send(page('Google 계정으로 로그인', `<p>계정 선택</p><ul>
        <li><a class="btn" href="/password?email=jarvis.test%40example.com" data-identifier="jarvis.test@example.com">Jarvis Test · jarvis.test@example.com</a></li>
        <li><a class="btn" href="/password?email=other%40example.com" data-identifier="other@example.com">Other · other@example.com</a></li></ul>`))
    }
    if (url.pathname === '/password' && req.method === 'GET') {
      const email = url.searchParams.get('email')
      return send(page('비밀번호 입력', `<p>${email}</p><form method="post" action="/password"><input type="hidden" name="email" value="${email}">
        <label>비밀번호 <input type="password" name="Passwd" aria-label="비밀번호 입력"></label><button type="submit">다음</button></form>`))
    }
    if (url.pathname === '/password' && req.method === 'POST') {
      const b = await body()
      state.signedInAs = b.get('email')
      state.password = b.get('Passwd')
      return redirect('/console', { 'set-cookie': 'mock_session=ok; Path=/' })
    }
    if (!authed) return redirect('/signin')

    if (url.pathname === '/console') {
      return send(page('Google Play Console', `<p>모든 앱</p><ul><li><a class="btn" href="/app/com.example.mockapp">Mock App (com.example.mockapp)</a></li></ul>`))
    }
    if (url.pathname === '/app/com.example.mockapp') {
      return send(page('Mock App — 대시보드', `<p>테스트 및 출시</p>
        <a class="btn" href="/app/com.example.mockapp/track/internal">내부 테스트</a>
        <a class="btn" href="/app/com.example.mockapp/track/closed">비공개 테스트</a>
        <a class="btn" href="/app/com.example.mockapp/track/production">프로덕션</a>`))
    }
    const tm = /^\/app\/com\.example\.mockapp\/track\/(internal|closed|production)$/.exec(url.pathname)
    if (tm) {
      const name = { internal: '내부 테스트', closed: '비공개 테스트', production: '프로덕션' }[tm[1]]
      return send(page(`${name} 트랙`, `<p>최근 버전: 11 (1.0.10)</p><a class="btn" href="/release/new?track=${tm[1]}">새 버전 만들기</a>`))
    }
    if (url.pathname === '/release/new') {
      const track = url.searchParams.get('track')
      return send(page('새 버전 만들기', `<p>트랙: ${track}</p>
        <form id="f" method="post" action="/release/save">
          <input type="hidden" name="track" value="${track}">
          <p>App Bundle <input type="file" id="aab" accept=".aab"></p>
          <input type="hidden" name="file" id="fname">
          <p id="status">업로드된 파일 없음</p>
          <label>출시 노트<br><textarea name="notes" aria-label="출시 노트" rows="4" cols="60"></textarea></label><br>
          <button type="submit">다음</button>
        </form>
        <script>document.getElementById('aab').addEventListener('change', e => { const f = e.target.files[0]; document.getElementById('fname').value = f ? f.name : ''; document.getElementById('status').textContent = f ? '업로드 완료: ' + f.name + ' (버전 코드 12)' : '업로드된 파일 없음'; });</script>`))
    }
    if (url.pathname === '/release/save' && req.method === 'POST') {
      const b = await body()
      state.track = b.get('track')
      state.uploaded = b.get('file')
      state.notes = b.get('notes')
      return redirect('/release/review')
    }
    if (url.pathname === '/release/review') {
      return send(page('버전 검토 및 출시', `<p>트랙: ${state.track}</p><p>App Bundle: ${state.uploaded || '(없음)'}</p><p>출시 노트: ${state.notes || '(없음)'}</p>
        <form method="post" action="/release/submit"><button type="submit">검토를 위해 변경사항 전송</button></form>`))
    }
    if (url.pathname === '/release/submit' && req.method === 'POST') {
      state.submitted = true
      return send(page('변경사항이 검토를 위해 전송되었습니다', `<p>트랙 ${state.track} · 버전 코드 12 · 상태: 검토 중</p>`))
    }
    send(page('404', '없음'), 404)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}/console`, state, close: () => server.close() })))
}
