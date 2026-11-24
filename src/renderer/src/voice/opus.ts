// 학습용 말소리 압축 (브라우저 내장 WebCodecs Opus) — 16kHz mono, 16kbps → 2초에 약 4KB
export async function encodeOpus(pcm: Float32Array, sampleRate = 16000): Promise<Uint8Array[] | null> {
  if (typeof AudioEncoder === 'undefined') return null
  const cfg = { codec: 'opus', sampleRate, numberOfChannels: 1, bitrate: 16000 }
  try {
    if (!(await AudioEncoder.isConfigSupported(cfg)).supported) return null
  } catch {
    return null
  }
  const packets: Uint8Array[] = []
  let failed = false
  const enc = new AudioEncoder({
    output: (chunk) => {
      const b = new Uint8Array(chunk.byteLength)
      chunk.copyTo(b)
      packets.push(b)
    },
    error: () => {
      failed = true
    }
  })
  enc.configure(cfg)
  enc.encode(new AudioData({ format: 'f32', sampleRate, numberOfFrames: pcm.length, numberOfChannels: 1, timestamp: 0, data: new Float32Array(pcm) }))
  await enc.flush()
  enc.close()
  return failed || !packets.length ? null : packets
}
