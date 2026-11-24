// macOS 서명 (electron-builder mac.sign 훅)
// 기본 서명은 인증서 '이름'으로 codesign 을 불러서, 키체인에 같은 이름의 인증서가 둘 이상이면 실패한다 ("ambiguous").
// 여기서는 인증서 '지문(SHA-1)'으로 서명해 항상 하나로 특정한다.
// 늘 같은 인증서로 서명해야 다시 빌드해도 macOS 마이크·화면 권한이 유지되므로,
// 저장소 밖에 두는 `.signing-identity` 파일(지문 한 줄, git 에 안 올라감)이 있으면 그 인증서로 고정한다.
const { existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')

module.exports = async function sign(opts) {
  const { signAsync } = await import('@electron/osx-sign')
  const pinFile = join(__dirname, '..', '.signing-identity')
  const pinned = existsSync(pinFile) ? readFileSync(pinFile, 'utf8').trim() : ''
  const identity = /^[0-9A-F]{40}$/i.test(pinned) ? pinned.toUpperCase() : opts.identity
  console.log(`  • 서명 인증서 지문: ${identity}${pinned ? ' (.signing-identity 고정)' : ''}`)
  await signAsync({ ...opts, identity, identityValidation: false })
}
