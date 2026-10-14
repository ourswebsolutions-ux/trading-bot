import type { Db } from '../db/sqlite.js'

export type SettingKey = 'admin_notify_email' | 'payment_instructions'

export function getSetting(db: Db, key: SettingKey): string | null {
  const row = db.prepare('SELECT value FROM server_settings WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function setSetting(db: Db, key: SettingKey, value: string, at: Date, by: string | null): void {
  db.prepare(
    `INSERT INTO server_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
  ).run(key, value, at.toISOString(), by)
}

/** The environment is authoritative: values configured there are applied on every start. */
export function applyConfiguredSettings(db: Db, at: Date, cfg: { adminNotifyEmail?: string; paymentInstructions?: string }): void {
  if (cfg.adminNotifyEmail) setSetting(db, 'admin_notify_email', cfg.adminNotifyEmail, at, 'env')
  if (cfg.paymentInstructions) setSetting(db, 'payment_instructions', cfg.paymentInstructions, at, 'env')
}
