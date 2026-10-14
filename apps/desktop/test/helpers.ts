import { openDatabase } from '../src/main/db.js'
import { SecretStore, type SecretCipher } from '../src/main/secrets.js'

/** Reversible stand-in for safeStorage so tests can assert that plaintext never hits the DB. */
export const fakeCipher: SecretCipher = {
  available: () => ({ ok: true, backend: 'test', reason: null }),
  encrypt: (s) => Buffer.from(`enc:${Buffer.from(s).reverse().toString('base64')}`),
  decrypt: (b) => Buffer.from(b.toString().slice(4), 'base64').reverse().toString()
}

export function memoryDb() {
  return openDatabase(':memory:')
}

export function secretStore(db = memoryDb()) {
  return { db, store: new SecretStore(db, fakeCipher) }
}
