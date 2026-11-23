// MediaPipe WASM + 손 추적 모델을 renderer/public 으로 준비한다 (오프라인 동작 위해 번들).
import { cpSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'src/renderer/public/mediapipe')
mkdirSync(out, { recursive: true })

const wasmSrc = join(root, 'node_modules/@mediapipe/tasks-vision/wasm')
cpSync(wasmSrc, join(out, 'wasm'), { recursive: true })

const modelPath = join(out, 'hand_landmarker.task')
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'

if (!existsSync(modelPath) || statSync(modelPath).size < 1_000_000) {
  console.log('[assets] downloading hand_landmarker.task ...')
  const res = await fetch(MODEL_URL)
  if (!res.ok) throw new Error(`model download failed: ${res.status}`)
  writeFileSync(modelPath, Buffer.from(await res.arrayBuffer()))
}
console.log('[assets] mediapipe ready:', out)

// ONNX Runtime (Whisper 음성 인식용) — CDN 대신 로컬에서 로드
const ortOut = join(root, 'src/renderer/public/ort')
mkdirSync(ortOut, { recursive: true })
const ortSrc = join(root, 'node_modules/onnxruntime-web/dist')
for (const f of ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']) {
  if (existsSync(join(ortSrc, f))) cpSync(join(ortSrc, f), join(ortOut, f))
}
console.log('[assets] onnxruntime ready:', ortOut)
