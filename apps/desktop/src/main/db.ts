import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

export type Db = DatabaseSync

interface Migration {
  version: number
  name: string
  sql: string
}

/**
 * Local (per-user) database. Lives in Electron's userData directory, which installers
 * and auto-updates never touch, so settings, strategies and history survive updates.
 * Append-only: never edit an applied migration.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_local_schema',
    sql: `
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE local_auth (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT NOT NULL,
  must_change INTEGER NOT NULL DEFAULT 0 CHECK (must_change IN (0, 1)),
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Values are encrypted with Electron safeStorage (OS keychain-backed key). Never plaintext.
CREATE TABLE secrets (
  name TEXT PRIMARY KEY,
  ciphertext BLOB NOT NULL,
  hint TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE integration_status (
  integration TEXT PRIMARY KEY CHECK (integration IN ('delta', 'openai', 'anthropic', 'smtp', 'whatsapp')),
  state TEXT NOT NULL CHECK (state IN ('untested', 'connected', 'failed')),
  message TEXT,
  checked_at TEXT
);

CREATE TABLE strategies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  symbol TEXT NOT NULL CHECK (length(symbol) BETWEEN 2 AND 32),
  timeframe TEXT NOT NULL CHECK (timeframe IN ('5m', '15m', '1h', '4h', '1d')),
  type TEXT NOT NULL CHECK (type IN ('sma_cross', 'ema_cross', 'rsi_reversion', 'breakout')),
  params TEXT NOT NULL,
  risk TEXT NOT NULL,
  allow_short INTEGER NOT NULL DEFAULT 0 CHECK (allow_short IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'paper', 'archived')),
  notes TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_strategies_active_name ON strategies(lower(name)) WHERE status != 'archived';
CREATE INDEX ix_strategies_status ON strategies(status, updated_at);

CREATE TABLE backtest_runs (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  range_start INTEGER NOT NULL,
  range_end INTEGER NOT NULL,
  metrics TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_backtest_runs_strategy ON backtest_runs(strategy_id, created_at);

CREATE TABLE paper_orders (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  quantity REAL NOT NULL CHECK (quantity > 0),
  fill_price REAL NOT NULL CHECK (fill_price > 0),
  created_at TEXT NOT NULL
);
CREATE INDEX ix_paper_orders_symbol ON paper_orders(symbol, created_at);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  remote_id TEXT UNIQUE,
  category TEXT NOT NULL CHECK (category IN ('subscription', 'system', 'update', 'trading', 'security')),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'success', 'warning', 'error')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  read_at TEXT,
  -- cleared notifications are hidden but kept, so server notifications are never re-imported
  dismissed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_notifications_created ON notifications(created_at);

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT NOT NULL,
  action TEXT NOT NULL,
  details TEXT
);
CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;

-- Last verified server status (including the signed entitlement token) for offline use.
CREATE TABLE subscription_cache (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
`
  }
]

const checksum = (sql: string) => createHash('sha256').update(sql).digest('hex')

export function openDatabase(file: string): Db {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  migrate(db)
  return db
}

export function migrate(db: Db, migrations: Migration[] = MIGRATIONS): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)`)
  const applied = new Map(
    (db.prepare('SELECT version, checksum FROM schema_migrations').all() as { version: number; checksum: string }[]).map((r) => [r.version, r.checksum])
  )
  const ran: number[] = []
  for (const m of migrations) {
    const existing = applied.get(m.version)
    if (existing) {
      if (existing !== checksum(m.sql)) throw new Error(`Local migration ${m.version} was modified after being applied`)
      continue
    }
    transaction(db, () => {
      db.exec(m.sql)
      db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?, ?)').run(m.version, m.name, checksum(m.sql), new Date().toISOString())
    })
    ran.push(m.version)
  }
  return ran
}

export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export function audit(db: Db, action: string, details?: Record<string, unknown>): void {
  db.prepare('INSERT INTO audit_events (occurred_at, action, details) VALUES (?, ?, ?)').run(
    new Date().toISOString(),
    action,
    details ? JSON.stringify(details) : null
  )
}

export function getSetting<T>(db: Db, key: string, fallback: T): T {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined
  if (!row) return fallback
  try {
    return JSON.parse(row.value) as T
  } catch {
    return fallback
  }
}

export function setSetting(db: Db, key: string, value: unknown): void {
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, JSON.stringify(value), new Date().toISOString())
}
