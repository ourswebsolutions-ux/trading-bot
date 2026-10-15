import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AppContext } from '../context.js'
import { AppError } from '../errors.js'
import { randomToken } from '../security/tokens.js'
import { recordAudit } from '../services/audit.js'
import { getSetting } from '../services/settings.js'
import { verifyPassword } from '@tradepilot/shared/passwords'
import { approveRequest, cancelRequest, getRequestDetail } from '../services/payments.js'
import { claimReviewToken, resolveReviewToken, type TokenProblem } from '../services/reviewLinks.js'
import { PAGE_CSS, REVIEW_EXTRA_CSS } from './pageCss.js'
import { messagePage, resultPage, reviewPage } from './reviewViews.js'

const PROBLEM_TEXT: Record<TokenProblem, [string, string]> = {
  invalid: ['Link not valid', 'This review link is not valid. Use the latest email for this request.'],
  expired: ['Link expired', 'This review link has expired. Ask for new links with "npm run review:resend -- <request id>" on the server.'],
  used: ['Link already used', 'This request has already been decided through its email links. Nothing was changed.'],
  revoked: ['Link replaced', 'Newer links were issued for this request. Use the most recent email.']
}

/** Wrong review passphrases (from any address) within this window lock all decisions. */
const PASSPHRASE_MAX_FAILURES = 10
const PASSPHRASE_LOCK_MS = 15 * 60_000

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * Email approval with no administrator accounts or dashboard. The client's app emails the links
 * to the business address, so the client also holds them: a decision therefore requires the
 * business's review passphrase (only its scrypt hash is on the server). Each link carries a
 * 256-bit random token (only its hash is stored), works once and expires. GET never changes
 * anything (mail scanners prefetch links); the decision is an explicit POST protected by a CSRF
 * token bound to the page, an origin check, per-IP rate limits and a global lockout after
 * repeated wrong passphrases.
 */
