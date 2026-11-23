# J.A.R.V.I.S.

Mac / Windows 데스크톱 AI 비서. "자비스"라고 부르면 듣고, 말로 답하고, 홀로그램 HUD 와 손 제스처로 조작한다.
Claude · GPT(Codex) · Gemini 를 각 사 공식 로그인으로 연결해 쓰고, 여러 프로젝트를 세션별로 나눠 동시에 작업시킨 뒤 JARVIS 한 목소리로 보고받는다.

## 할 수 있는 것

| 분류 | 예시 |
| --- | --- |
| 음성 | "자비스, 오늘 할 일 정리해줘" — 로컬 Whisper 인식, TTS 응답, 주먹 제스처/⌘⇧J 로 호출 |
| 여러 프로젝트 | "xcroll-be 랑 xcroll-app 열어줘", "be 에 API 추가하고 app 에서 호출하게 해줘" → 세션별 병렬/순차 실행 후 한 답변 |
| 코딩 (Claude) | Claude Code 와 같은 엔진: 파일 읽기/수정, Bash, CLAUDE.md, 세션 유지 |
| Git | 상태/디프/스테이징/커밋/푸시 패널, AI 커밋 메시지. **commit / push / 파괴적 명령은 항상 승인 창** |
| 승인 | 클릭 또는 말로 — "응", "그렇게 해", "하지 마", "잠깐" … 애매한 대답은 AI 가 판정하고 표현을 학습 |
| 시스템 | "크롬 열어줘", "카톡 종료해줘", "다운로드 폴더 열어줘", "유튜브 열어줘", 스크린샷·클립보드·알림 |
| 모델 연결 | "클로드 연결해줘", "지피티로 바꿔줘", "모델 연결 상태 알려줘". 끊겨 있으면 JARVIS 가 스스로 로그인 창을 열고 원래 요청을 이어서 처리 |
| 사이트 로그인 | "깃허브 로그인해줘" → JARVIS 브라우저에서 한 번 로그인 → 이후 그 세션으로 페이지 읽기/클릭/입력 (비밀번호는 저장하지 않음, 결제·삭제성 클릭은 승인) |
| 카메라 | 손바닥 = 홀로그램을 손 위로, 집고 이동 = 회전, 양손 집기 = 확대/축소, 주먹 유지 = 호출 |
| 되묻기 | 작업 중 필요한 선택·정보를 말/화면으로 물어보고 답으로 진행. 비밀번호·인증번호는 보안 입력 (AI·기록에 안 남음) |
| 목소리 | "목소리 바꿔줘" → 선택지 중 고르기, "좀 더 빠르게/낮게", "목소리 더 내려받기" |
| 웹 팝업 | 홀로그램 위에 뜨는 JARVIS 브라우저 창 (이동/크기 조절). "구글로 로그인해" → 계정 물어보고 진행 |
| 테스트 기기 | "아이폰 시뮬레이터 띄워줘", "에뮬레이터 띄워서 앱 확인해" → JARVIS 팝업에 화면, 탭/스와이프/입력 (아이폰 터치는 AXe, 실제 마우스 안 건드림) |
| 데스크톱 조작 | 화면 보고 클릭·입력·단축키. 카톡/슬랙 메시지는 화면 확인 후 승인받고 전송 |
| 안드로이드 출시 | "안드로이드 출시해" → Play Console 로그인(되어 있으면 생략) → 트랙 질문 → AAB 업로드 → 출시 노트 확인 → **최종 승인** → 검토 전송 |
| 학습 | 모든 대화 기록 → 사용자 선호/사실을 기억으로 추출해 모든 세션에 주입. "기억" 탭에서 확인/삭제 |
| 이력 | 로그인·승인·커밋·푸시·파일 수정·앱 실행·기억 변경 등 전부 append-only 로그 ("이력" 탭) |

## 권한 (macOS, 최초 1회)

- **손쉬운 사용**: 키보드/마우스 조작 (카톡·슬랙 메시지, 데스크톱 클릭)
- **화면 및 시스템 오디오 기록**: 화면 캡처 (필요할 때 JARVIS 가 설정 화면을 직접 엽니다)
- 카메라 / 마이크
- 아이폰 시뮬레이터 터치: `brew tap cameroncooke/axe && brew trust --formula cameroncooke/axe/axe && brew install axe`

## 로컬 실행 (개발)

데스크톱 GUI + 카메라/마이크 앱이라 Docker 가 아닌 호스트에서 실행한다.

```bash
npm install
npm run dev        # 개발 실행 (VS Code 터미널에서도 동작하도록 ELECTRON_RUN_AS_NODE 자동 제거)
```

처음 마이크를 켜면 Whisper 음성 모델(약 250MB)을 한 번 내려받는다.

## 테스트

```bash
npm test           # 단위 테스트
npm run test:live  # 실제 Claude / Codex 호출 스모크 테스트 (토큰 사용)
npm run e2e        # 실제 앱을 띄워 전체 시나리오 검증 (macOS, 토큰 사용, 계산기·브라우저가 잠깐 열림)
node tests/e2e/autonomy.mjs   # 자율 기능: 되묻기/목소리/웹 팝업/아이폰·안드로이드/메시지 승인/가짜 Play Console 출시
```

## 설치 파일 빌드

```bash
npm run dist:mac   # dist/*.dmg
npm run dist:win   # dist/*.exe — Windows 에서 실행 (플랫폼별 네이티브 바이너리 필요)
```

`.github/workflows/build.yml` 은 macOS / Windows 러너에서 각각 빌드한다.

## 데이터 위치 (`userData`)

- macOS: `~/Library/Application Support/jarvis/`
- Windows: `%APPDATA%\jarvis\`

| 파일 | 내용 |
| --- | --- |
| `audit/audit.jsonl` | 이력 (append-only) |
| `memory/conversations.jsonl` | 전체 대화 기록 |
| `memory/memory.json` | 학습한 기억 |
| `memory/approval-lexicon.json` | 학습한 승인 대답 표현 |
| `secrets.json` | API 키 (OS 키체인으로 암호화) |
| `sites.json` | 로그인 연동된 사이트 목록 (쿠키는 Electron 세션에 저장) |
