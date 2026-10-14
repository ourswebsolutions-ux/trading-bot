import { createHash } from 'node:crypto'
import {
  PLAN_CODES,
  SCREENSHOT_MAX_BYTES,
  isValidEmail,
  isValidTransactionId,
  normalizeTransactionId,
  sniffImageMime,
  type PaymentRequestDto,
  type PaymentRequestStatus,
  type PlanCode,
  type PlanDto
} from '@tradepilot/shared'
import type { AppContext } from '../context.js'
import { isUniqueViolation, transaction } from '../db/sqlite.js'
import { AppError, badRequest, conflict, notFound } from '../errors.js'
import { newId } from '../security/tokens.js'
import { currentPaidUntil } from './access.js'
import { recordAudit } from './audit.js'
import type { DeviceRow } from './devices.js'
import { getSetting } from './settings.js'

interface PlanRow {
  code: PlanCode
  name: string
  description: string
  price_cents: number
  currency: string
  billing: 'monthly' | 'one_time'
  duration_months: number | null
}

export interface PaymentRequestRow {
  id: string
  device_id: string
  plan_code: PlanCode
  amount_cents: number
  currency: string
  transaction_id: string
  contact_email: string | null
  note: string | null
  status: PaymentRequestStatus
  version: number
  created_at: string
  decided_at: string | null
}

export function listPlans(ctx: AppContext): PlanDto[] {
  const rows = ctx.db.prepare('SELECT * FROM plans WHERE active = 1 ORDER BY sort_order').all() as unknown as PlanRow[]
  return rows.map((r) => ({ code: r.code, name: r.name, description: r.description, priceCents: r.price_cents, currency: r.currency, billing: r.billing }))
}

function getPlan(ctx: AppContext, code: string): PlanRow | undefined {
  return ctx.db.prepare('SELECT * FROM plans WHERE code = ? AND active = 1').get(code) as PlanRow | undefined
}

export function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100)
}

function toDto(ctx: AppContext, r: PaymentRequestRow): PaymentRequestDto {
  const decision = ctx.db.prepare('SELECT reason FROM admin_decisions WHERE request_id = ?').get(r.id) as { reason: string | null } | undefined
  const activation = ctx.db.prepare('SELECT id FROM subscriptions WHERE request_id = ?').get(r.id) as { id: string } | undefined
  return {
    id: r.id,
    planCode: r.plan_code,
    amountCents: r.amount_cents,
    currency: r.currency,
    transactionId: r.transaction_id,
    status: r.status,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
    cancellationReason: r.status === 'cancelled' ? (decision?.reason ?? null) : null,
    activationId: activation?.id ?? null
  }
}

export function listDeviceRequests(ctx: AppContext, deviceId: string): PaymentRequestDto[] {
  const rows = ctx.db.prepare('SELECT * FROM payment_requests WHERE device_id = ? ORDER BY created_at DESC LIMIT 100').all(deviceId) as unknown as PaymentRequestRow[]
  return rows.map((r) => toDto(ctx, r))
}

export interface CreatePaymentInput {
  planCode: string
  transactionId: string
  contactEmail?: string
  note?: string
}

export interface UploadedScreenshot {
  bytes: Buffer
  originalName: string | null
  truncated: boolean
}

/**
 * Validates and stores a manual payment submission. The amount always comes from the
 * plans table (never from the client) and the request starts as "pending": no access
 * is granted until an administrator confirms the payment.
 */
