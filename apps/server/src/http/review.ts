import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AppContext } from '../context.js'
import { AppError } from '../errors.js'
import { randomToken } from '../security/tokens.js'
import { authenticateAdmin, type AuthenticatedAdmin } from '../services/admins.js'
import { recordAudit } from '../services/audit.js'
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

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * Email-only approval. GET never changes anything (mail scanners prefetch links); the decision
 * is a POST from the confirmation page, protected by a CSRF token, an origin check, rate limits
 * and (by default) a one-off administrator sign-in. Links are single-use and expire.
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
    return sendPage(reply, 200, reviewPage(found.detail, { action: found.row.action, csrf, token, requireLogin: ctx.config.reviewRequireAdminLogin, expiresAt: found.row.expires_at }))
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
    const email = typeof body.email === 'string' ? body.email : ''
    const freshCsrf = randomToken(18)
    reply.setCookie(CSRF_COOKIE, freshCsrf, cookieOpts)
    const again = (status: number, error: string) =>
      sendPage(reply, status, reviewPage(detail, { action: row.action, csrf: freshCsrf, token, requireLogin: ctx.config.reviewRequireAdminLogin, expiresAt: row.expires_at, error, reason, email }))

    const cookie = request.cookies[CSRF_COOKIE]
    if (typeof body._csrf !== 'string' || !cookie || !safeEqual(body._csrf, cookie)) return again(403, 'This form expired. Please submit it again.')
    if (row.action === 'confirm' && body.verified !== 'yes') return again(400, 'Tick the box confirming that the payment arrived.')
    if (row.action === 'cancel' && reason.trim().length < 3) return again(400, 'Enter a reason for the client (at least 3 characters).')

    let actor: AuthenticatedAdmin | null = null
    if (ctx.config.reviewRequireAdminLogin) {
      const password = typeof body.password === 'string' ? body.password : ''
      if (!email || !password || password.length > 1024) return again(400, 'Enter your administrator email and password.')
      const auth = await authenticateAdmin(ctx, email, password, request.ip)
      if (!auth.ok) return again(401, auth.reason === 'locked' ? 'Too many failed attempts. This administrator account is locked for 15 minutes.' : 'Incorrect administrator email or password.')
      actor = auth.admin
    } else {
      const fallback = ctx.db.prepare(`SELECT id, email, role FROM admins WHERE disabled = 0 ORDER BY created_at LIMIT 1`).get() as AuthenticatedAdmin | undefined
      if (!fallback) return again(500, 'No administrator account exists to record this decision. Create one with npm run admin:create.')
      actor = fallback
    }

    // Single use: whoever claims the link first acts; any concurrent or later submission is refused.
    if (!claimReviewToken(ctx, row.id)) return problemPage(reply, 'used')
    try {
      if (row.action === 'confirm') {
        const result = approveRequest(ctx, { id: actor.id, email: actor.email, ip: request.ip }, row.request_id)
        const fresh = getRequestDetail(ctx, row.request_id)!
        const sub = fresh.subscription
        return sendPage(reply, 200, resultPage(fresh, result.alreadyProcessed ? 'already_approved' : 'approved',
          result.alreadyProcessed ? 'This payment had already been confirmed. No second activation was created.' : `The ${fresh.request.plan_name} plan is active${sub?.expires_at ? ` until ${sub.expires_at.slice(0, 10)}` : ''}. The client has been notified.`))
      }
      const result = cancelRequest(ctx, { id: actor.id, email: actor.email, ip: request.ip }, row.request_id, reason)
      const fresh = getRequestDetail(ctx, row.request_id)!
      return sendPage(reply, 200, resultPage(fresh, result.alreadyProcessed ? 'already_cancelled' : 'cancelled', result.alreadyProcessed ? 'This request had already been cancelled.' : 'The request was cancelled and no access was granted. The client has been notified and can submit a new request.'))
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 409) return sendPage(reply, 409, messagePage('Action not applied', err.message, 'warn'))
      throw err
    }
  })
}
