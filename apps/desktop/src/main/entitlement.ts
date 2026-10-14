import type { EntitlementPayload } from '@tradepilot/shared'
import { verifyEntitlement } from '@tradepilot/shared/entitlement'

/** Local clock may lag the server's by at most this much before we assume it was rolled back. */
export const CLOCK_ROLLBACK_TOLERANCE_MS = 5 * 60_000

export type EntitlementDecision =
  | { allowed: true; payload: EntitlementPayload; detail: string }
  | { allowed: false; payload: EntitlementPayload | null; detail: string }

/**
 * Decides offline whether paid features may run, using only a server-signed token.
 * Editing the local database or the renderer cannot grant access because the
 * signature is checked against the public key compiled into the app.
 */
export function evaluateEntitlement(token: string | null, publicKey: string, expectedDeviceId: string | null, localNow: Date): EntitlementDecision {
  if (!token) return { allowed: false, payload: null, detail: 'No subscription status from the server yet.' }
  if (!publicKey) return { allowed: false, payload: null, detail: 'This build has no entitlement public key configured.' }
  const v = verifyEntitlement(token, publicKey)
  if (!v.ok) return { allowed: false, payload: null, detail: 'Subscription status failed signature verification.' }
  const p = v.payload
  if (expectedDeviceId && p.deviceId !== expectedDeviceId) return { allowed: false, payload: p, detail: 'Subscription status belongs to a different device.' }
  const now = localNow.getTime()
  if (now < Date.parse(p.serverTime) - CLOCK_ROLLBACK_TOLERANCE_MS) {
    return { allowed: false, payload: p, detail: 'Your system clock is earlier than the last server check. Correct the clock and reconnect.' }
  }
  if (now >= Date.parse(p.exp)) return { allowed: false, payload: p, detail: 'Subscription status is out of date. Connect to the internet to refresh it.' }
  if (!p.allowed) {
    return { allowed: false, payload: p, detail: p.reason === 'subscription_expired' ? 'Your subscription has expired.' : 'Your free trial has ended.' }
  }
  if (p.until && now >= Date.parse(p.until)) return { allowed: false, payload: p, detail: 'Your access period has ended.' }
  return { allowed: true, payload: p, detail: p.reason === 'trial' ? 'Free trial active.' : 'Subscription active.' }
}
