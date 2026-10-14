import { hashPassword, verifyPassword } from '@tradepilot/shared/passwords'
import { audit, type Db } from './db.js'
import { UserError } from './errors.js'
import type { AuthStatus, UnlockResult } from '../shared/ipc.js'

export const FREE_ATTEMPTS = 5
export const BASE_LOCKOUT_MS = 30_000
export const MAX_LOCKOUT_MS = 15 * 60_000
export const PASSWORD_POLICY = 'At least 10 characters, using at least two of: lowercase, uppercase, digits, symbols (or 16+ characters).'

const COMMON = new Set(['password123', 'password1234', 'qwertyuiop', '1234567890', 'tradepilot1', 'letmein123', 'administrator'])

export function passwordProblem(pw: string): string | null {
  if (pw.length < 10) return 'Password must be at least 10 characters.'
  if (pw.length > 256) return 'Password must be 256 characters or fewer.'
  if (COMMON.has(pw.toLowerCase())) return 'That password is too common.'
  if (/^(.)\1+$/.test(pw)) return 'Password cannot be one repeated character.'
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length
  if (pw.length < 16 && classes < 2) return 'Use at least two character types, or a passphrase of 16+ characters.'
  return null
}

/** Lockout grows 30s, 60s, 120s… after the free attempts, capped at 15 minutes. */
export function lockoutFor(failedAttempts: number): number {
  if (failedAttempts < FREE_ATTEMPTS) return 0
  return Math.min(MAX_LOCKOUT_MS, BASE_LOCKOUT_MS * 2 ** (failedAttempts - FREE_ATTEMPTS))
}

interface AuthRow {
  password_hash: string
  must_change: number
  failed_attempts: number
  locked_until: string | null
}

/**
 * Local application authentication (password only). This protects access to the app on
 * this computer; it is independent of subscription authorization, which the server decides.
 */
export class LocalAuth {
  private unlocked = false

  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date()
  ) {}

  private row(): AuthRow | undefined {
    return this.db.prepare('SELECT password_hash, must_change, failed_attempts, locked_until FROM local_auth WHERE id = 1').get() as AuthRow | undefined
  }

  isUnlocked(): boolean {
    return this.unlocked
  }

  status(): AuthStatus {
    const row = this.row()
    const lockedUntil = row?.locked_until && row.locked_until > this.now().toISOString() ? row.locked_until : null
    return {
      state: !row ? 'setup_required' : this.unlocked ? 'unlocked' : 'locked',
      mustChangePassword: Boolean(row?.must_change),
      lockedUntil,
      passwordPolicy: PASSWORD_POLICY
    }
  }

  /** First-run setup: only possible while no password exists. */
  async setup(password: string, confirm: string): Promise<AuthStatus> {
    if (this.row()) throw new UserError('already_configured', 'A password is already set.')
    if (password !== confirm) throw new UserError('validation_failed', 'Passwords do not match.', { confirm: 'Passwords do not match' })
    const problem = passwordProblem(password)
    if (problem) throw new UserError('validation_failed', problem, { password: problem })
    const iso = this.now().toISOString()
    this.db.prepare('INSERT INTO local_auth (id, password_hash, must_change, created_at, updated_at) VALUES (1, ?, 0, ?, ?)').run(await hashPassword(password), iso, iso)
    audit(this.db, 'auth.password_created')
    this.unlocked = true
    return this.status()
  }

  /**
   * Development / first-run provisioning from configuration. The password must still pass
   * the policy and is flagged must-change, so there is never a shared production default.
   */
  async seedInitialPassword(password: string): Promise<boolean> {
    if (this.row()) return false
    const problem = passwordProblem(password)
    if (problem) throw new Error(`Configured initial password rejected: ${problem}`)
    const iso = this.now().toISOString()
    this.db.prepare('INSERT INTO local_auth (id, password_hash, must_change, created_at, updated_at) VALUES (1, ?, 1, ?, ?)').run(await hashPassword(password), iso, iso)
    audit(this.db, 'auth.initial_password_seeded')
    return true
  }

  async unlock(password: string): Promise<UnlockResult> {
    const row = this.row()
    if (!row) throw new UserError('setup_required', 'Create a password first.')
    const now = this.now()
    if (row.locked_until && row.locked_until > now.toISOString()) {
      return { unlocked: false, lockedUntil: row.locked_until, attemptsRemaining: 0 }
    }
    if (typeof password !== 'string' || password.length === 0 || password.length > 1024) {
      return { unlocked: false, attemptsRemaining: Math.max(0, FREE_ATTEMPTS - row.failed_attempts) }
    }
    if (await verifyPassword(password, row.password_hash)) {
      this.db.prepare('UPDATE local_auth SET failed_attempts = 0, locked_until = NULL WHERE id = 1').run()
      audit(this.db, 'auth.unlocked')
      this.unlocked = true
      return { unlocked: true }
    }
    return this.registerFailure(row.failed_attempts + 1, now)
  }

  private registerFailure(attempts: number, now: Date): UnlockResult {
    const lockMs = lockoutFor(attempts)
    const lockedUntil = lockMs > 0 ? new Date(now.getTime() + lockMs).toISOString() : null
    this.db.prepare('UPDATE local_auth SET failed_attempts = ?, locked_until = ? WHERE id = 1').run(attempts, lockedUntil)
    audit(this.db, lockedUntil ? 'auth.locked_out' : 'auth.failed_attempt', { attempts })
    return { unlocked: false, lockedUntil, attemptsRemaining: Math.max(0, FREE_ATTEMPTS - attempts) }
  }

  async changePassword(current: string, next: string, confirm: string): Promise<AuthStatus> {
    if (!this.unlocked) throw new UserError('locked', 'Unlock the application first.')
    const row = this.row()!
    if (row.locked_until && row.locked_until > this.now().toISOString()) {
      throw new UserError('locked_out', 'Too many incorrect attempts. Try again later.')
    }
    if (!(await verifyPassword(current, row.password_hash))) {
      const result = this.registerFailure(row.failed_attempts + 1, this.now())
      throw new UserError('invalid_password', result.lockedUntil ? 'Incorrect password. Password changes are temporarily locked.' : 'Current password is incorrect.', {
        current: 'Incorrect password'
      })
    }
    if (next !== confirm) throw new UserError('validation_failed', 'New passwords do not match.', { confirm: 'Passwords do not match' })
    if (next === current) throw new UserError('validation_failed', 'Choose a password different from the current one.', { next: 'Must differ from current password' })
    const problem = passwordProblem(next)
    if (problem) throw new UserError('validation_failed', problem, { next: problem })
    this.db.prepare('UPDATE local_auth SET password_hash = ?, must_change = 0, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = 1')
      .run(await hashPassword(next), this.now().toISOString())
    audit(this.db, 'auth.password_changed')
    return this.status()
  }

  lock(reason: 'manual' | 'idle' | 'logout' = 'manual'): AuthStatus {
    if (this.unlocked) audit(this.db, 'auth.locked', { reason })
    this.unlocked = false
    return this.status()
  }
}
