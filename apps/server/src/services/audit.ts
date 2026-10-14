import type { Db } from '../db/sqlite.js'

export interface AuditInput {
  actorType: 'admin' | 'device' | 'system'
  actorId?: string | null
  action: string
  entityType?: string
  entityId?: string
  details?: Record<string, unknown>
  ip?: string | null
}

export function recordAudit(db: Db, at: Date, e: AuditInput): void {
  db.prepare(
    `INSERT INTO audit_events (occurred_at, actor_type, actor_id, action, entity_type, entity_id, details, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    at.toISOString(),
    e.actorType,
    e.actorId ?? null,
    e.action,
    e.entityType ?? null,
    e.entityId ?? null,
    e.details ? JSON.stringify(e.details) : null,
    e.ip ?? null
  )
}

export interface AuditRow {
  id: number
  occurred_at: string
  actor_type: string
  actor_id: string | null
  actor_label: string | null
  action: string
  entity_type: string | null
  entity_id: string | null
  details: string | null
  ip: string | null
}

const SELECT_AUDIT = `SELECT a.*, ad.email AS actor_label FROM audit_events a
  LEFT JOIN admins ad ON a.actor_type = 'admin' AND ad.id = a.actor_id`

export function listAudit(db: Db, opts: { entityId?: string; limit?: number; offset?: number } = {}): AuditRow[] {
  const limit = Math.min(opts.limit ?? 100, 500)
  if (opts.entityId) {
    return db.prepare(`${SELECT_AUDIT} WHERE a.entity_id = ? ORDER BY a.id DESC LIMIT ?`).all(opts.entityId, limit) as unknown as AuditRow[]
  }
  return db.prepare(`${SELECT_AUDIT} ORDER BY a.id DESC LIMIT ? OFFSET ?`).all(limit, opts.offset ?? 0) as unknown as AuditRow[]
}
