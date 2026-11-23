// "안드로이드 출시해" → Google Play Console 출시 플레이북. Claude 가 JARVIS 도구(브라우저/터미널/되묻기)로 수행한다.
// 실제 출시와 직결되므로: 트랙 선택·출시 노트·최종 전송은 반드시 사용자 확인을 거친다.

export const PLAY_CONSOLE_URL = (): string => process.env.JARVIS_PLAY_CONSOLE_URL || 'https://play.google.com/console'

export function parseReleaseIntent(text: string): { platform: 'android'; hint: string } | null {
  const t = text.trim().replace(/[.!]+$/, '')
  if (!/(안드로이드|android|플레이\s*스토어|play\s*store|구글\s*플레이|google\s*play|플스|aab)/i.test(t)) return null
  // 명령형 출시 동사만 (설정/코드 수정 요청과 구분)
  const verb = /((출시|배포|릴리즈|릴리스|심사|검수)\s*(를|을)?\s*(해|하자|해줘|해라|해주세요|진행|시작|요청|올려)|(스토어|플레이\s*스토어|콘솔)에\s*올려|\b(publish|release|ship|deploy)\s+(it|the\s+app|to)\b)/i
  if (!verb.test(t)) return null
  if (/(설정|코드|스크립트|워크플로|파일|버그|에러|오류)\s*(을|를)?\s*(고쳐|수정|만들어|추가)/.test(t)) return null
  if (/\?$|(방법|어떻게)/.test(t)) return null
  return { platform: 'android', hint: t }
}

export function androidReleasePlaybook(userRequest: string, projectDir: string | null): string {
  return [
    `사용자 요청: "${userRequest}"`,
    '',
    '[JARVIS 안드로이드 출시 플레이북] — 실제 스토어 배포다. 각 단계를 정확히 따르고, 추측으로 진행하지 말 것.',
    '',
    `0. 대상 앱: ${projectDir ? `현재 프로젝트 ${projectDir}` : '현재 열린 프로젝트 없음'}. 앱/프로젝트가 불분명하면 mcp__jarvis__ask_user 로 어떤 앱인지 물어본다. app.json / android/app/build.gradle 에서 패키지명(applicationId)과 versionCode/versionName 을 확인한다.`,
    `1. Play Console 로그인 확인: mcp__jarvis__browser_open 으로 ${PLAY_CONSOLE_URL()} 를 연다. 이미 콘솔 화면이면 로그인은 건너뛴다.`,
    '   로그인 화면(accounts.google.com 등)이면 [구글 로그인 절차]를 따른다.',
    '2. 출시 트랙 확인: mcp__jarvis__ask_user 로 "어느 트랙으로 출시할까요?" 를 묻는다. options = ["내부 테스트", "비공개 테스트", "프로덕션"]. 사용자 답 그대로 진행한다.',
    '3. 빌드(AAB): 프로젝트에서 빌드 방식을 파악한다 (eas.json → `eas build -p android --profile production` / android/gradlew → `./gradlew bundleRelease` / fastlane). 이미 만들어 둔 최신 .aab 가 있으면 ask_user 로 "이 파일을 쓸까요, 새로 빌드할까요?" 를 묻는다. 버전 코드가 이전 출시보다 커야 하므로 필요하면 올릴지 ask_user 로 확인한다.',
    '4. Play Console 에서 해당 앱 → 선택한 트랙 → "새 버전 만들기"(Create new release) 로 이동한다. 화면은 mcp__jarvis__browser_read 로 읽고, 버튼은 보이는 텍스트로 mcp__jarvis__browser_click 한다.',
    '5. AAB 업로드: mcp__jarvis__browser_upload 로 .aab 파일을 업로드하고, 처리 완료(버전 표시)까지 browser_read 로 확인한다.',
    '6. 출시 노트: git log 등으로 초안을 만들고 ask_user 로 "이 출시 노트로 할까요?" 확인(수정 요청 시 반영) 후 입력한다.',
    '7. 검토 → 저장 → "검토를 위해 변경사항 전송"/"출시 시작"/"Send for review"/"Start rollout" 등 최종 버튼은 mcp__jarvis__browser_click 시 JARVIS 가 사용자 승인을 받는다. 승인 거부 시 즉시 멈추고 보고한다.',
    '8. 완료 화면을 browser_read 로 확인하고, 트랙·버전·상태(검토 중 등)를 한국어로 짧게 보고한다.',
    '',
    '[구글 로그인 절차]',
    '- 계정 선택 화면이면 화면의 계정 목록을 읽어 ask_user(options=계정 목록) 로 "어느 계정으로 로그인할까요?" 묻고 그 계정을 클릭.',
    '- 이메일 입력 칸이면 ask_user 로 이메일을 물어 browser_type.',
    '- 비밀번호 칸은 절대 직접 입력하지 말고 mcp__jarvis__browser_fill_secret(kind="secret") 사용 — 값은 사용자가 JARVIS 보안 입력창에 넣는다.',
    '- 2단계 인증 코드 칸은 mcp__jarvis__browser_fill_secret(kind="code", question="휴대폰으로 받은 인증번호를 말씀해 주세요").',
    '- "휴대폰에서 확인" 같은 기기 승인 화면이면 ask_user 로 "휴대폰에서 승인하셨나요?" 를 묻고 기다린다.',
    '',
    '[금지] 사용자 확인 없이 트랙 변경, 단계적 출시 비율 변경, 기존 출시 중단/취소, 앱 삭제, 가격·국가 변경을 하지 않는다.'
  ].join('\n')
}
