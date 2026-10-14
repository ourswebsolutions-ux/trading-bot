import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { convertLegacy, type LegacyStrategy } from '../shared/strategyRules.js'

export type Db = DatabaseSync

interface Migration {
  version: number
  name: string
  sql: string
  /** Data conversion that needs code; runs in the same transaction, after the SQL. */
  after?: (db: Db) => void
  /** Table rebuilds: run with foreign keys off so dropping the old table does not cascade. */
  rebuild?: boolean
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

-- Values are encrypted with Electron safeStorage (OS keychain-backed key). The only value allowed
-- to fall back to unencrypted storage (encrypted = 0) is the device token, when no keychain exists.
CREATE TABLE secrets (
  name TEXT PRIMARY KEY,
  ciphertext BLOB NOT NULL,
  encrypted INTEGER NOT NULL DEFAULT 1 CHECK (encrypted IN (0, 1)),
  hint TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (encrypted = 1 OR name = 'device.token')
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
  },
  {
    version: 2,
    name: 'phase2_integrations_market_data_ai',
    sql: `
-- Rebuild integration_status to add market data, last-success timestamps and details.
CREATE TABLE integration_status_v2 (
  integration TEXT PRIMARY KEY CHECK (integration IN ('delta', 'openai', 'anthropic', 'smtp', 'whatsapp', 'marketdata')),
  state TEXT NOT NULL CHECK (state IN ('untested', 'connected', 'failed')),
  message TEXT,
  checked_at TEXT,
  last_success_at TEXT,
  details TEXT
);
INSERT INTO integration_status_v2 (integration, state, message, checked_at, last_success_at)
  SELECT integration, state, message, checked_at, CASE WHEN state = 'connected' THEN checked_at END FROM integration_status;
DROP TABLE integration_status;
ALTER TABLE integration_status_v2 RENAME TO integration_status;

-- Every AI request (successful or not) for usage limits and reporting.
CREATE TABLE ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL CHECK (provider IN ('openai', 'anthropic')),
  model TEXT NOT NULL,
  purpose TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
  error_code TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_ai_usage_provider_created ON ai_usage(provider, created_at);

-- Recipients who opted in to receive messages on a channel (WhatsApp Business policy).
CREATE TABLE messaging_consents (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp')),
  recipient TEXT NOT NULL CHECK (length(recipient) BETWEEN 8 AND 16),
  note TEXT NOT NULL DEFAULT '',
  consented_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE UNIQUE INDEX ux_messaging_consents_active ON messaging_consents(channel, recipient) WHERE revoked_at IS NULL;
`
  },
  {
    version: 3,
    name: 'phase3_rule_based_strategies',
    rebuild: true,
    sql: `
CREATE TABLE strategies_v3 (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  symbol TEXT NOT NULL,
  timeframe TEXT,
  -- full rule-based definition (version 2 JSON); validated before a strategy can be enabled
  definition TEXT NOT NULL CHECK (json_valid(definition)),
  status TEXT NOT NULL DEFAULT 'disabled' CHECK (status IN ('disabled', 'enabled')),
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ai', 'converted')),
  ai_provider TEXT,
  enabled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  legacy TEXT,
  CHECK ((status = 'enabled') = (enabled_at IS NOT NULL))
);
-- old template columns are kept in "legacy" and converted to rules by code in the same transaction
INSERT INTO strategies_v3 (id, name, symbol, timeframe, definition, status, source, created_at, updated_at, legacy)
  SELECT id, name, symbol, timeframe, '{}', 'disabled', 'converted', created_at, updated_at,
    json_object('name', name, 'symbol', symbol, 'timeframe', timeframe, 'type', type, 'params', json(params), 'risk', json(risk), 'allowShort', allow_short = 1, 'notes', notes, 'status', status)
  FROM strategies;
DROP TABLE strategies;
ALTER TABLE strategies_v3 RENAME TO strategies;
CREATE INDEX ix_strategies_status ON strategies(status, updated_at);
`,
    after: (db) => {
      convertLegacyStrategies(db)
      // created after conversion, which renames same-named (formerly archived) strategies
      db.exec('CREATE UNIQUE INDEX ux_strategies_name ON strategies(lower(name))')
    }
  },
  {
    version: 4,
    name: 'phase4_automated_trading',
    sql: `
CREATE TABLE automation_sessions (
  id TEXT PRIMARY KEY,
  -- history survives deleting the strategy
  strategy_id TEXT REFERENCES strategies(id) ON DELETE SET NULL,
  strategy_name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  product_id INTEGER NOT NULL,
  timeframe TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('paper', 'live')),
  status TEXT NOT NULL CHECK (status IN ('running', 'paused', 'stopped')),
  started_at TEXT NOT NULL,
  paused_at TEXT,
  stopped_at TEXT,
  stop_reason TEXT,
  last_candle INTEGER,
  last_signal_candle INTEGER,
  last_evaluated_at TEXT,
  last_decision TEXT,
  position TEXT CHECK (position IS NULL OR json_valid(position)),
  entries_blocked_reason TEXT,
  day_key TEXT,
  day_trades INTEGER NOT NULL DEFAULT 0,
  day_realized_pnl REAL NOT NULL DEFAULT 0,
  day_start_equity REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((status = 'stopped') = (stopped_at IS NOT NULL))
);
-- one active automation per strategy, and one live automation per instrument
CREATE UNIQUE INDEX ux_automation_active_strategy ON automation_sessions(strategy_id) WHERE status != 'stopped';
CREATE UNIQUE INDEX ux_automation_live_symbol ON automation_sessions(symbol) WHERE status != 'stopped' AND mode = 'live';
CREATE INDEX ix_automation_status ON automation_sessions(status);

CREATE TABLE auto_orders (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES automation_sessions(id),
  mode TEXT NOT NULL CHECK (mode IN ('paper', 'live')),
  client_order_id TEXT NOT NULL UNIQUE CHECK (length(client_order_id) BETWEEN 1 AND 32),
  exchange_order_id TEXT,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  purpose TEXT NOT NULL CHECK (purpose IN ('entry', 'exit', 'emergency')),
  signal_key TEXT NOT NULL,
  size REAL NOT NULL CHECK (size > 0),
  filled_size REAL NOT NULL DEFAULT 0 CHECK (filled_size >= 0),
  avg_fill_price REAL,
  fee REAL NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('pending', 'open', 'partially_filled', 'filled', 'cancelled', 'rejected', 'unknown')),
  stop_price REAL,
  take_price REAL,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- a given signal can create at most one entry order, ever
CREATE UNIQUE INDEX ux_auto_orders_entry_signal ON auto_orders(signal_key) WHERE purpose = 'entry';
CREATE INDEX ix_auto_orders_session ON auto_orders(session_id, created_at);
CREATE INDEX ix_auto_orders_state ON auto_orders(state);

CREATE TABLE auto_trades (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES automation_sessions(id),
  mode TEXT NOT NULL CHECK (mode IN ('paper', 'live')),
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('long', 'short')),
  contracts REAL NOT NULL,
  contract_value REAL NOT NULL,
  entry_price REAL NOT NULL,
  exit_price REAL NOT NULL,
  entry_time TEXT NOT NULL,
  exit_time TEXT NOT NULL,
  gross_pnl REAL NOT NULL,
  fees REAL NOT NULL,
  net_pnl REAL NOT NULL,
  exit_reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_auto_trades_session ON auto_trades(session_id, exit_time);
CREATE INDEX ix_auto_trades_exit ON auto_trades(mode, exit_time);

CREATE TABLE automation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  level TEXT NOT NULL CHECK (level IN ('info', 'warning', 'error')),
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_automation_events_created ON automation_events(created_at);
`
  },
  {
    version: 5,
    name: 'phase5_prompts_and_versions',
    sql: `
-- the plain-language prompt the strategy was created from, and its current version number
ALTER TABLE strategies ADD COLUMN prompt TEXT;
ALTER TABLE strategies ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

-- every confirmed change is a new immutable version
CREATE TABLE strategy_versions (
  strategy_id TEXT NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  name TEXT NOT NULL,
  definition TEXT NOT NULL CHECK (json_valid(definition)),
  prompt TEXT,
  change_request TEXT,
  source TEXT NOT NULL CHECK (source IN ('manual', 'ai', 'converted')),
  ai_provider TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (strategy_id, version)
);
INSERT INTO strategy_versions (strategy_id, version, name, definition, prompt, change_request, source, ai_provider, created_at)
  SELECT id, 1, name, definition, NULL, NULL, source, ai_provider, updated_at FROM strategies;

-- a session runs a pinned snapshot of one version; trades record the version that produced them
ALTER TABLE automation_sessions ADD COLUMN strategy_version INTEGER;
ALTER TABLE automation_sessions ADD COLUMN definition TEXT CHECK (definition IS NULL OR json_valid(definition));
-- Phase 4 froze strategies while automated, so active sessions ran the current definition
UPDATE automation_sessions SET strategy_version = 1, definition = (SELECT definition FROM strategies WHERE strategies.id = automation_sessions.strategy_id)
  WHERE status != 'stopped' AND strategy_id IS NOT NULL;
ALTER TABLE auto_trades ADD COLUMN strategy_version INTEGER;
ALTER TABLE backtest_runs ADD COLUMN strategy_version INTEGER;
`
  }
]

