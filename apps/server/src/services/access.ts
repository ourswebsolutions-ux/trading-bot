import type { AccessReason, EntitlementPayload, PlanCode, StatusResponse, SubscriptionDto, TrialDto } from '@tradepilot/shared'
import { signEntitlement } from '@tradepilot/shared/entitlement'
import type { AppContext } from '../context.js'
import type { Db } from '../db/sqlite.js'
import type { DeviceRow } from './devices.js'

interface SubscriptionRow {
  id: string
  plan_code: PlanCode
  starts_at: string
  expires_at: string | null
  created_at: string
}

export function getTrial(db: Db, deviceId: string, now: Date): TrialDto {
  const row = db.prepare('SELECT started_at, ends_at FROM trials WHERE device_id = ?').get(deviceId) as
    | { started_at: string; ends_at: string }
    | undefined
  if (!row) throw new Error(`Device ${deviceId} has no trial record`)
  const remainingMs = Math.max(0, Date.parse(row.ends_at) - now.getTime())
  return { startedAt: row.started_at, endsAt: row.ends_at, active: remainingMs > 0, remainingMs }
}

function activeSubscriptionRows(db: Db, deviceId: string): SubscriptionRow[] {
  return db.prepare(
    `SELECT id, plan_code, starts_at, expires_at, created_at FROM subscriptions
     WHERE device_id = ? AND revoked_at IS NULL ORDER BY starts_at ASC`
  ).all(deviceId) as unknown as SubscriptionRow[]
}

/**
 * The subscription as the user sees it. Monthly renewals are stacked back-to-back, so
 * the visible expiry is the end of the contiguous chain that covers "now".
 * Returns the most recent lapsed subscription (status "expired") when nothing is active.
 */
export function getSubscription(db: Db, deviceId: string, now: Date): SubscriptionDto | null {
  const rows = activeSubscriptionRows(db, deviceId)
  if (rows.length === 0) return null
  const nowIso = now.toISOString()

  const lifetime = rows.find((r) => r.plan_code === 'lifetime' && r.starts_at <= nowIso)
  if (lifetime) return { planCode: 'lifetime', status: 'active', activatedAt: lifetime.starts_at, expiresAt: null }

  const covering = rows.find((r) => r.starts_at <= nowIso && r.expires_at !== null && r.expires_at > nowIso)
  if (covering) {
    let end = covering.expires_at!
    for (const r of rows) if (r.starts_at <= end && r.expires_at && r.expires_at > end) end = r.expires_at
    return { planCode: covering.plan_code, status: 'active', activatedAt: covering.starts_at, expiresAt: end }
  }

  const lapsed = rows.filter((r) => r.expires_at !== null && r.expires_at <= nowIso).at(-1)
  return lapsed ? { planCode: lapsed.plan_code, status: 'expired', activatedAt: lapsed.starts_at, expiresAt: lapsed.expires_at } : null
}

/** End of the current paid period (used to stack monthly renewals). */
export function currentPaidUntil(db: Db, deviceId: string, now: Date): { lifetime: boolean; until: Date | null } {
  const sub = getSubscription(db, deviceId, now)
  if (!sub || sub.status !== 'active') return { lifetime: false, until: null }
  if (sub.planCode === 'lifetime') return { lifetime: true, until: null }
  return { lifetime: false, until: new Date(sub.expiresAt!) }
}

export interface AccessDecision {
  allowed: boolean
  reason: AccessReason
  until: string | null
  planCode: PlanCode | null
}

export function decideAccess(trial: TrialDto, subscription: SubscriptionDto | null): AccessDecision {
  if (subscription?.status === 'active') {
    return { allowed: true, reason: 'subscription', until: subscription.expiresAt, planCode: subscription.planCode }
  }
  if (trial.active) return { allowed: true, reason: 'trial', until: trial.endsAt, planCode: null }
  if (subscription?.status === 'expired') return { allowed: false, reason: 'subscription_expired', until: null, planCode: subscription.planCode }
  return { allowed: false, reason: 'trial_expired', until: null, planCode: null }
}

export function computeAccess(ctx: AppContext, deviceId: string) {
  const now = ctx.clock.now()
  const trial = getTrial(ctx.db, deviceId, now)
  const subscription = getSubscription(ctx.db, deviceId, now)
  return { now, trial, subscription, access: decideAccess(trial, subscription) }
}

export function issueEntitlementToken(ctx: AppContext, deviceId: string, access: AccessDecision, now: Date): string {
  // Offline validity never extends past the moment access actually ends.
  let exp = now.getTime() + ctx.config.entitlementTtlMs
  if (access.until) exp = Math.min(exp, Date.parse(access.until))
  const payload: EntitlementPayload = {
    v: 1,
    deviceId,
    allowed: access.allowed,
    reason: access.reason,
    planCode: access.planCode,
    until: access.until,
    serverTime: now.toISOString(),
    exp: new Date(Math.max(exp, now.getTime())).toISOString()
  }
  return signEntitlement(payload, ctx.keys.privateKey)
}

export function buildStatus(ctx: AppContext, device: DeviceRow): StatusResponse {
  const { now, trial, subscription, access } = computeAccess(ctx, device.id)
  const pending = ctx.db.prepare(`SELECT id FROM payment_requests WHERE device_id = ? AND status = 'pending'`).get(device.id) as
    | { id: string }
    | undefined
  return {
    serverTime: now.toISOString(),
    deviceId: device.id,
    referenceCode: device.reference_code,
    trial,
    subscription,
    access: { allowed: access.allowed, reason: access.reason, until: access.until },
    entitlementToken: issueEntitlementToken(ctx, device.id, access, now),
    pendingRequestId: pending?.id ?? null
  }
}
