// 목소리 엔진 목록·기본값·설치 도구 찾기
import { describe, expect, it } from 'vitest'
import { DEFAULT_FAVORITES, enginesFor, findPythonTool, voiceById, VOICE_CATALOG } from '../../src/main/tts'

describe('목소리 목록', () => {
  it('미리듣기에서 고른 다섯 목소리가 기본 즐겨찾기', () => {
    expect(DEFAULT_FAVORITES.map((id) => voiceById(id)?.label)).toEqual(['소희', '비서', 'Supertonic 목소리 4', 'Supertonic 목소리 7', 'Supertonic 목소리 10'])
  })
  it('아이디는 겹치지 않는다', () => {
    expect(new Set(VOICE_CATALOG.map((v) => v.id)).size).toBe(VOICE_CATALOG.length)
  })
  it('Qwen3 는 애플 실리콘 맥에서만', () => {
    expect(enginesFor('darwin', 'arm64')).toEqual(['system', 'supertonic', 'qwen3'])
    expect(enginesFor('win32', 'x64')).toEqual(['system', 'supertonic'])
    expect(enginesFor('darwin', 'x64')).toEqual(['system', 'supertonic'])
  })
  it('설치 도구: uv 우선, 없으면 파이썬 3.10+', () => {
    expect(findPythonTool((p) => p.endsWith('/.local/bin/uv'))?.kind).toBe('uv')
    expect(findPythonTool((p) => p === '/opt/homebrew/bin/python3.12')).toEqual({ kind: 'python', path: '/opt/homebrew/bin/python3.12' })
    expect(findPythonTool(() => false)).toBeNull()
  })
})
