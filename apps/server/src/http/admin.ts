import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { isValidEmail, type PaymentRequestStatus } from '@tradepilot/shared'
import type { AppContext } from '../context.js'
import { AppError } from '../errors.js'
import { randomToken } from '../security/tokens.js'
import { getSubscription, getTrial } from '../services/access.js'
import { getAdminSession, loginAdmin, logoutAdmin, SESSION_ABSOLUTE_MS, type AdminRole, type AdminSession } from '../services/admins.js'
import { listAudit, recordAudit } from '../services/audit.js'
import { approveRequest, cancelRequest, countByStatus, getRequestDetail, listRequestsForAdmin } from '../services/payments.js'
import { getSetting, setSetting } from '../services/settings.js'
import { ADMIN_CSS } from './adminCss.js'
import { auditPage, loginPage, messagePage, requestDetailPage, requestsPage, settingsPage } from './adminViews.js'

declare module 'fastify' {
  interface FastifyRequest {
    adminSession?: AdminSession
  }
}

const NOTICES: Record<string, { tone: 'ok' | 'bad' | 'warn'; text: string }> = {
  approved: { tone: 'ok', text: 'Payment confirmed. The plan is now active and the user has been notified.' },
  already_approved: { tone: 'warn', text: 'This request had already been approved. No second activation was created.' },
  cancelled: { tone: 'ok', text: 'Request cancelled. The user has been notified and no access was granted.' },
  already_cancelled: { tone: 'warn', text: 'This request had already been cancelled.' },
  saved: { tone: 'ok', text: 'Settings saved.' }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const STATUSES = ['pending', 'approved', 'cancelled', 'all'] as const

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

function safeNext(next: unknown): string {
  return typeof next === 'string' && /^\/admin(\/[A-Za-z0-9/_?=&.-]*)?$/.test(next) && !next.startsWith('//') ? next : '/admin'
}

export async function registerAdminRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const secure = ctx.config.cookieSecure
  const SESSION_COOKIE = secure ? '__Host-tp_admin' : 'tp_admin'
  const LOGIN_CSRF_COOKIE = secure ? '__Host-tp_login' : 'tp_login'
  const cookieOpts = { path: '/', httpOnly: true, secure, sameSite: 'strict' as const }
  const expectedOrigin = new URL(ctx.config.publicBaseUrl).origin

  /** Rejects cross-site form posts even if a CSRF token leaked (defense in depth). */
  const checkOrigin = (request: FastifyRequest) => {
    const origin = request.headers.origin
    if (origin && origin !== 'null' && origin !== expectedOrigin) throw new AppError(403, 'bad_origin', 'Cross-origin request rejected')
  }

  const requireAdmin = (role?: AdminRole) => async (request: FastifyRequest, reply: FastifyReply) => {
    const session = getAdminSession(ctx, request.cookies[SESSION_COOKIE])
    if (!session) {
      if (request.method === 'GET') return reply.redirect(`/admin/login?next=${encodeURIComponent(safeNext(request.url))}`)
      return reply.status(401).type('text/html').send(messagePage(null, 'Session expired', 'Your session has expired. Sign in again.'))
    }
    if (role && session.admin.role !== role) {
      return reply.status(403).type('text/html').send(messagePage(session, 'Not allowed', 'Your role does not have access to this page.'))
    }
    if (request.method === 'POST') {
      checkOrigin(request)
      const token = (request.body as Record<string, unknown> | undefined)?._csrf
      if (typeof token !== 'string' || !safeEqual(token, session.csrfToken)) {
        return reply.status(403).type('text/html').send(messagePage(session, 'Request blocked', 'The form token was missing or invalid. Reload the page and try again.'))
      }
    }
    request.adminSession = session
  }

  const actor = (request: FastifyRequest) => ({ id: request.adminSession!.admin.id, email: request.adminSession!.admin.email, ip: request.ip })

  app.get('/admin/assets/admin.css', async (_request, reply) => reply.type('text/css').header('Cache-Control', 'public, max-age=3600').send(ADMIN_CSS))

  app.get('/admin/login', async (request, reply) => {
    if (getAdminSession(ctx, request.cookies[SESSION_COOKIE])) return reply.redirect('/admin')
    const csrf = randomToken(18)
    reply.setCookie(LOGIN_CSRF_COOKIE, csrf, { ...cookieOpts, maxAge: 1800 })
    return reply.type('text/html').send(loginPage(csrf, null, safeNext((request.query as Record<string, unknown>).next)))
  })

  app.post('/admin/login', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => {
    checkOrigin(request)
    const body = (request.body ?? {}) as Record<string, unknown>
    const next = safeNext(body.next)
    const cookieToken = request.cookies[LOGIN_CSRF_COOKIE]
    const freshCsrf = randomToken(18)
    reply.setCookie(LOGIN_CSRF_COOKIE, freshCsrf, { ...cookieOpts, maxAge: 1800 })
    if (typeof body._csrf !== 'string' || !cookieToken || !safeEqual(body._csrf, cookieToken)) {
      return reply.status(403).type('text/html').send(loginPage(freshCsrf, 'Your sign-in form expired. Please try again.', next))
    }
    const email = typeof body.email === 'string' ? body.email : ''
    const password = typeof body.password === 'string' ? body.password : ''
    if (!email || !password || password.length > 1024) {
      return reply.status(400).type('text/html').send(loginPage(freshCsrf, 'Enter your email and password.', next))
    }
    const result = await loginAdmin(ctx, email, password, { ip: request.ip, userAgent: request.headers['user-agent'] ?? null })
    if (!result.ok) {
      const message = result.reason === 'locked'
        ? 'Too many failed attempts. This account is temporarily locked; try again in 15 minutes.'
        : 'Incorrect email or password.'
      return reply.status(401).type('text/html').send(loginPage(freshCsrf, message, next))
    }
    reply.clearCookie(LOGIN_CSRF_COOKIE, { path: '/' })
    reply.setCookie(SESSION_COOKIE, result.sessionToken, { ...cookieOpts, maxAge: SESSION_ABSOLUTE_MS / 1000 })
    return reply.redirect(next, 303)
  })

  app.post('/admin/logout', { preHandler: requireAdmin() }, async (request, reply) => {
    logoutAdmin(ctx, request.cookies[SESSION_COOKIE], request.ip)
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return reply.redirect('/admin/login', 303)
  })

  app.get('/admin', { preHandler: requireAdmin() }, async (request, reply) => {
    const q = request.query as Record<string, string | undefined>
    const status = (STATUSES as readonly string[]).includes(q.status ?? '') ? (q.status as PaymentRequestStatus | 'all') : 'pending'
    const page = Math.max(1, Math.min(10_000, Number.parseInt(q.page ?? '1', 10) || 1))
    const pageSize = 50
    const data = listRequestsForAdmin(ctx, status, pageSize, (page - 1) * pageSize)
    return reply.type('text/html').send(requestsPage(request.adminSession!, status, data, countByStatus(ctx), page, pageSize, NOTICES[q.notice ?? ''] ?? null))
  })

  app.get('/admin/requests/:id', { preHandler: requireAdmin() }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const detail = UUID.test(id) ? getRequestDetail(ctx, id) : null
    if (!detail) return reply.status(404).type('text/html').send(messagePage(request.adminSession!, 'Not found', 'That payment request does not exist.'))
    const now = ctx.clock.now()
    const trial = getTrial(ctx.db, detail.request.device_id, now)
    const sub = getSubscription(ctx.db, detail.request.device_id, now)
    const currentSub = sub
      ? `${sub.planCode} · ${sub.status}${sub.expiresAt ? ` · until ${sub.expiresAt.slice(0, 10)}` : ''}`
      : 'no paid subscription'
    const notice = NOTICES[(request.query as Record<string, string>).notice ?? ''] ?? null
    return reply.type('text/html').send(requestDetailPage(request.adminSession!, detail, trial, currentSub, notice))
  })

  app.get('/admin/requests/:id/evidence', { preHandler: requireAdmin() }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const detail = UUID.test(id) ? getRequestDetail(ctx, id) : null
    if (!detail?.evidence) return reply.status(404).send({ error: { code: 'not_found', message: 'Not found' } })
    const bytes = await ctx.evidence.read(detail.evidence.storage_key)
    recordAudit(ctx.db, ctx.clock.now(), { actorType: 'admin', actorId: request.adminSession!.admin.id, action: 'evidence.viewed', entityType: 'payment_request', entityId: id, ip: request.ip })
    return reply
      .header('Content-Type', detail.evidence.mime_type)
      .header('Content-Disposition', 'inline; filename="payment-evidence"')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cache-Control', 'private, no-store')
      .send(bytes)
  })

  const decide = (kind: 'approve' | 'cancel') => async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string }
    if (!UUID.test(id)) return reply.status(404).type('text/html').send(messagePage(request.adminSession!, 'Not found', 'That payment request does not exist.'))
    const body = request.body as Record<string, unknown>
    const version = Number.parseInt(String(body.version ?? ''), 10)
    try {
      if (kind === 'approve') {
        if (body.verified !== 'yes') {
          return reply.status(400).type('text/html').send(messagePage(request.adminSession!, 'Confirmation required', 'Tick the box confirming you verified the payment before approving.', 'warn'))
        }
        const result = approveRequest(ctx, actor(request), id, Number.isFinite(version) ? version : undefined)
        return reply.redirect(`/admin/requests/${id}?notice=${result.alreadyProcessed ? 'already_approved' : 'approved'}`, 303)
      }
      const result = cancelRequest(ctx, actor(request), id, String(body.reason ?? ''), Number.isFinite(version) ? version : undefined)
      return reply.redirect(`/admin/requests/${id}?notice=${result.alreadyProcessed ? 'already_cancelled' : 'cancelled'}`, 303)
    } catch (err) {
      if (err instanceof AppError) {
        const title = err.statusCode === 409 ? 'Action not applied' : 'Could not complete action'
        return reply.status(err.statusCode).type('text/html').send(
          messagePage(request.adminSession!, title, `${err.message}`, err.statusCode === 409 ? 'warn' : 'bad')
        )
      }
      throw err
    }
  }

  app.post('/admin/requests/:id/approve', { preHandler: requireAdmin() }, decide('approve'))
  app.post('/admin/requests/:id/cancel', { preHandler: requireAdmin() }, decide('cancel'))

  const currentSettings = () => ({
    notifyEmail: getSetting(ctx.db, 'admin_notify_email') ?? '',
    paymentInstructions: getSetting(ctx.db, 'payment_instructions') ?? ''
  })
  const smtpInfo = () => ({ configured: ctx.notifier.mailer.configured, description: ctx.notifier.mailer.description })

  app.get('/admin/settings', { preHandler: requireAdmin('superadmin') }, async (request, reply) => {
    const notice = NOTICES[(request.query as Record<string, string>).notice ?? ''] ?? null
    return reply.type('text/html').send(settingsPage(request.adminSession!, currentSettings(), smtpInfo(), notice))
  })

  app.post('/admin/settings', { preHandler: requireAdmin('superadmin') }, async (request, reply) => {
    const body = request.body as Record<string, unknown>
    const notifyEmail = String(body.notifyEmail ?? '').trim()
    const paymentInstructions = String(body.paymentInstructions ?? '').replace(/\r\n/g, '\n').trim()
    const errors: Record<string, string> = {}
    if (!isValidEmail(notifyEmail)) errors.notifyEmail = 'Enter a valid email address.'
    if (paymentInstructions.length < 10 || paymentInstructions.length > 4000) errors.paymentInstructions = 'Instructions must be 10–4000 characters.'
    if (Object.keys(errors).length > 0) {
      return reply.status(400).type('text/html').send(settingsPage(request.adminSession!, { notifyEmail, paymentInstructions }, smtpInfo(), { tone: 'bad', text: 'Settings were not saved.' }, errors))
    }
    const now = ctx.clock.now()
    const admin = actor(request)
    setSetting(ctx.db, 'admin_notify_email', notifyEmail, now, admin.id)
    setSetting(ctx.db, 'payment_instructions', paymentInstructions, now, admin.id)
    recordAudit(ctx.db, now, { actorType: 'admin', actorId: admin.id, action: 'settings.updated', entityType: 'settings', entityId: 'server', details: { notifyEmail }, ip: admin.ip })
    return reply.redirect('/admin/settings?notice=saved', 303)
  })

  app.post('/admin/settings/test-email', { preHandler: requireAdmin('superadmin'), config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (request, reply) => {
    const to = String((request.body as Record<string, unknown>).to ?? '').trim()
    const session = request.adminSession!
    if (!isValidEmail(to)) {
      return reply.status(400).type('text/html').send(settingsPage(session, currentSettings(), smtpInfo(), { tone: 'bad', text: 'Enter a valid recipient address.' }))
    }
    const outcome = await ctx.notifier.email({
      kind: 'smtp_test',
      to,
      subject: 'TradePilot — SMTP test message',
      body: `This is a test message from the TradePilot subscription server (${ctx.config.publicBaseUrl}).\n\nIf you received it, payment notifications will be delivered.`
    })
    const last = ctx.db.prepare(`SELECT error FROM notifications WHERE kind = 'smtp_test' ORDER BY created_at DESC, rowid DESC LIMIT 1`).get() as { error: string | null } | undefined
    recordAudit(ctx.db, ctx.clock.now(), { actorType: 'admin', actorId: session.admin.id, action: 'smtp.test', details: { to, outcome }, ip: request.ip })
    const notice = outcome === 'sent'
      ? { tone: 'ok' as const, text: `Test email accepted by the SMTP server for delivery to ${to}.` }
      : { tone: 'bad' as const, text: `Test email was not sent: ${last?.error ?? outcome}` }
    return reply.type('text/html').send(settingsPage(session, currentSettings(), smtpInfo(), notice))
  })

  app.get('/admin/audit', { preHandler: requireAdmin('superadmin') }, async (request, reply) => {
    const page = Math.max(1, Number.parseInt((request.query as Record<string, string>).page ?? '1', 10) || 1)
    return reply.type('text/html').send(auditPage(request.adminSession!, listAudit(ctx.db, { limit: 100, offset: (page - 1) * 100 }), page))
  })
}
