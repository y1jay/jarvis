import { defineConfig } from 'vitest/config'

// 실제 Claude / Codex / Gemini 를 호출하는 스모크 테스트 (토큰 소모)
export default defineConfig({
  test: { include: ['tests/live/**/*.test.ts'], environment: 'node', testTimeout: 600000, hookTimeout: 600000, fileParallelism: false }
})