export async function registerReviewRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const secure = ctx.config.cookieSecure
  const CSRF_COOKIE = secure ? '__Host-tp_review' : 'tp_review'
  const cookieOpts = { path: '/', httpOnly: true, secure, sameSite: 'strict' as const, maxAge: 3600 }
  const expectedOrigin = new URL(ctx.config.publicBaseUrl).origin

  const sendPage = (reply: FastifyReply, status: number, body: string) => reply.status(status).type('text/html').send(body)
  const problemPage = (reply: FastifyReply, problem: TokenProblem, status = 410) => sendPage(reply, problem === 'invalid' ? 404 : status, messagePage(...PROBLEM_TEXT[problem], problem === 'used' ? 'warn' : 'bad'))

  const load = (token: string) => {
    const resolved = resolveReviewToken(ctx, token)
    if ('problem' in resolved) return resolved
    const detail = getRequestDetail(ctx, resolved.row.request_id)
    if (!detail) return { problem: 'invalid' as const }
    return { row: resolved.row, detail }
  }

  app.get('/review/assets/review.css', async (_req, reply) => reply.type('text/css').header('Cache-Control', 'public, max-age=3600').send(PAGE_CSS + REVIEW_EXTRA_CSS))

  app.get('/review/:token', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { token } = request.params as { token: string }
    const found = load(token)
    if ('problem' in found) return problemPage(reply, found.problem)
    if (found.detail.request.status !== 'pending') return sendPage(reply, 410, messagePage(...PROBLEM_TEXT.used, 'warn'))
    const csrf = randomToken(18)
    reply.setCookie(CSRF_COOKIE, csrf, cookieOpts)
    recordAudit(ctx.db, ctx.clock.now(), { actorType: 'system', action: 'review_link.opened', entityType: 'payment_request', entityId: found.row.request_id, details: { action: found.row.action }, ip: request.ip })
    return sendPage(reply, 200, reviewPage(found.detail, { action: found.row.action, csrf, token, expiresAt: found.row.expires_at, passphraseConfigured: Boolean(ctx.config.reviewPassphraseHash) }))
  })

  app.get('/review/:token/evidence', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { token } = request.params as { token: string }
    const found = load(token)
    if ('problem' in found || !found.detail.evidence) return reply.status(404).send({ error: { code: 'not_found', message: 'Not found' } })
    const bytes = await ctx.evidence.read(found.detail.evidence.storage_key)
    return reply
      .header('Content-Type', found.detail.evidence.mime_type)
      .header('Content-Disposition', 'inline; filename="payment-evidence"')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cache-Control', 'private, no-store')
      .send(bytes)
  })

  app.post('/review/:token', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request: FastifyRequest, reply) => {
    const { token } = request.params as { token: string }
    const origin = request.headers.origin
    if (origin && origin !== 'null' && origin !== expectedOrigin) throw new AppError(403, 'bad_origin', 'Cross-origin request rejected')
    const found = load(token)
    if ('problem' in found) return problemPage(reply, found.problem)
    const { row, detail } = found
    const body = (request.body ?? {}) as Record<string, unknown>
    const reason = typeof body.reason === 'string' ? body.reason : ''
    const freshCsrf = randomToken(18)
    reply.setCookie(CSRF_COOKIE, freshCsrf, cookieOpts)
    const again = (status: number, error: string) =>
      sendPage(reply, status, reviewPage(detail, { action: row.action, csrf: freshCsrf, token, expiresAt: row.expires_at, error, reason, passphraseConfigured: Boolean(ctx.config.reviewPassphraseHash) }))

    const cookie = request.cookies[CSRF_COOKIE]
    if (typeof body._csrf !== 'string' || !cookie || !safeEqual(body._csrf, cookie)) return again(403, 'This form expired. Please submit it again.')
    if (row.action === 'confirm' && body.verified !== 'yes') return again(400, 'Tick the box confirming that the payment arrived.')
    if (row.action === 'cancel' && reason.trim().length < 3) return again(400, 'Enter a reason for the client (at least 3 characters).')

    if (!ctx.config.reviewPassphraseHash) return again(503, 'Payment confirmation is not set up on this server (REVIEW_PASSPHRASE_HASH).')
    const since = new Date(ctx.clock.now().getTime() - PASSPHRASE_LOCK_MS).toISOString()
    const recentFailures = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'review_passphrase.failed' AND occurred_at > ?`).get(since) as { n: number }).n
    if (recentFailures >= PASSPHRASE_MAX_FAILURES) return again(429, 'Too many wrong passphrases. Decisions are locked for 15 minutes.')
    const passphrase = typeof body.passphrase === 'string' ? body.passphrase : ''
    if (!passphrase || passphrase.length > 1024 || !(await verifyPassword(passphrase, ctx.config.reviewPassphraseHash))) {
      recordAudit(ctx.db, ctx.clock.now(), { actorType: 'system', action: 'review_passphrase.failed', entityType: 'payment_request', entityId: row.request_id, details: { action: row.action }, ip: request.ip })
      return again(401, 'Incorrect review passphrase. Nothing was changed.')
    }
    const actor = { label: `email:${getSetting(ctx.db, 'admin_notify_email') ?? 'review-link'}`, ip: request.ip }

    // Single use: whoever claims the link first acts; any concurrent or later submission is refused.
    if (!claimReviewToken(ctx, row.id)) return problemPage(reply, 'used')
    try {
      if (row.action === 'confirm') {
        const result = approveRequest(ctx, actor, row.request_id)
        const fresh = getRequestDetail(ctx, row.request_id)!
        const sub = fresh.subscription
        return sendPage(reply, 200, resultPage(fresh, result.alreadyProcessed ? 'already_approved' : 'approved',
          result.alreadyProcessed ? 'This payment had already been confirmed. No second activation was created.' : `The ${fresh.request.plan_name} plan is active${sub?.expires_at ? ` until ${sub.expires_at.slice(0, 10)}` : ''}. The client has been notified.`))
      }
      const result = cancelRequest(ctx, actor, row.request_id, reason)
      const fresh = getRequestDetail(ctx, row.request_id)!
      return sendPage(reply, 200, resultPage(fresh, result.alreadyProcessed ? 'already_cancelled' : 'cancelled', result.alreadyProcessed ? 'This request had already been cancelled.' : 'The request was cancelled and no access was granted. The client has been notified and can submit a new request.'))
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 409) return sendPage(reply, 409, messagePage('Action not applied', err.message, 'warn'))
      throw err
    }
  })
}
