import { TRIAL_DURATION_MS, type RegisterDeviceResponse } from '@tradepilot/shared'
import type { AppContext } from '../context.js'
import { isUniqueViolation, transaction } from '../db/sqlite.js'
import { newId, newReferenceCode, randomToken, sha256Hex } from '../security/tokens.js'
import { recordAudit } from './audit.js'

export interface DeviceRow {
  id: string
  fingerprint_hash: string
  reference_code: string
  platform: string
  app_version: string
  created_at: string
  last_seen_at: string
  disabled: number
}

/**
 * Registers a device or re-issues its credentials. The trial is keyed to the hashed
 * hardware fingerprint and created exactly once, so reinstalling the app or deleting
 * local data returns the SAME trial window instead of starting a new one.
 */
export function registerDevice(
  ctx: AppContext,
  input: { fingerprint: string; platform: string; appVersion: string },
  ip: string | null
): RegisterDeviceResponse {
  const now = ctx.clock.now()
  const iso = now.toISOString()
  const fingerprintHash = sha256Hex(`tradepilot-device:${input.fingerprint}`)
  const deviceToken = randomToken(32)
  const tokenHash = sha256Hex(deviceToken)

  return transaction(ctx.db, () => {
    const existing = ctx.db.prepare('SELECT * FROM devices WHERE fingerprint_hash = ?').get(fingerprintHash) as DeviceRow | undefined
    if (existing) {
      ctx.db.prepare('UPDATE devices SET token_hash = ?, token_rotated_at = ?, last_seen_at = ?, platform = ?, app_version = ? WHERE id = ?')
        .run(tokenHash, iso, iso, input.platform, input.appVersion, existing.id)
      recordAudit(ctx.db, now, { actorType: 'device', actorId: existing.id, action: 'device.credentials_reissued', entityType: 'device', entityId: existing.id, ip })
      return { deviceId: existing.id, deviceToken, referenceCode: existing.reference_code }
    }

    const id = newId()
    // Reference codes are random; retry on the (very unlikely) collision.
    for (let attempt = 0; ; attempt++) {
      const referenceCode = newReferenceCode()
      try {
        ctx.db.prepare(
          `INSERT INTO devices (id, fingerprint_hash, token_hash, reference_code, platform, app_version, created_at, last_seen_at, token_rotated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(id, fingerprintHash, tokenHash, referenceCode, input.platform, input.appVersion, iso, iso, iso)
        const endsAt = new Date(now.getTime() + TRIAL_DURATION_MS).toISOString()
        ctx.db.prepare('INSERT INTO trials (device_id, started_at, ends_at) VALUES (?, ?, ?)').run(id, iso, endsAt)
        recordAudit(ctx.db, now, { actorType: 'device', actorId: id, action: 'device.registered', entityType: 'device', entityId: id, details: { platform: input.platform, appVersion: input.appVersion }, ip })
        recordAudit(ctx.db, now, { actorType: 'system', action: 'trial.started', entityType: 'device', entityId: id, details: { startedAt: iso, endsAt } })
        return { deviceId: id, deviceToken, referenceCode }
      } catch (err) {
        if (attempt < 5 && isUniqueViolation(err, 'devices.reference_code')) continue
        throw err
      }
    }
  })
}

export function authenticateDevice(ctx: AppContext, token: string): DeviceRow | null {
  if (!token || token.length > 128) return null
  const row = ctx.db.prepare('SELECT * FROM devices WHERE token_hash = ?').get(sha256Hex(token)) as DeviceRow | undefined
  if (!row) return null
  const now = ctx.clock.now()
  // Throttle last_seen writes to one per minute per device.
  if (now.getTime() - Date.parse(row.last_seen_at) > 60_000) {
    ctx.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(now.toISOString(), row.id)
  }
  return row
}

export function getDevice(ctx: AppContext, id: string): DeviceRow | undefined {
  return ctx.db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as DeviceRow | undefined
}
