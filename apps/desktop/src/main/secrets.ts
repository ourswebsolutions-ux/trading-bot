import type { Db } from './db.js'
import { UserError } from './errors.js'

/** Encryption backend; in the app this is Electron safeStorage (OS keychain / DPAPI / libsecret). */
export interface SecretCipher {
  available(): { ok: boolean; backend: string; reason: string | null }
  encrypt(plain: string): Buffer
  decrypt(cipher: Buffer): string
}

export function maskHint(value: string): string {
  const tail = value.length >= 12 ? value.slice(-4) : ''
  return `••••${tail}`
}

/** Encrypted secret storage. Plaintext values exist only in the main process, never in renderer or logs. */
export class SecretStore {
  constructor(
    private readonly db: Db,
    private readonly cipher: SecretCipher
  ) {}

  info() {
    return this.cipher.available()
  }

  set(name: string, value: string): void {
    const avail = this.cipher.available()
    if (!avail.ok) throw new UserError('secret_storage_unavailable', avail.reason ?? 'Secure credential storage is unavailable on this system.')
    if (value.length > 8192) throw new UserError('validation_failed', 'Value is too long.')
    this.db.prepare(
      `INSERT INTO secrets (name, ciphertext, hint, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET ciphertext = excluded.ciphertext, hint = excluded.hint, updated_at = excluded.updated_at`
    ).run(name, this.cipher.encrypt(value), maskHint(value), new Date().toISOString())
  }

  get(name: string): string | null {
    const row = this.db.prepare('SELECT ciphertext FROM secrets WHERE name = ?').get(name) as { ciphertext: Uint8Array } | undefined
    if (!row) return null
    try {
      return this.cipher.decrypt(Buffer.from(row.ciphertext))
    } catch {
      throw new UserError('secret_unreadable', `Stored credential "${name}" cannot be decrypted on this system. Re-enter it in Settings.`)
    }
  }

  hint(name: string): string | null {
    const row = this.db.prepare('SELECT hint FROM secrets WHERE name = ?').get(name) as { hint: string } | undefined
    return row?.hint ?? null
  }

  delete(name: string): void {
    this.db.prepare('DELETE FROM secrets WHERE name = ?').run(name)
  }
}
