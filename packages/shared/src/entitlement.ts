import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto'
import type { EntitlementPayload } from './api.js'

/**
 * Entitlement tokens: base64url(JSON payload) + "." + base64url(Ed25519 signature).
 * Node-only module (imports node:crypto); never import it from renderer code.
 */

export function signEntitlement(payload: EntitlementPayload, privateKeyPem: string | KeyObject): string {
  const key = typeof privateKeyPem === 'string' ? createPrivateKey(privateKeyPem) : privateKeyPem
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const signature = sign(null, Buffer.from(body, 'utf8'), key).toString('base64url')
  return `${body}.${signature}`
}

export type EntitlementVerification =
  | { ok: true; payload: EntitlementPayload }
  | { ok: false; error: 'malformed' | 'bad_signature' }

export function verifyEntitlement(token: string, publicKey: string | KeyObject): EntitlementVerification {
  const parts = token.split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, error: 'malformed' }
  const [body, signature] = parts as [string, string]
  let key: KeyObject
  try {
    key = typeof publicKey === 'string' ? parsePublicKey(publicKey) : publicKey
  } catch {
    return { ok: false, error: 'bad_signature' }
  }
  const valid = verify(null, Buffer.from(body, 'utf8'), key, Buffer.from(signature, 'base64url'))
  if (!valid) return { ok: false, error: 'bad_signature' }
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as EntitlementPayload
    if (payload.v !== 1 || typeof payload.deviceId !== 'string') return { ok: false, error: 'malformed' }
    return { ok: true, payload }
  } catch {
    return { ok: false, error: 'malformed' }
  }
}

/** Accepts a PEM string or the base64 body of an SPKI DER key (handy for single-line env vars). */
export function parsePublicKey(value: string): KeyObject {
  const trimmed = value.trim()
  if (trimmed.startsWith('-----BEGIN')) return createPublicKey(trimmed)
  return createPublicKey({ key: Buffer.from(trimmed, 'base64'), format: 'der', type: 'spki' })
}
