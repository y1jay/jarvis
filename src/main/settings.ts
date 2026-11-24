import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { JarvisSettings, ProviderId } from '../shared/types'

export const DEFAULT_SETTINGS: JarvisSettings = {
  provider: 'claude',
  projectDir: null,
  recentProjects: [],
  // 빈 문자열 = 각 CLI 의 기본 모델
  models: { claude: '', gpt: '', gemini: '' },
  claudePermissionMode: 'auto',
  geminiUseGoogleLogin: true,
  voice: {
    wakeWordEnabled: true,
    // 추가 호출어 (기본 "자비스"와 assistantName 은 자동 포함)
    wakeWords: [],
    ttsEnabled: true,
    ttsVoice: null,
    ttsRate: 1.05,
    ttsPitch: 0.95,
    sttModel: 'onnx-community/whisper-small',
    language: 'korean',
    inputDeviceId: null,
    // 맥(GPU)은 가장 정확한 large-v3, 윈도우(CPU)는 가벼운 small
    nativeModel: process.platform === 'darwin' ? 'large-v3' : 'small',
    bargeIn: true,
    learning: true,
    learnLimitMB: 500,
    learnRepo: null,
    contextCorrection: true,
    ttsVoiceId: 'system',
    ttsFavorites: ['qwen3:sohee', 'qwen3:assistant', 'supertonic:3', 'supertonic:6', 'supertonic:9']
  },
  camera: { enabled: false, deviceId: null },
  alwaysOnTop: false,
  assistantName: '자비스',
  alwaysListen: true,
  keepAwake: true,
  launchAtLogin: true,
  fastLane: true,
  fastModel: 'sonnet',
  actionModel: 'sonnet',
  learning: { enabled: true }
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] }

function merge<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (!patch) return base
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(patch)) {
    const b = (base as Record<string, unknown>)[k]
    if (v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object' && !Array.isArray(b)) {
      out[k] = merge(b, v as DeepPartial<typeof b>)
    } else if (v !== undefined) {
      out[k] = v
    }
  }
  return out as T
}

export class SettingsStore {
  private data: JarvisSettings
  constructor(private readonly file: string) {
    mkdirSync(dirname(file), { recursive: true })
    let loaded: DeepPartial<JarvisSettings> | undefined
    if (existsSync(file)) {
      try {
        loaded = JSON.parse(readFileSync(file, 'utf8'))
      } catch {
        loaded = undefined
      }
    }
    this.data = merge(DEFAULT_SETTINGS, loaded)
  }

  get(): JarvisSettings {
    return structuredClone(this.data)
  }

  update(patch: DeepPartial<JarvisSettings>): JarvisSettings {
    this.data = merge(this.data, patch)
    writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8')
    return this.get()
  }

  model(p: ProviderId): string | undefined {
    return this.data.models[p] || undefined
  }
}

export type { DeepPartial }
