import { isValidEmail } from '@tradepilot/shared'
import type { AppContext } from '../context.js'
import type { Db } from '../db/sqlite.js'
import { getDummyHash, hashPassword, verifyPassword } from '../security/passwords.js'
import { newId } from '../security/tokens.js'
import { recordAudit } from './audit.js'

export type AdminRole = 'superadmin' | 'reviewer'

export interface AdminRow {
  id: string
  email: string
  display_name: string
  password_hash: string
  role: AdminRole
  failed_attempts: number
  locked_until: string | null
  disabled: number
}

export const MAX_FAILED_LOGINS = 5
export const LOCKOUT_MS = 15 * 60_000
export const MIN_ADMIN_PASSWORD_LENGTH = 12

export async function createAdmin(db: Db, at: Date, input: { email: string; displayName: string; password: string; role: AdminRole }): Promise<string> {
  if (!isValidEmail(input.email)) throw new Error('Invalid email address')
  if (input.password.length < MIN_ADMIN_PASSWORD_LENGTH) throw new Error(`Password must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters`)
  const id = newId()
  const hash = await hashPassword(input.password)
  db.prepare(
    `INSERT INTO admins (id, email, display_name, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, input.email.toLowerCase(), input.displayName, hash, input.role, at.toISOString(), at.toISOString())
  recordAudit(db, at, { actorType: 'system', action: 'admin.created', entityType: 'admin', entityId: id, details: { email: input.email.toLowerCase(), role: input.role } })
  return id
}

export interface AuthenticatedAdmin {
  id: string
  email: string
  role: AdminRole
}

export type AuthResult = { ok: true; admin: AuthenticatedAdmin } | { ok: false; reason: 'invalid' | 'locked'; lockedUntil?: string }

/**
 * Verifies administrator credentials for one action (no session is created). Per-account
 * lockout after repeated failures; unknown emails take as long as wrong passwords.
 */
export async function authenticateAdmin(ctx: AppContext, email: string, password: string, ip: string | null): Promise<AuthResult> {
  const now = ctx.clock.now()
  const admin = ctx.db.prepare('SELECT * FROM admins WHERE email = ?').get(email.trim().toLowerCase()) as AdminRow | undefined

  if (!admin || admin.disabled) {
    await verifyPassword(password, await getDummyHash())
    recordAudit(ctx.db, now, { actorType: 'system', action: 'admin.auth_failed', details: { email: email.slice(0, 254), reason: 'unknown_or_disabled' }, ip })
    return { ok: false, reason: 'invalid' }
  }
  if (admin.locked_until && admin.locked_until > now.toISOString()) {
    recordAudit(ctx.db, now, { actorType: 'admin', actorId: admin.id, action: 'admin.auth_blocked', entityType: 'admin', entityId: admin.id, ip })
    return { ok: false, reason: 'locked', lockedUntil: admin.locked_until }
  }
  if (!(await verifyPassword(password, admin.password_hash))) {
    const attempts = admin.failed_attempts + 1
    const lockedUntil = attempts >= MAX_FAILED_LOGINS ? new Date(now.getTime() + LOCKOUT_MS).toISOString() : null
    ctx.db.prepare('UPDATE admins SET failed_attempts = ?, locked_until = ? WHERE id = ?').run(lockedUntil ? 0 : attempts, lockedUntil, admin.id)
    recordAudit(ctx.db, now, { actorType: 'admin', actorId: admin.id, action: lockedUntil ? 'admin.locked_out' : 'admin.auth_failed', entityType: 'admin', entityId: admin.id, ip })
    return lockedUntil ? { ok: false, reason: 'locked', lockedUntil } : { ok: false, reason: 'invalid' }
  }
  ctx.db.prepare('UPDATE admins SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(admin.id)
  return { ok: true, admin: { id: admin.id, email: admin.email, role: admin.role } }
}
