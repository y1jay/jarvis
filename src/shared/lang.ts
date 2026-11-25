// 답변 언어 검사 — JARVIS 는 무조건 한국어로 말한다. AI 가 영어로 답하면 말하기 전에 한국어로 옮긴다.

/** 코드·경로·주소·영문 고유명사 덩어리를 빼고 '말'만 남긴다 */
function prose(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/(?:[\w.-]*[\\/])+[\w.-]+/g, ' ')
    .replace(/\b[\w-]+\.(ts|tsx|js|json|md|py|sql|yml|yaml|sh|png)\b/gi, ' ')
}

/** 한국어가 아닌 답인지 (영어 문장이 대부분). 짧은 영어 단어·코드가 섞인 한국어 답은 한국어로 본다 */
export function isMostlyForeign(text: string): boolean {
  const p = prose(text)
  const latin = (p.match(/[A-Za-z]/g) ?? []).length
  const hangul = (p.match(/[가-힣]/g) ?? []).length
  return latin >= 20 && hangul < latin * 0.25
}

/** 한국어로 옮겨 달라는 지시문 */
export function translatePrompt(text: string): string {
  return [
    '아래 글을 자연스러운 한국어 존댓말("~입니다", "~했습니다")로 옮겨라.',
    '코드, 파일 경로, 명령어, 커밋 해시, 함수·변수 이름은 원문 그대로 둔다. 마크다운 형식은 유지한다.',
    '설명이나 머리말 없이 옮긴 글만 출력한다.',
    '',
    text
  ].join('\n')
}

/** 매 메시지 끝에 붙이는 짧은 언어 규칙 (긴 작업 뒤에 영어로 답한 일이 있었다) */
export const KOREAN_REMINDER = '<jarvis-rule>답변·보고·질문은 반드시 한국어로 한다. 영어로 쓰지 않는다 (코드·경로·명령만 원문).</jarvis-rule>'