/**
 * Pre-release builds shipped two earlier variants of migration 1. Databases created by them are
 * upgraded in place (data kept) instead of refusing to start. Keyed by the variant's checksum.
 */
function addSecretsEncryptedColumn(db: Db) {
  db.exec(`
CREATE TABLE secrets_v1fix (
  name TEXT PRIMARY KEY,
  ciphertext BLOB NOT NULL,
  encrypted INTEGER NOT NULL DEFAULT 1 CHECK (encrypted IN (0, 1)),
  hint TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (encrypted = 1 OR name = 'device.token')
);
INSERT INTO secrets_v1fix (name, ciphertext, encrypted, hint, updated_at) SELECT name, ciphertext, 1, hint, updated_at FROM secrets;
DROP TABLE secrets;
ALTER TABLE secrets_v1fix RENAME TO secrets;`)
}
function addNotificationsDismissedColumn(db: Db) {
  const cols = db.prepare(`PRAGMA table_info(notifications)`).all() as { name: string }[]
  if (!cols.some((c) => c.name === 'dismissed_at')) db.exec('ALTER TABLE notifications ADD COLUMN dismissed_at TEXT')
}
const LEGACY_REPAIRS: Record<number, Record<string, (db: Db) => void>> = {
  1: {
    // without secrets.encrypted
    '96f0c3adebc8ffc93b26dfade2a0d05bf5ad858c022e0ac72099211128388cba': addSecretsEncryptedColumn,
    // original: also without notifications.dismissed_at
    c40a3a7ee098fed71fea7277fe6dae601cd68b37bb5c31c91618db35ebfe275d: (db) => {
      addSecretsEncryptedColumn(db)
      addNotificationsDismissedColumn(db)
    }
  }
}

