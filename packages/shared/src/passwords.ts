import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto'

/**
 * scrypt password hashing (N=2^15, r=8, p=1 → ~32 MiB per hash), stored as
 * "scrypt$N$r$p$salt$hash" so parameters can be raised later without breaking old hashes.
 */
const N = 1 << 15
const R = 8
const P = 1
const KEYLEN = 32

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password.normalize('NFKC'), salt, keylen, { ...opts, maxmem: 128 * opts.N! * opts.r! * 2 }, (err, key) =>
      err ? reject(err) : resolve(key)
    )
  )
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scrypt(password, salt, KEYLEN, { N, r: R, p: P })
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, n, r, p, saltB64, keyB64] = parts as [string, string, string, string, string, string]
  const expected = Buffer.from(keyB64, 'base64')
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p)
  })
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/** A hash of a random password, used to equalize timing when the account does not exist. */
let dummyHash: Promise<string> | null = null
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'))
  return dummyHash
}
