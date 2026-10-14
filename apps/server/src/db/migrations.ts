import type { Migration } from './sqlite.js'

/**
 * Versioned, append-only migrations. Never edit an applied migration; add a new one.
 * Timestamps are ISO-8601 UTC strings (fixed width, so they compare lexicographically).
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_subscription_schema',
    sql: `
CREATE TABLE plans (
  code TEXT PRIMARY KEY CHECK (code IN ('monthly', 'lifetime')),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (length(currency) = 3),
  billing TEXT NOT NULL CHECK (billing IN ('monthly', 'one_time')),
  duration_months INTEGER CHECK (duration_months IS NULL OR duration_months > 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  CHECK ((billing = 'one_time') = (duration_months IS NULL))
);

INSERT INTO plans (code, name, description, price_cents, currency, billing, duration_months, sort_order) VALUES
  ('monthly', 'Monthly', 'Full TradePilot access for one calendar month from activation. Renew with a new payment before expiry; renewals extend from the current end date.', 2000, 'USD', 'monthly', 1, 1),
  ('lifetime', 'Lifetime', 'One-time payment for permanent TradePilot access for the lifetime of the product, subject to the published terms.', 50000, 'USD', 'one_time', NULL, 2);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  fingerprint_hash TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  reference_code TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL,
  app_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  token_rotated_at TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1))
);

CREATE TABLE trials (
  device_id TEXT PRIMARY KEY REFERENCES devices(id),
  started_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  CHECK (ends_at > started_at)
);

CREATE TABLE payment_requests (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id),
  plan_code TEXT NOT NULL REFERENCES plans(code),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL,
  transaction_id TEXT NOT NULL CHECK (length(transaction_id) BETWEEN 6 AND 64),
  contact_email TEXT,
  note TEXT CHECK (note IS NULL OR length(note) <= 500),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'cancelled')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  CHECK ((status = 'pending') = (decided_at IS NULL))
);
-- A payment reference can back at most one live (pending or approved) request.
CREATE UNIQUE INDEX ux_payment_requests_live_txn ON payment_requests(transaction_id) WHERE status IN ('pending', 'approved');
-- One pending request per device at a time.
CREATE UNIQUE INDEX ux_payment_requests_one_pending ON payment_requests(device_id) WHERE status = 'pending';
CREATE INDEX ix_payment_requests_status_created ON payment_requests(status, created_at);
CREATE INDEX ix_payment_requests_device_created ON payment_requests(device_id, created_at);

CREATE TABLE payment_evidence (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES payment_requests(id),
  storage_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 5242880),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  original_name TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_payment_evidence_sha256 ON payment_evidence(sha256);

CREATE TABLE admins (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('superadmin', 'reviewer')),
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE admin_sessions (
  id_hash TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX ix_admin_sessions_admin ON admin_sessions(admin_id);

-- Exactly one decision per request: the UNIQUE constraint blocks conflicting admin actions.
CREATE TABLE admin_decisions (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES payment_requests(id),
  admin_id TEXT NOT NULL REFERENCES admins(id),
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'cancelled')),
  reason TEXT,
  created_at TEXT NOT NULL,
  CHECK (decision = 'approved' OR (reason IS NOT NULL AND length(trim(reason)) > 0))
);

-- Activations. request_id is UNIQUE so an approval can activate at most once.
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id),
  plan_code TEXT NOT NULL REFERENCES plans(code),
  request_id TEXT NOT NULL UNIQUE REFERENCES payment_requests(id),
  starts_at TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  CHECK ((plan_code = 'lifetime') = (expires_at IS NULL)),
  CHECK (expires_at IS NULL OR expires_at > starts_at)
);
CREATE INDEX ix_subscriptions_device_starts ON subscriptions(device_id, starts_at);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'in_app')),
  kind TEXT NOT NULL,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  request_id TEXT REFERENCES payment_requests(id),
  device_id TEXT REFERENCES devices(id),
  status TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'failed', 'skipped', 'stored')),
  error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX ix_notifications_request ON notifications(request_id);
CREATE INDEX ix_notifications_device_created ON notifications(device_id, created_at);

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('admin', 'device', 'system')),
  actor_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  details TEXT,
  ip TEXT
);
CREATE INDEX ix_audit_events_entity ON audit_events(entity_type, entity_id);
CREATE INDEX ix_audit_events_time ON audit_events(occurred_at);
CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;

CREATE TABLE server_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);
`
  },
  {
    version: 2,
    name: 'email_review_links',
    sql: `
-- Single-use links emailed to the business address. Only the SHA-256 of each token is stored.
CREATE TABLE review_tokens (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES payment_requests(id),
  action TEXT NOT NULL CHECK (action IN ('confirm', 'cancel')),
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT,
  CHECK (expires_at > created_at)
);
CREATE INDEX ix_review_tokens_request ON review_tokens(request_id);
`
  }
]