/** Converts Phase 1–2 template strategies (kept in "legacy") into rule definitions. */
function convertLegacyStrategies(db: Db) {
  const rows = db.prepare(`SELECT id, legacy FROM strategies WHERE legacy IS NOT NULL`).all() as { id: string; legacy: string }[]
  const seen = new Set<string>()
  for (const r of rows) {
    const legacy = JSON.parse(r.legacy) as LegacyStrategy & { status: string }
    const def = convertLegacy(legacy)
    // archived duplicates of an active name get a suffix so the new unique-name rule holds
    let name = def.name
    for (let i = 2; seen.has(name.toLowerCase()); i++) name = `${def.name} (${i})`.slice(0, 80)
    seen.add(name.toLowerCase())
    def.name = name
    db.prepare('UPDATE strategies SET definition = ?, name = ? WHERE id = ?').run(JSON.stringify(def), name, r.id)
  }
}

const checksum = (sql: string) => createHash('sha256').update(sql).digest('hex')

export function openDatabase(file: string): Db {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  if (file !== ':memory:') backupBeforeMigrating(db, file)
  migrate(db)
  return db
}

const KEEP_MIGRATION_BACKUPS = 3

/**
 * Before an app update changes the schema, keep a consistent copy of the existing database
 * (`<file>.pre-v<N>-<time>.bak`, newest three kept) so data can be restored if something
 * goes wrong. Fresh databases (no migrations yet) are not backed up.
 */
export function backupBeforeMigrating(db: Db, file: string, migrations: Migration[] = MIGRATIONS): string | null {
  const hasTable = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`).get()
  if (!hasTable) return null
  const applied = new Set((db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version))
  if (applied.size === 0) return null
  const pending = migrations.filter((m) => !applied.has(m.version))
  if (!pending.length) return null
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  let target = `${file}.pre-v${pending[0]!.version}-${stamp}.bak`
  for (let i = 2; existsSync(target); i++) target = `${file}.pre-v${pending[0]!.version}-${stamp}-${i}.bak`
  db.prepare('VACUUM INTO ?').run(target)
  const dir = path.dirname(file)
  const prefix = `${path.basename(file)}.pre-v`
  const old = readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.bak')).sort()
  for (const f of old.slice(0, Math.max(0, old.length - KEEP_MIGRATION_BACKUPS))) rmSync(path.join(dir, f), { force: true })
  return target
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
      if (existing === checksum(m.sql)) continue
      const repair = LEGACY_REPAIRS[m.version]?.[existing]
      if (!repair) throw new Error(`Local migration ${m.version} was modified after being applied`)
      transaction(db, () => {
        repair(db)
        db.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = ?').run(checksum(m.sql), m.version)
      })
      continue
    }
    if (m.rebuild) db.exec('PRAGMA foreign_keys = OFF')
    try {
      transaction(db, () => {
        db.exec(m.sql)
        m.after?.(db)
        if (m.rebuild) {
          const broken = db.prepare('PRAGMA foreign_key_check').all()
          if (broken.length) throw new Error(`Migration ${m.version} left ${broken.length} broken foreign key reference(s)`)
        }
        db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?, ?)').run(m.version, m.name, checksum(m.sql), new Date().toISOString())
      })
    } finally {
      if (m.rebuild) db.exec('PRAGMA foreign_keys = ON')
    }
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
