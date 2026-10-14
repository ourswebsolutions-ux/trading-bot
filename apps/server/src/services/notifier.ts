import type { Clock } from '../clock.js'
import type { Db } from '../db/sqlite.js'
import { newId } from '../security/tokens.js'
import type { Mailer } from './mailer.js'

export interface EmailNotification {
  kind: string
  to: string | null
  subject: string
  body: string
  requestId?: string
  deviceId?: string
}

export interface InAppNotification {
  kind: string
  deviceId: string
  subject: string
  body: string
  requestId?: string
}

/**
 * Records every notification in the notifications table with its real delivery
 * outcome (sent / failed / skipped). Emails are sent after the business transaction
 * commits, so an SMTP outage never rolls back a payment decision.
 */
export class Notifier {
  private inFlight = new Set<Promise<unknown>>()

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    readonly mailer: Mailer,
    private readonly log: { error: (obj: object, msg: string) => void } = { error: () => {} }
  ) {}

  storeInApp(n: InAppNotification): void {
    this.db.prepare(
      `INSERT INTO notifications (id, channel, kind, recipient, subject, body, request_id, device_id, status, created_at, sent_at)
       VALUES (?, 'in_app', ?, ?, ?, ?, ?, ?, 'stored', ?, ?)`
    ).run(newId(), n.kind, n.deviceId, n.subject, n.body, n.requestId ?? null, n.deviceId, this.clock.now().toISOString(), this.clock.now().toISOString())
  }

  /** Queues an email; returns the delivery promise (also tracked for graceful shutdown/tests). */
  email(n: EmailNotification): Promise<'sent' | 'failed' | 'skipped'> {
    const id = newId()
    const now = this.clock.now().toISOString()
    const skipReason = !n.to ? 'No recipient address configured' : !this.mailer.configured ? 'SMTP is not configured' : null
    this.db.prepare(
      `INSERT INTO notifications (id, channel, kind, recipient, subject, body, request_id, device_id, status, error, created_at)
       VALUES (?, 'email', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, n.kind, n.to ?? '(none)', n.subject, n.body, n.requestId ?? null, n.deviceId ?? null, skipReason ? 'skipped' : 'queued', skipReason, now)
    if (skipReason) return Promise.resolve('skipped')

    const delivery = this.mailer
      .send({ to: n.to!, subject: n.subject, text: n.body })
      .then(() => {
        this.db.prepare(`UPDATE notifications SET status = 'sent', sent_at = ?, error = NULL WHERE id = ?`).run(this.clock.now().toISOString(), id)
        return 'sent' as const
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        this.log.error({ err: message, notificationId: id }, 'email delivery failed')
        this.db.prepare(`UPDATE notifications SET status = 'failed', error = ? WHERE id = ?`).run(message.slice(0, 500), id)
        return 'failed' as const
      })
    this.inFlight.add(delivery)
    void delivery.finally(() => this.inFlight.delete(delivery))
    return delivery
  }

  /** Resolves once every queued email has settled. */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight])
  }
}
