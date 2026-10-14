import { createHash, randomBytes, randomUUID } from 'node:crypto'

export const newId = (): string => randomUUID()
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url')
export const sha256Hex = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

/** Human-friendly reference users put in their payment memo, e.g. TP-7KQ4-M9XD (no 0/O/1/I). */
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
export function newReferenceCode(): string {
  const bytes = randomBytes(8)
  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('')
  return `TP-${chars.slice(0, 4)}-${chars.slice(4, 8)}`
}
