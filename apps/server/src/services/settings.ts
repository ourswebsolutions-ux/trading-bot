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

/** Seeds settings that come from the environment on first boot; later edits happen in the admin UI. */
export function seedSettings(db: Db, at: Date, initialNotifyEmail?: string): void {
  if (initialNotifyEmail && getSetting(db, 'admin_notify_email') === null) {
    setSetting(db, 'admin_notify_email', initialNotifyEmail, at, 'env')
  }
}
