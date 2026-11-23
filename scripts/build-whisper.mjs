// 음성 인식 엔진(whisper.cpp) 네이티브 빌드 → resources/bin/<platform>-<arch>/whisper-server[.exe]
// 맥은 Metal(GPU), 윈도우는 CPU(AVX2). 외부 라이브러리 없이 단독 실행되도록 정적 링크한다.
// 사용: node scripts/build-whisper.mjs   (cmake, git 필요)
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TAG = 'v1.9.5'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, '.cache', `whisper.cpp-${TAG}`)
const build = join(src, 'build')
const outDir = join(root, 'resources', 'bin', `${process.platform}-${process.arch}`)
const exe = process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server'
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit' })

if (existsSync(join(outDir, exe)) && !process.argv.includes('--force')) {
  console.log('[whisper] 이미 빌드됨:', join(outDir, exe))
  process.exit(0)
}
if (!existsSync(src)) {
  mkdirSync(dirname(src), { recursive: true })
  run('git', ['clone', '--depth', '1', '--branch', TAG, 'https://github.com/ggml-org/whisper.cpp.git', src])
}
// GGML_NATIVE=OFF: 빌드한 컴퓨터의 CPU 전용 명령어를 쓰지 않아 다른 PC(구형 맥/다른 윈도우 CPU)에서도 실행된다
const flags = ['-B', build, '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF', '-DWHISPER_BUILD_TESTS=OFF', '-DWHISPER_BUILD_EXAMPLES=ON', '-DWHISPER_SDL2=OFF', '-DGGML_NATIVE=OFF']
if (process.platform === 'darwin') flags.push('-DGGML_METAL=ON', '-DGGML_METAL_EMBED_LIBRARY=ON', '-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0')
// 윈도우: VC++ 런타임 DLL 없이도 실행되도록 정적 런타임, AVX2 (대부분의 최근 CPU)
if (process.platform === 'win32') flags.push('-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded', '-DGGML_AVX2=ON')
run('cmake', flags, src)
run('cmake', ['--build', build, '--config', 'Release', '-j', '--target', 'whisper-server'], src)

// 빌드 산출물 위치는 생성기마다 다르다 (bin/ 또는 bin/Release/)
const find = (d) => {
  for (const e of readdirSync(d)) {
    const p = join(d, e)
    if (statSync(p).isDirectory()) {
      const r = find(p)
      if (r) return r
    } else if (e === exe) return p
  }
  return null
}
const built = find(join(build, 'bin')) ?? find(build)
if (!built) throw new Error('whisper-server 빌드 결과를 찾지 못했습니다')
mkdirSync(outDir, { recursive: true })
copyFileSync(built, join(outDir, exe))
console.log('[whisper] 완료:', join(outDir, exe))
