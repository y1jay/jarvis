import { useEffect, useState, type ReactNode } from 'react'
import type { JarvisSettings, PermissionModeSetting, ProviderId } from '../../../shared/types'
import { PROVIDER_LABEL } from '../../../shared/types'

const MODES: Array<[PermissionModeSetting, string]> = [
  ['auto', '알아서 진행 (권장) — 안전한 작업은 자동, 위험하면 확인'],
  ['acceptEdits', '파일 수정만 자동, 명령은 매번 확인'],
  ['default', '모든 변경 확인'],
  ['plan', '계획만 (읽기 전용)']
]

const STT_MODELS: Array<[string, string]> = [
  ['onnx-community/whisper-small', 'Whisper Small (한국어 권장, ~250MB)'],
  ['onnx-community/whisper-base', 'Whisper Base (빠름, 한국어 정확도 낮음)'],
  ['onnx-community/whisper-tiny', 'Whisper Tiny (가장 빠름)']
]

export function SettingsPanel({ settings, onSettings }: { settings: JarvisSettings; onSettings: (s: JarvisSettings) => void }): ReactNode {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  useEffect(() => {
    const load = (): void => setVoices(speechSynthesis.getVoices())
    load()
    speechSynthesis.addEventListener('voiceschanged', load)
    return () => speechSynthesis.removeEventListener('voiceschanged', load)
  }, [])
  const up = async (patch: unknown): Promise<void> => onSettings(await window.jarvis.settings.update(patch))
  const ko = voices.filter((v) => v.lang.startsWith('ko'))
  const list = ko.length ? ko : voices

  return (
    <div className="settings panel-pad">
      <div className="set-group">
        <div className="set-title">모델 (비우면 각 CLI 기본값)</div>
        {(Object.keys(PROVIDER_LABEL) as ProviderId[]).map((p) => (
          <label key={p} className="set-row">
            <span>{PROVIDER_LABEL[p]}</span>
            <input
              defaultValue={settings.models[p]}
              placeholder={p === 'claude' ? '예: opus, sonnet, claude-opus-5-5' : p === 'gpt' ? '예: gpt-5.5-codex' : '예: gemini-3-pro'}
              onBlur={(e) => void up({ models: { [p]: e.target.value.trim() } })}
            />
          </label>
        ))}
      </div>

      <div className="set-group">
        <div className="set-title">Claude 권한 모드</div>
        <select value={settings.claudePermissionMode} onChange={(e) => void up({ claudePermissionMode: e.target.value })}>
          {MODES.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <div className="muted small">git commit / push / 파괴적 명령은 모드와 관계없이 항상 확인 창이 뜹니다.</div>
      </div>

      <div className="set-group">
        <div className="set-title">음성</div>
        <label className="set-check">
          <input type="checkbox" checked={settings.voice.wakeWordEnabled} onChange={(e) => void up({ voice: { wakeWordEnabled: e.target.checked } })} />
          "자비스" 호출어 대기
        </label>
        <label className="set-check">
          <input type="checkbox" checked={settings.voice.ttsEnabled} onChange={(e) => void up({ voice: { ttsEnabled: e.target.checked } })} />
          음성으로 답변
        </label>
        <label className="set-row">
          <span>목소리</span>
          <select value={settings.voice.ttsVoice ?? ''} onChange={(e) => void up({ voice: { ttsVoice: e.target.value || null } })}>
            <option value="">자동 (한국어)</option>
            {list.map((v) => (
              <option key={v.name} value={v.name}>
                {v.name} ({v.lang})
              </option>
            ))}
          </select>
        </label>
        <label className="set-row">
          <span>말 속도 {settings.voice.ttsRate.toFixed(2)}</span>
          <input type="range" min={0.7} max={1.6} step={0.05} value={settings.voice.ttsRate} onChange={(e) => void up({ voice: { ttsRate: Number(e.target.value) } })} />
        </label>
        <label className="set-row">
          <span>인식 모델</span>
          <select value={settings.voice.sttModel} onChange={(e) => void up({ voice: { sttModel: e.target.value } })}>
            {STT_MODELS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="set-row">
          <span>호출어</span>
          <input defaultValue={settings.voice.wakeWords.join(', ')} onBlur={(e) => void up({ voice: { wakeWords: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) } })} />
        </label>
        <div className="muted small">인식 모델 변경은 앱 재시작 후 적용됩니다. 음성 인식은 이 컴퓨터에서 로컬로 실행됩니다.</div>
      </div>

      <div className="set-group">
        <div className="set-title">창</div>
        <label className="set-check">
          <input type="checkbox" checked={settings.alwaysOnTop} onChange={(e) => void up({ alwaysOnTop: e.target.checked })} />
          항상 위에 표시
        </label>
        <div className="muted small">전역 단축키: ⌘/Ctrl + Shift + J — 자비스 호출</div>
      </div>
    </div>
  )
}
