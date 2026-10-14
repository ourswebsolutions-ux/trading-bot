import { randomUUID } from 'node:crypto'
import type { Db } from './db.js'
import type { AppNotification } from '../shared/ipc.js'

interface Row {
  id: string
  category: AppNotification['category']
  severity: AppNotification['severity']
  title: string
  body: string
  read_at: string | null
  created_at: string
}
const toDto = (r: Row): AppNotification => ({ id: r.id, category: r.category, severity: r.severity, title: r.title, body: r.body, readAt: r.read_at, createdAt: r.created_at })

export class NotificationCenter {
  constructor(
    private readonly db: Db,
    private readonly onChange: (unread: number) => void,
    private readonly showNative: (title: string, body: string) => void
  ) {}

  add(n: { category: AppNotification['category']; severity: AppNotification['severity']; title: string; body: string; remoteId?: string; createdAt?: string; native?: boolean }): boolean {
    const result = this.db.prepare(
      `INSERT INTO notifications (id, remote_id, category, severity, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(remote_id) DO NOTHING`
    ).run(randomUUID(), n.remoteId ?? null, n.category, n.severity, n.title.slice(0, 200), n.body.slice(0, 2000), n.createdAt ?? new Date().toISOString())
    if (result.changes === 0) return false
    if (n.native !== false) this.showNative(n.title, n.body)
    this.onChange(this.unread())
    return true
  }

  list(): AppNotification[] {
    return (this.db.prepare('SELECT * FROM notifications WHERE dismissed_at IS NULL ORDER BY created_at DESC LIMIT 300').all() as unknown as Row[]).map(toDto)
  }

  unread(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL AND dismissed_at IS NULL').get() as { n: number }).n
  }

  markRead(ids: string[] | 'all'): AppNotification[] {
    const now = new Date().toISOString()
    if (ids === 'all') this.db.prepare('UPDATE notifications SET read_at = ? WHERE read_at IS NULL').run(now)
    else for (const id of ids.slice(0, 500)) this.db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL').run(now, id)
    this.onChange(this.unread())
    return this.list()
  }

  /** Clears read notifications only; unread ones stay so nothing is lost unseen. */
  clearRead(): AppNotification[] {
    this.db.prepare('UPDATE notifications SET dismissed_at = ? WHERE read_at IS NOT NULL AND dismissed_at IS NULL').run(new Date().toISOString())
    this.onChange(this.unread())
    return this.list()
  }
}
