// API 키 보관. OS 키체인 기반 암호화(safeStorage) 가능하면 암호화, 아니면 저장 거부.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ProviderId } from '../shared/types'

export interface Cipher {
  isEncryptionAvailable(): boolean
  encryptString(s: string): Buffer
  decryptString(b: Buffer): string
}

export class SecretStore {
  private data: Partial<Record<ProviderId, string>> = {}
  constructor(
    private readonly file: string,
    private readonly cipher: Cipher
  ) {
    mkdirSync(dirname(file), { recursive: true })
    if (existsSync(file)) {
      try {
        this.data = JSON.parse(readFileSync(file, 'utf8'))
      } catch {
        this.data = {}
      }
    }
  }

  has(p: ProviderId): boolean {
    return !!this.data[p]
  }

  get(p: ProviderId): string | undefined {
    const v = this.data[p]
    if (!v) return undefined
    try {
      return this.cipher.decryptString(Buffer.from(v, 'base64'))
    } catch {
      return undefined
    }
  }

  set(p: ProviderId, key: string): void {
    if (!this.cipher.isEncryptionAvailable()) throw new Error('OS 암호화 저장소를 사용할 수 없어 API 키를 저장하지 않습니다.')
    this.data[p] = this.cipher.encryptString(key).toString('base64')
    this.save()
  }

  clear(p: ProviderId): void {
    delete this.data[p]
    this.save()
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify(this.data), { encoding: 'utf8', mode: 0o600 })
  }
}

export function maskKey(k: string): string {
  return k.length <= 8 ? '****' : `${k.slice(0, 4)}…${k.slice(-4)}`
}
