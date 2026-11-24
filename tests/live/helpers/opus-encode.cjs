// 숨긴 창(화면에 안 뜸)에서 앱과 같은 방식으로 Opus 압축 → 패킷을 base64 JSON 으로 출력
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const [wav, out] = process.argv.slice(-2)
setTimeout(() => app.exit(3), 30000)
app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false })
  await w.loadFile(join(__dirname, 'blank.html'))
  const b = readFileSync(wav)
  const di = b.indexOf('data') + 8
  const n = (b.length - di) >> 1
  const pcm = new Array(n)
  for (let i = 0; i < n; i++) pcm[i] = b.readInt16LE(di + i * 2) / 32768
  const res = await w.webContents.executeJavaScript(`(async () => {
    const pcm = new Float32Array(${JSON.stringify(pcm)})
    const cfg = { codec: 'opus', sampleRate: 16000, numberOfChannels: 1, bitrate: 16000 }
    const packets = []
    const enc = new AudioEncoder({ output: (c) => { const x = new Uint8Array(c.byteLength); c.copyTo(x); packets.push(btoa(String.fromCharCode(...x))) }, error: () => {} })
    enc.configure(cfg)
    enc.encode(new AudioData({ format: 'f32', sampleRate: 16000, numberOfFrames: pcm.length, numberOfChannels: 1, timestamp: 0, data: pcm }))
    await enc.flush()
    return packets
  })()`)
  writeFileSync(out, JSON.stringify(res))
  app.exit(0)
})