export async function createPaymentRequest(
  ctx: AppContext,
  device: DeviceRow,
  input: CreatePaymentInput,
  screenshot: UploadedScreenshot | null,
  ip: string | null
): Promise<PaymentRequestDto> {
  const fields: Record<string, string> = {}
  const plan = (PLAN_CODES as readonly string[]).includes(input.planCode) ? getPlan(ctx, input.planCode) : undefined
  if (!plan) fields.planCode = 'Select a valid plan'

  const transactionId = normalizeTransactionId(input.transactionId ?? '')
  if (!isValidTransactionId(transactionId)) fields.transactionId = 'Transaction ID must be 6–64 letters, digits or - _ . / #'

  const contactEmail = input.contactEmail?.trim() || null
  if (contactEmail && !isValidEmail(contactEmail)) fields.contactEmail = 'Enter a valid email address or leave it blank'

  const note = input.note?.trim() || null
  if (note && note.length > 500) fields.note = 'Note must be 500 characters or fewer'

  let mime: string | null = null
  if (!screenshot || screenshot.bytes.length === 0) fields.screenshot = 'Attach a screenshot of the payment'
  else if (screenshot.truncated || screenshot.bytes.length > SCREENSHOT_MAX_BYTES) fields.screenshot = 'Screenshot must be 5 MB or smaller'
  else {
    mime = sniffImageMime(screenshot.bytes)
    if (!mime) fields.screenshot = 'Screenshot must be a PNG, JPEG or WebP image'
  }

  if (Object.keys(fields).length > 0) throw badRequest('Please correct the highlighted fields', fields)
  if (!getSetting(ctx.db, 'payment_instructions')) {
    throw new AppError(503, 'payments_not_configured', 'Payment instructions have not been configured yet. Please try again later.')
  }

  const now = ctx.clock.now()
  const paid = currentPaidUntil(ctx.db, device.id, now)
  if (paid.lifetime) throw conflict('lifetime_active', 'This device already has an active Lifetime plan.')

  const sha256 = createHash('sha256').update(screenshot!.bytes).digest('hex')
  const storageKey = await ctx.evidence.save(screenshot!.bytes)
  const id = newId()
  const iso = now.toISOString()

  try {
    transaction(ctx.db, () => {
      ctx.db.prepare(
        `INSERT INTO payment_requests (id, device_id, plan_code, amount_cents, currency, transaction_id, contact_email, note, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
      ).run(id, device.id, plan!.code, plan!.price_cents, plan!.currency, transactionId, contactEmail, note, iso)
      ctx.db.prepare(
        `INSERT INTO payment_evidence (id, request_id, storage_key, mime_type, size_bytes, sha256, original_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(newId(), id, storageKey, mime, screenshot!.bytes.length, sha256, screenshot!.originalName?.slice(0, 200) ?? null, iso)
      recordAudit(ctx.db, now, {
        actorType: 'device', actorId: device.id, action: 'payment_request.created', entityType: 'payment_request', entityId: id,
        details: { planCode: plan!.code, amountCents: plan!.price_cents, transactionId }, ip
      })
    })
  } catch (err) {
    await ctx.evidence.remove(storageKey)
    if (isUniqueViolation(err, 'payment_requests.transaction_id')) {
      throw conflict('duplicate_transaction', 'This transaction ID has already been submitted. Each payment can be used for one request.')
    }
    if (isUniqueViolation(err, 'payment_requests.device_id')) {
      throw conflict('request_pending', 'You already have a pending payment request. Wait for it to be reviewed before submitting another.')
    }
    throw err
  }

  const row = ctx.db.prepare('SELECT * FROM payment_requests WHERE id = ?').get(id) as unknown as PaymentRequestRow
  const amount = formatMoney(plan!.price_cents, plan!.currency)
  const link = `${ctx.config.publicBaseUrl}/admin/requests/${id}`
  void ctx.notifier.email({
    kind: 'admin_new_request',
    to: getSetting(ctx.db, 'admin_notify_email'),
    subject: `[TradePilot] New ${plan!.name} payment request — ${amount} — ${device.reference_code}`,
    body: [
      'A new payment request is waiting for review.',
      '',
      `Request ID:      ${id}`,
      `Plan:            ${plan!.name}`,
      `Amount:          ${amount}`,
      `Transaction ID:  ${transactionId}`,
      `Device ref:      ${device.reference_code}`,
      `Submitted:       ${iso}`,
      '',
      `Review it here (administrator sign-in required): ${link}`,
      '',
      'Do not approve until you have confirmed the funds were received.'
    ].join('\n'),
    requestId: id,
    deviceId: device.id
  })
  return toDto(ctx, row)
}

export function addMonthsUtc(date: Date, months: number): Date {
  const d = new Date(date.getTime())
  const day = d.getUTCDate()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() + months)
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(day, lastDay))
  return d
}

export interface AdminActor {
  id: string
  email: string
  ip: string | null
}

export interface DecisionResult {
  request: PaymentRequestRow
  /** True when the same decision had already been recorded (idempotent replay). */
  alreadyProcessed: boolean
  subscriptionId: string | null
}

function loadRequest(ctx: AppContext, id: string): PaymentRequestRow {
  const row = ctx.db.prepare('SELECT * FROM payment_requests WHERE id = ?').get(id) as PaymentRequestRow | undefined
  if (!row) throw notFound('Payment request not found')
  return row
}

/**
 * Confirms a payment and activates the plan exactly once. Safe to call repeatedly:
 * a replayed approval returns the existing activation; approving a cancelled
 * request, or a request that changed since the admin loaded it, is rejected.
 */
