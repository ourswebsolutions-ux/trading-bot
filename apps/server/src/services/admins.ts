import { isValidEmail } from '@tradepilot/shared'
import type { AppContext } from '../context.js'
import type { Db } from '../db/sqlite.js'
import { getDummyHash, hashPassword, verifyPassword } from '../security/passwords.js'
import { newId, randomToken, sha256Hex } from '../security/tokens.js'
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

export interface AdminSession {
  admin: Pick<AdminRow, 'id' | 'email' | 'display_name' | 'role'>
  csrfToken: string
}

export const MAX_FAILED_LOGINS = 5
export const LOCKOUT_MS = 15 * 60_000
export const SESSION_IDLE_MS = 30 * 60_000
export const SESSION_ABSOLUTE_MS = 8 * 3600_000
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

export type LoginResult =
  | { ok: true; sessionToken: string; session: AdminSession }
  | { ok: false; reason: 'invalid' | 'locked'; lockedUntil?: string }

/** Verifies credentials with per-account lockout. Unknown emails take the same time as wrong passwords. */
export async function loginAdmin(ctx: AppContext, email: string, password: string, meta: { ip: string | null; userAgent: string | null }): Promise<LoginResult> {
  const now = ctx.clock.now()
  const admin = ctx.db.prepare('SELECT * FROM admins WHERE email = ?').get(email.trim().toLowerCase()) as AdminRow | undefined

  if (!admin || admin.disabled) {
    await verifyPassword(password, await getDummyHash())
    recordAudit(ctx.db, now, { actorType: 'system', action: 'admin.login_failed', details: { email: email.slice(0, 254), reason: 'unknown_or_disabled' }, ip: meta.ip })
    return { ok: false, reason: 'invalid' }
  }
  if (admin.locked_until && admin.locked_until > now.toISOString()) {
    recordAudit(ctx.db, now, { actorType: 'admin', actorId: admin.id, action: 'admin.login_blocked', entityType: 'admin', entityId: admin.id, ip: meta.ip })
    return { ok: false, reason: 'locked', lockedUntil: admin.locked_until }
  }

  const valid = await verifyPassword(password, admin.password_hash)
  if (!valid) {
    const attempts = admin.failed_attempts + 1
    const lockedUntil = attempts >= MAX_FAILED_LOGINS ? new Date(now.getTime() + LOCKOUT_MS).toISOString() : null
    ctx.db.prepare('UPDATE admins SET failed_attempts = ?, locked_until = ? WHERE id = ?').run(lockedUntil ? 0 : attempts, lockedUntil, admin.id)
    recordAudit(ctx.db, now, {
      actorType: 'admin', actorId: admin.id, action: lockedUntil ? 'admin.locked_out' : 'admin.login_failed', entityType: 'admin', entityId: admin.id, ip: meta.ip
    })
    return lockedUntil ? { ok: false, reason: 'locked', lockedUntil } : { ok: false, reason: 'invalid' }
  }

  ctx.db.prepare('UPDATE admins SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(admin.id)
  const sessionToken = randomToken(32)
  const csrfToken = randomToken(24)
  const iso = now.toISOString()
  ctx.db.prepare(
    `INSERT INTO admin_sessions (id_hash, admin_id, csrf_token, created_at, last_seen_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(sha256Hex(sessionToken), admin.id, csrfToken, iso, iso, new Date(now.getTime() + SESSION_ABSOLUTE_MS).toISOString(), meta.ip, meta.userAgent?.slice(0, 300) ?? null)
  recordAudit(ctx.db, now, { actorType: 'admin', actorId: admin.id, action: 'admin.login', entityType: 'admin', entityId: admin.id, ip: meta.ip })
  return { ok: true, sessionToken, session: { admin: { id: admin.id, email: admin.email, display_name: admin.display_name, role: admin.role }, csrfToken } }
}

export function getAdminSession(ctx: AppContext, sessionToken: string | undefined): AdminSession | null {
  if (!sessionToken || sessionToken.length > 100) return null
  const now = ctx.clock.now()
  const row = ctx.db.prepare(
    `SELECT s.id_hash, s.csrf_token, s.last_seen_at, s.expires_at, a.id, a.email, a.display_name, a.role, a.disabled
     FROM admin_sessions s JOIN admins a ON a.id = s.admin_id WHERE s.id_hash = ?`
  ).get(sha256Hex(sessionToken)) as
    | { id_hash: string; csrf_token: string; last_seen_at: string; expires_at: string; id: string; email: string; display_name: string; role: AdminRole; disabled: number }
    | undefined
  if (!row) return null
  const idleExpired = now.getTime() - Date.parse(row.last_seen_at) > SESSION_IDLE_MS
  if (row.disabled || idleExpired || row.expires_at <= now.toISOString()) {
    ctx.db.prepare('DELETE FROM admin_sessions WHERE id_hash = ?').run(row.id_hash)
    return null
  }
  ctx.db.prepare('UPDATE admin_sessions SET last_seen_at = ? WHERE id_hash = ?').run(now.toISOString(), row.id_hash)
  return { admin: { id: row.id, email: row.email, display_name: row.display_name, role: row.role }, csrfToken: row.csrf_token }
}

export function logoutAdmin(ctx: AppContext, sessionToken: string | undefined, ip: string | null): void {
  if (!sessionToken) return
  const row = ctx.db.prepare('SELECT admin_id FROM admin_sessions WHERE id_hash = ?').get(sha256Hex(sessionToken)) as { admin_id: string } | undefined
  ctx.db.prepare('DELETE FROM admin_sessions WHERE id_hash = ?').run(sha256Hex(sessionToken))
  if (row) recordAudit(ctx.db, ctx.clock.now(), { actorType: 'admin', actorId: row.admin_id, action: 'admin.logout', entityType: 'admin', entityId: row.admin_id, ip })
}

export function purgeExpiredSessions(ctx: AppContext): void {
  const now = ctx.clock.now()
  ctx.db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ? OR last_seen_at <= ?')
    .run(now.toISOString(), new Date(now.getTime() - SESSION_IDLE_MS).toISOString())
}
