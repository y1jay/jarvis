// ELECTRON_RUN_AS_NODE 를 지운 채 Electron 으로 스크립트 실행 (VS Code 터미널 대응)
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const r = spawnSync(require('electron'), process.argv.slice(2), { stdio: 'inherit', env })
process.exit(r.status ?? 0)