export function approveRequest(ctx: AppContext, admin: AdminActor, requestId: string, expectedVersion?: number): DecisionResult {
  const result = transaction(ctx.db, () => {
    const req = loadRequest(ctx, requestId)
    if (req.status === 'approved') {
      const sub = ctx.db.prepare('SELECT id FROM subscriptions WHERE request_id = ?').get(req.id) as { id: string }
      return { request: req, alreadyProcessed: true, subscriptionId: sub.id }
    }
    if (req.status === 'cancelled') throw conflict('already_cancelled', 'This request was already cancelled and cannot be approved.')
    if (expectedVersion !== undefined && expectedVersion !== req.version) {
      throw conflict('stale_request', 'This request changed after you opened it. Reload and review it again.')
    }

    const now = ctx.clock.now()
    const iso = now.toISOString()
    const updated = ctx.db.prepare(
      `UPDATE payment_requests SET status = 'approved', decided_at = ?, version = version + 1 WHERE id = ? AND status = 'pending' AND version = ?`
    ).run(iso, req.id, req.version)
    if (updated.changes !== 1) throw conflict('stale_request', 'This request was processed by someone else. Reload to see the outcome.')

    ctx.db.prepare(`INSERT INTO admin_decisions (id, request_id, admin_id, decision, reason, created_at) VALUES (?, ?, ?, 'approved', NULL, ?)`)
      .run(newId(), req.id, admin.id, iso)

    const plan = ctx.db.prepare('SELECT * FROM plans WHERE code = ?').get(req.plan_code) as unknown as PlanRow
    const paid = currentPaidUntil(ctx.db, req.device_id, now)
    const startsAt = paid.until && paid.until > now ? paid.until : now
    const expiresAt = plan.duration_months ? addMonthsUtc(startsAt, plan.duration_months).toISOString() : null
    const subscriptionId = newId()
    ctx.db.prepare(
      `INSERT INTO subscriptions (id, device_id, plan_code, request_id, starts_at, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(subscriptionId, req.device_id, req.plan_code, req.id, startsAt.toISOString(), expiresAt, iso)

    recordAudit(ctx.db, now, { actorType: 'admin', actorId: admin.id, action: 'payment_request.approved', entityType: 'payment_request', entityId: req.id, ip: admin.ip })
    recordAudit(ctx.db, now, {
      actorType: 'admin', actorId: admin.id, action: 'subscription.activated', entityType: 'device', entityId: req.device_id,
      details: { subscriptionId, requestId: req.id, planCode: req.plan_code, startsAt: startsAt.toISOString(), expiresAt }, ip: admin.ip
    })

    const body = expiresAt
      ? `Your ${plan.name} plan is active until ${expiresAt.slice(0, 10)} (UTC).`
      : `Your ${plan.name} plan is now active.`
    ctx.notifier.storeInApp({ kind: 'payment_approved', deviceId: req.device_id, requestId: req.id, subject: 'Payment confirmed', body })
    return { request: loadRequest(ctx, req.id), alreadyProcessed: false, subscriptionId, body, planName: plan.name }
  })

  if (!result.alreadyProcessed && 'body' in result) {
    void ctx.notifier.email({
      kind: 'user_payment_approved',
      to: result.request.contact_email,
      subject: 'TradePilot — payment confirmed',
      body: `Thank you. We confirmed your payment (transaction ${result.request.transaction_id}).\n\n${result.body}\n\nRequest ID: ${result.request.id}`,
      requestId: result.request.id,
      deviceId: result.request.device_id
    })
  }
  return { request: result.request, alreadyProcessed: result.alreadyProcessed, subscriptionId: result.subscriptionId }
}

export function cancelRequest(ctx: AppContext, admin: AdminActor, requestId: string, reason: string, expectedVersion?: number): DecisionResult {
  const trimmed = reason.trim()
  if (trimmed.length < 3 || trimmed.length > 500) throw badRequest('Enter a cancellation reason (3–500 characters)', { reason: 'Required' })

  const result = transaction(ctx.db, () => {
    const req = loadRequest(ctx, requestId)
    if (req.status === 'cancelled') return { request: req, alreadyProcessed: true, subscriptionId: null }
    if (req.status === 'approved') throw conflict('already_approved', 'This request was already approved. It cannot be cancelled here.')
    if (expectedVersion !== undefined && expectedVersion !== req.version) {
      throw conflict('stale_request', 'This request changed after you opened it. Reload and review it again.')
    }
    const now = ctx.clock.now()
    const iso = now.toISOString()
    const updated = ctx.db.prepare(
      `UPDATE payment_requests SET status = 'cancelled', decided_at = ?, version = version + 1 WHERE id = ? AND status = 'pending' AND version = ?`
    ).run(iso, req.id, req.version)
    if (updated.changes !== 1) throw conflict('stale_request', 'This request was processed by someone else. Reload to see the outcome.')
    ctx.db.prepare(`INSERT INTO admin_decisions (id, request_id, admin_id, decision, reason, created_at) VALUES (?, ?, ?, 'cancelled', ?, ?)`)
      .run(newId(), req.id, admin.id, trimmed, iso)
    recordAudit(ctx.db, now, {
      actorType: 'admin', actorId: admin.id, action: 'payment_request.cancelled', entityType: 'payment_request', entityId: req.id,
      details: { reason: trimmed }, ip: admin.ip
    })
    ctx.notifier.storeInApp({
      kind: 'payment_cancelled', deviceId: req.device_id, requestId: req.id, subject: 'Payment request cancelled',
      body: `Your payment request was cancelled: ${trimmed}. You can submit a new request from the Subscription page.`
    })
    return { request: loadRequest(ctx, req.id), alreadyProcessed: false, subscriptionId: null }
  })

  if (!result.alreadyProcessed) {
    void ctx.notifier.email({
      kind: 'user_payment_cancelled',
      to: result.request.contact_email,
      subject: 'TradePilot — payment request cancelled',
      body: `Your payment request ${result.request.id} (transaction ${result.request.transaction_id}) was cancelled.\n\nReason: ${trimmed}\n\nNo charge was activated. You can submit a new request from the Subscription page in the app.`,
      requestId: result.request.id,
      deviceId: result.request.device_id
    })
  }
  return result
}

export interface AdminRequestListItem extends PaymentRequestRow {
  reference_code: string
  plan_name: string
}

export function listRequestsForAdmin(ctx: AppContext, status: PaymentRequestStatus | 'all', limit = 50, offset = 0): { items: AdminRequestListItem[]; total: number } {
  const where = status === 'all' ? '' : 'WHERE r.status = ?'
  const args = status === 'all' ? [] : [status]
  const items = ctx.db.prepare(
    `SELECT r.*, d.reference_code, p.name AS plan_name FROM payment_requests r
     JOIN devices d ON d.id = r.device_id JOIN plans p ON p.code = r.plan_code
     ${where} ORDER BY r.created_at ${status === 'pending' ? 'ASC' : 'DESC'} LIMIT ? OFFSET ?`
  ).all(...args, limit, offset) as unknown as AdminRequestListItem[]
  const total = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM payment_requests r ${where}`).get(...args) as { n: number }).n
  return { items, total }
}

export function countByStatus(ctx: AppContext): Record<PaymentRequestStatus, number> {
  const rows = ctx.db.prepare('SELECT status, COUNT(*) AS n FROM payment_requests GROUP BY status').all() as { status: PaymentRequestStatus; n: number }[]
  const out = { pending: 0, approved: 0, cancelled: 0 }
  for (const r of rows) out[r.status] = r.n
  return out
}

export interface EvidenceRow {
  id: string
  storage_key: string
  mime_type: string
  size_bytes: number
  sha256: string
  original_name: string | null
}

export function getRequestDetail(ctx: AppContext, id: string) {
  const request = ctx.db.prepare(
    `SELECT r.*, d.reference_code, p.name AS plan_name FROM payment_requests r
     JOIN devices d ON d.id = r.device_id JOIN plans p ON p.code = r.plan_code WHERE r.id = ?`
  ).get(id) as AdminRequestListItem | undefined
  if (!request) return null
  const evidence = ctx.db.prepare('SELECT * FROM payment_evidence WHERE request_id = ?').get(id) as EvidenceRow | undefined
  const duplicateEvidence = evidence
    ? (ctx.db.prepare('SELECT request_id FROM payment_evidence WHERE sha256 = ? AND request_id != ?').all(evidence.sha256, id) as { request_id: string }[]).map((r) => r.request_id)
    : []
  const decision = ctx.db.prepare(
    `SELECT dec.*, a.email AS admin_email FROM admin_decisions dec JOIN admins a ON a.id = dec.admin_id WHERE dec.request_id = ?`
  ).get(id) as { decision: string; reason: string | null; created_at: string; admin_email: string } | undefined
  const subscription = ctx.db.prepare('SELECT * FROM subscriptions WHERE request_id = ?').get(id) as
    | { id: string; starts_at: string; expires_at: string | null }
    | undefined
  const notifications = ctx.db.prepare(
    `SELECT channel, kind, recipient, subject, status, error, created_at, sent_at FROM notifications WHERE request_id = ? ORDER BY created_at`
  ).all(id) as { channel: string; kind: string; recipient: string; subject: string; status: string; error: string | null; created_at: string; sent_at: string | null }[]
  const otherRequests = ctx.db.prepare(
    `SELECT id, plan_code, status, created_at, transaction_id FROM payment_requests WHERE device_id = ? AND id != ? ORDER BY created_at DESC LIMIT 20`
  ).all(request.device_id, id) as { id: string; plan_code: string; status: string; created_at: string; transaction_id: string }[]
  return { request, evidence, duplicateEvidence, decision, subscription, notifications, otherRequests }
}
