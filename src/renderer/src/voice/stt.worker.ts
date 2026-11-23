/// <reference lib="webworker" />
// 로컬 Whisper 음성 인식 (transformers.js). 첫 실행 시 모델을 내려받아 브라우저 캐시에 저장 → 이후 오프라인.
import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers'

type InMsg = { type: 'load'; model: string; ortBase: string } | { type: 'transcribe'; id: number; audio: Float32Array; language: string }

let asr: AutomaticSpeechRecognitionPipeline | null = null
let loading: Promise<void> | null = null

async function load(model: string, ortBase: string): Promise<void> {
  env.allowLocalModels = false
  if (env.backends.onnx.wasm) env.backends.onnx.wasm.wasmPaths = ortBase
  const hasGpu = 'gpu' in navigator && !!(await (navigator as unknown as { gpu: { requestAdapter(): Promise<unknown> } }).gpu.requestAdapter().catch(() => null))
  const progress = (p: { status: string; file?: string; progress?: number }): void => {
    postMessage({ type: 'progress', status: p.status, file: p.file, progress: p.progress })
  }
  try {
    asr = (await pipeline('automatic-speech-recognition', model, {
      device: hasGpu ? 'webgpu' : 'wasm',
      dtype: hasGpu ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8',
      progress_callback: progress
    })) as AutomaticSpeechRecognitionPipeline
  } catch (e) {
    if (!hasGpu) throw e
    asr = (await pipeline('automatic-speech-recognition', model, { device: 'wasm', dtype: 'q8', progress_callback: progress })) as AutomaticSpeechRecognitionPipeline
  }
  postMessage({ type: 'ready', device: hasGpu ? 'webgpu' : 'wasm' })
}

self.onmessage = async (ev: MessageEvent<InMsg>) => {
  const m = ev.data
  try {
    if (m.type === 'load') {
      loading ??= load(m.model, m.ortBase)
      await loading
      return
    }
    if (m.type === 'transcribe') {
      if (!asr) await loading
      if (!asr) throw new Error('음성 인식 모델이 로드되지 않았습니다')
      const out = await asr(m.audio, { language: m.language, task: 'transcribe', chunk_length_s: 30 })
      const text = Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text
      postMessage({ type: 'result', id: m.id, text: text.trim() })
    }
  } catch (e) {
    loading = null
    postMessage({ type: 'error', id: 'id' in m ? m.id : undefined, message: (e as Error).message })
  }
}
