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
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])
  useEffect(() => {
    const load = (): void => void navigator.mediaDevices.enumerateDevices().then((d) => setMics(d.filter((x) => x.kind === 'audioinput' && x.deviceId !== 'default')))
    load()
    navigator.mediaDevices.addEventListener('devicechange', load)
    return () => navigator.mediaDevices.removeEventListener('devicechange', load)
  }, [])
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
        <div className="set-title">이름 · 호출</div>
        <label className="set-row">
          <span>이름</span>
          <input data-testid="assistant-name" defaultValue={settings.assistantName} onBlur={(e) => e.target.value.trim() && void up({ assistantName: e.target.value.trim() })} />
        </label>
        <div className="muted small">"헤이 {settings.assistantName}", "{settings.assistantName}" 또는 "헤이 자비스"로 부르면 창이 뜨고 명령을 받습니다. 말로 "이제부터 네 이름은 ○○야"라고 해도 됩니다.</div>
        <label className="set-check">
          <input type="checkbox" checked={settings.alwaysListen} onChange={(e) => void up({ alwaysListen: e.target.checked })} />
          항상 듣기 (앱이 켜지면 바로 호출어 대기, 창을 닫아도 계속)
        </label>
        <label className="set-check">
          <input type="checkbox" checked={settings.keepAwake} onChange={(e) => void up({ keepAwake: e.target.checked })} />
          화면이 꺼져도 듣기 (맥/PC 가 잠들지 않게 유지, 부르면 화면을 깨움)
        </label>
        <div className="muted small">맥북 덮개를 닫으면 내장 마이크는 하드웨어적으로 꺼집니다. 덮개를 닫고 쓸 땐 블루투스 헤드셋·USB 마이크를 연결해 주세요 (연결하면 자동으로 그 마이크를 씁니다).</div>
        <label className="set-check">
          <input type="checkbox" checked={settings.launchAtLogin} onChange={(e) => void up({ launchAtLogin: e.target.checked })} />
          로그인 시 자동 실행 (숨김 상태로 대기)
        </label>
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
        <label className="set-check">
          <input type="checkbox" checked={settings.voice.bargeIn} onChange={(e) => void up({ voice: { bargeIn: e.target.checked } })} />
          말하는 중에도 제가 말하면 멈추고 듣기 (스피커 사용 시 끄면 자기 목소리에 끊기지 않음)
        </label>
        <label className="set-row">
          <span>마이크</span>
          <select data-testid="mic-select" value={settings.voice.inputDeviceId ?? ''} onChange={(e) => void up({ voice: { inputDeviceId: e.target.value || null } })}>
            <option value="">시스템 기본</option>
            {mics.map((m) => (
              <option key={m.deviceId} value={m.deviceId}>
                {m.label || '마이크'}
              </option>
            ))}
          </select>
        </label>
        <div className="muted small">블루투스 헤드셋 마이크는 소리가 작게 들어올 수 있습니다. 잘 안 들리면 맥북 내장 마이크를 골라 보세요. 바꾸면 마이크를 껐다 켜야 적용됩니다.</div>
        <VoicePicker current={settings.voice.ttsVoiceId} />
        <label className="set-row">
          <span>운영체제 목소리</span>
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
          <span>추가 호출어</span>
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

type VoiceItem = { id: string; engine: string; label: string; desc: string; installed: boolean; favorite: boolean }
const ENGINE_TITLE: Record<string, string> = { qwen3: 'Qwen3 — 가장 사람 같음 (내 맥에서, 처음 약 3GB 설치)', supertonic: 'Supertonic — 아주 빠름 (내 컴퓨터에서, 145MB)', system: '기본' }

/** 사람 같은 목소리 고르기: ▶ 미리듣기 · 사용 · ★ 자주 쓰는 목소리 */
function VoicePicker({ current }: { current: string }): ReactNode {
  const [list, setList] = useState<VoiceItem[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState('')
  const reload = (): void => void window.jarvis.tts.voices().then(setList)
  useEffect(reload, [current])
  const play = async (v: VoiceItem): Promise<void> => {
    if (v.engine === 'system') return
    if (!v.installed && v.engine === 'qwen3') {
      setMsg('Qwen3 목소리는 "사용"을 눌러 엔진을 설치한 뒤 들을 수 있어요.')
      return
    }
    setBusy(v.id)
    setMsg(v.installed ? '' : '목소리 모델을 받는 중…')
    try {
      const buf = await window.jarvis.tts.preview(v.id)
      if (buf) {
        const ctx = new AudioContext()
        const src = ctx.createBufferSource()
        src.buffer = await ctx.decodeAudioData(buf)
        src.connect(ctx.destination)
        src.onended = () => void ctx.close()
        src.start()
      }
      setMsg('')
      reload()
    } catch (e) {
      setMsg(`미리듣기 실패: ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }
  const use = async (v: VoiceItem): Promise<void> => {
    setBusy(v.id)
    setMsg(v.installed ? '' : '설치 중… (Qwen3 는 몇 분 걸릴 수 있어요)')
    try {
      setMsg(await window.jarvis.tts.use(v.id))
      reload()
    } finally {
      setBusy(null)
    }
  }
  const fav = async (v: VoiceItem): Promise<void> => {
    await window.jarvis.tts.favorite(v.id, !v.favorite)
    reload()
  }
  const groups = ['qwen3', 'supertonic', 'system'].map((e) => [e, list.filter((v) => v.engine === e)] as const).filter(([, l]) => l.length)
  return (
    <div className="voice-picker" data-testid="voice-picker">
      <div className="set-row">
        <span>말하는 목소리</span>
        <b>{list.find((v) => v.id === current)?.label ?? '기본 목소리'}</b>
      </div>
      {groups.map(([engine, items]) => (
        <div key={engine} className="vp-group">
          <div className="muted small">{ENGINE_TITLE[engine]}</div>
          {items.map((v) => (
            <div key={v.id} className={`vp-row ${v.id === current ? 'vp-on' : ''}`}>
              <button className="vp-fav" title="자주 쓰는 목소리 (말로 바꿀 때 먼저 보여 줌)" onClick={() => void fav(v)}>
                {v.favorite ? '★' : '☆'}
              </button>
              <div className="vp-name">
                {v.label}
                <span className="muted small"> {v.desc}</span>
              </div>
              {v.engine !== 'system' && (
                <button disabled={busy !== null} onClick={() => void play(v)}>
                  {busy === v.id ? '…' : '▶'}
                </button>
              )}
              <button disabled={busy !== null || v.id === current} onClick={() => void use(v)}>
                {v.id === current ? '사용 중' : '사용'}
              </button>
            </div>
          ))}
        </div>
      ))}
      {msg && <div className="muted small">{msg}</div>}
    </div>
  )
}
