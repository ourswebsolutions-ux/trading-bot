import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { MIGRATIONS } from './migrations.js'

export type Db = DatabaseSync

export interface Migration {
  version: number
  name: string
  sql: string
}

export function openDatabase(file: string): Db {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA synchronous = NORMAL')
  return db
}

const checksum = (sql: string) => createHash('sha256').update(sql).digest('hex')

/** Applies pending migrations in order. Refuses to run if an applied migration was edited. */
export function migrate(db: Db, migrations: Migration[] = MIGRATIONS): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`)
  const applied = new Map(
    (db.prepare('SELECT version, checksum FROM schema_migrations').all() as { version: number; checksum: string }[])
      .map((r) => [r.version, r.checksum])
  )
  const ran: number[] = []
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    const existing = applied.get(m.version)
    if (existing) {
      if (existing !== checksum(m.sql)) throw new Error(`Migration ${m.version} (${m.name}) was modified after being applied`)
      continue
    }
    transaction(db, () => {
      db.exec(m.sql)
      db.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')
        .run(m.version, m.name, checksum(m.sql), new Date().toISOString())
    })
    ran.push(m.version)
  }
  return ran
}

/** Runs fn inside BEGIN IMMEDIATE so concurrent writers serialize instead of deadlocking. */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/** SQLITE_CONSTRAINT_UNIQUE (2067); node:sqlite reports the column, e.g. "payment_requests.transaction_id". */
export function isUniqueViolation(err: unknown, column?: string): boolean {
  if (!(err instanceof Error)) return false
  const e = err as Error & { errcode?: number }
  const unique = e.errcode === 2067 || e.message.includes('UNIQUE constraint failed')
  return unique && (!column || e.message.includes(column))
}
