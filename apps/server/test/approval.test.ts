import assert from 'node:assert/strict'
import { after, afterEach, before, describe, it } from 'node:test'
import { TRIAL_DURATION_MS, type PaymentRequestDto, type StatusResponse } from '@tradepilot/shared'
import { approveRequest, cancelRequest } from '../src/services/payments.js'
import { BUSINESS_EMAIL, createHarness, emailedLinks, registerDevice, submitPayment, submitReview, T0, type Harness } from './helpers.js'

const statusOf = async (h: Harness, token: string) =>
  (await h.app.inject({ method: 'GET', url: '/v1/status', headers: { authorization: `Bearer ${token}` } })).json() as StatusResponse

describe('subscription approval through emailed links', () => {
  let h: Harness

  before(async () => {
    h = await createHarness()
  })
  after(async () => h.close())
  afterEach(() => h.clock.set(T0))

  const submit = async (planCode = 'monthly', contactEmail = 'user@example.test') => {
    const d = await registerDevice(h)
    const res = await submitPayment(h, d.deviceToken, { planCode, contactEmail })
    assert.equal(res.statusCode, 201, res.body)
    const request = (res.json() as { request: PaymentRequestDto }).request
    return { device: d, request, created: res.json(), links: await emailedLinks(h, request.id) }
  }

  it('returns two single-use review links to the app (which emails them); the server itself sends nothing', async () => {
    const before = h.mailer.sent.length
    const { request, created, device } = await submit()
    assert.equal(created.businessEmail, BUSINESS_EMAIL)
    assert.equal(created.referenceCode, device.referenceCode)
    assert.match(created.review.confirmUrl, /^https:\/\/admin\.example\.test\/review\/[A-Za-z0-9_-]{43}$/)
    assert.match(created.review.cancelUrl, /^https:\/\/admin\.example\.test\/review\/[A-Za-z0-9_-]{43}$/)
    assert.equal(Date.parse(created.review.expiresAt) - T0.getTime(), 72 * 3600_000)
    await h.ctx.notifier.idle()
    assert.equal(h.mailer.sent.length, before, 'no server-side email: no admin SMTP needed')
    const tokens = h.ctx.db.prepare('SELECT action, token_hash FROM review_tokens WHERE request_id = ?').all(request.id) as { action: string; token_hash: string }[]
    assert.deepEqual(tokens.map((t) => t.action).sort(), ['cancel', 'confirm'])
    const { confirm } = await emailedLinks(h, request.id)
    assert.ok(!tokens.some((t) => confirm.includes(t.token_hash)), 'only hashes are stored')
  })

  it('opening a link changes nothing (safe against mail scanners) and shows the screenshot', async () => {
    const { request, links } = await submit()
    const page = await h.app.inject({ method: 'GET', url: links.confirm })
    assert.equal(page.statusCode, 200)
    assert.ok(page.body.includes('Confirm Payment') && page.body.includes(request.transactionId))
    const img = await h.app.inject({ method: 'GET', url: `${links.confirm}/evidence` })
    assert.equal(img.headers['content-type'], 'image/png')
    assert.equal(h.ctx.db.prepare('SELECT status FROM payment_requests WHERE id = ?').get(request.id)!.status, 'pending')
  })

  it('Confirm Payment needs the review passphrase (no account), activates exactly once and notifies the client', async () => {
    assert.equal((h.ctx.db.prepare('SELECT COUNT(*) AS n FROM admins').get() as { n: number }).n, 0, 'no administrator accounts exist')
    const { device, request, links } = await submit()
    const page = await h.app.inject({ method: 'GET', url: links.confirm })
    assert.ok(page.body.includes('Review passphrase') && !/Administrator email/.test(page.body))
    // the client also holds the links (their app emailed them) but cannot approve without the passphrase
    const self = await submitReview(h, links.confirm, { verified: 'yes' }, { passphrase: 'i-sent-this-email-myself' })
    assert.equal(self.res.statusCode, 401)
    assert.match(self.res.body, /Incorrect review passphrase\. Nothing was changed/)
    const noPass = await submitReview(h, links.confirm, { verified: 'yes' }, { passphrase: '' })
    assert.equal(noPass.res.statusCode, 401)
    assert.equal((await statusOf(h, device.deviceToken)).subscription, null)
    assert.equal(h.ctx.db.prepare('SELECT status FROM payment_requests WHERE id = ?').get(request.id)!.status, 'pending')

    const ok = await submitReview(h, links.confirm, { verified: 'yes' })
    assert.equal(ok.res.statusCode, 200)
    assert.match(ok.res.body, /Payment confirmed/)
    const status = await statusOf(h, device.deviceToken)
    assert.equal(status.subscription?.planCode, 'monthly')
    assert.equal(status.subscription?.expiresAt, '2026-02-10T12:00:00.000Z')
    assert.equal(status.access.reason, 'subscription')
    const decision = h.ctx.db.prepare('SELECT decided_by, admin_id FROM admin_decisions WHERE request_id = ?').get(request.id) as { decided_by: string; admin_id: string | null }
    assert.deepEqual({ ...decision }, { decided_by: `email:${BUSINESS_EMAIL}`, admin_id: null })

    // second click on either link: link already used, nothing activated twice
    const again = await h.app.inject({ method: 'GET', url: links.confirm })
    assert.equal(again.statusCode, 410)
    assert.match(again.body, /already been decided/)
    const cancelAfter = await h.app.inject({ method: 'GET', url: links.cancel })
    assert.equal(cancelAfter.statusCode, 410)
    assert.equal(h.ctx.db.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE request_id = ?').get(request.id)!.n, 1)

    await h.ctx.notifier.idle()
    assert.ok(h.mailer.sent.some((m) => m.to === 'user@example.test' && m.subject.includes('confirmed')))
    const inApp = await h.app.inject({ method: 'GET', url: '/v1/notifications', headers: { authorization: `Bearer ${device.deviceToken}` } })
    assert.equal(inApp.json().notifications[0].kind, 'payment_approved')
  })

  it('a replayed POST after confirmation cannot activate twice', async () => {
    const { request, links } = await submit()
    const page = await h.app.inject({ method: 'GET', url: links.confirm, remoteAddress: '10.9.9.9' })
    const cookie = page.cookies.find((c) => c.name.endsWith('tp_review'))!
    const csrf = /name="_csrf" value="([^"]+)"/.exec(page.body)![1]!
    const post = () => h.app.inject({ method: 'POST', url: links.confirm, remoteAddress: '10.9.9.9', headers: { cookie: `${cookie.name}=${cookie.value}` }, payload: { _csrf: csrf, verified: 'yes', passphrase: 'correct horse battery staple' } })
    const [a, b] = await Promise.all([post(), post()])
    assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 410])
    assert.equal(h.ctx.db.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE request_id = ?').get(request.id)!.n, 1)
  })

  it('requires the "payment arrived" confirmation box and a valid CSRF token', async () => {
    const { request, links } = await submit()
    assert.equal((await submitReview(h, links.confirm, {})).res.statusCode, 400)
    assert.equal((await submitReview(h, links.confirm, { verified: 'yes' }, { skipCsrf: true })).res.statusCode, 403)
    assert.equal((await submitReview(h, links.confirm, { verified: 'yes' }, { origin: 'https://evil.example' })).res.statusCode, 403)
    assert.equal(h.ctx.db.prepare('SELECT status FROM payment_requests WHERE id = ?').get(request.id)!.status, 'pending')
  })

  it('Cancel Request records the reason, grants nothing, and the client can submit again', async () => {
    const { device, request, links } = await submit()
    assert.equal((await submitReview(h, links.cancel, { reason: ' ' })).res.statusCode, 400)
    const res = await submitReview(h, links.cancel, { reason: 'No matching payment received' })
    assert.equal(res.res.statusCode, 200)
    assert.match(res.res.body, /Request cancelled/)
    await h.ctx.notifier.idle()
    assert.ok(h.mailer.sent.some((m) => m.to === 'user@example.test' && /cancelled/.test(m.subject) && m.text.includes('No matching payment received')), 'client emailed')
    const inApp = await h.app.inject({ method: 'GET', url: '/v1/notifications', headers: { authorization: `Bearer ${device.deviceToken}` } })
    assert.equal(inApp.json().notifications[0].kind, 'payment_cancelled')
    assert.match(inApp.json().notifications[0].body, /No matching payment received/)
    const list = (await h.app.inject({ method: 'GET', url: '/v1/payment-requests', headers: { authorization: `Bearer ${device.deviceToken}` } })).json()
    assert.equal(list.requests[0].status, 'cancelled')
    assert.equal(list.requests[0].cancellationReason, 'No matching payment received')
    assert.equal((await statusOf(h, device.deviceToken)).subscription, null)
    assert.equal((await h.app.inject({ method: 'GET', url: links.confirm })).statusCode, 410, 'confirm link dies with the cancel')
    const retry = await submitPayment(h, device.deviceToken, { transactionId: request.transactionId })
    assert.equal(retry.statusCode, 201)
  })

  it('links expire, and re-issued links replace older ones', async () => {
    const { request, links } = await submit()
    h.clock.advance(72 * 3600_000 + 1)
    const expired = await h.app.inject({ method: 'GET', url: links.confirm })
    assert.equal(expired.statusCode, 410)
    assert.match(expired.body, /expired/)
    const { issueReviewLinks } = await import('../src/services/reviewLinks.js')
    const fresh = issueReviewLinks(h.ctx, request.id)
    assert.equal((await h.app.inject({ method: 'GET', url: new URL(fresh.confirmUrl).pathname })).statusCode, 200)
    const older = issueReviewLinks(h.ctx, request.id)
    assert.match((await h.app.inject({ method: 'GET', url: new URL(fresh.confirmUrl).pathname })).body, /Newer links/)
    assert.equal((await h.app.inject({ method: 'GET', url: new URL(older.cancelUrl).pathname })).statusCode, 200)
  })

  it('rejects unknown or malformed tokens', async () => {
    assert.equal((await h.app.inject({ method: 'GET', url: '/review/not-a-token' })).statusCode, 404)
    assert.equal((await h.app.inject({ method: 'GET', url: `/review/${'A'.repeat(43)}` })).statusCode, 404)
    assert.equal((await h.app.inject({ method: 'GET', url: `/review/${'A'.repeat(43)}/evidence` })).statusCode, 404)
  })

  it('activates lifetime with no expiry and blocks further purchases', async () => {
    const { device, links } = await submit('lifetime')
    await submitReview(h, links.confirm, { verified: 'yes' })
    const status = await statusOf(h, device.deviceToken)
    assert.deepEqual([status.subscription?.planCode, status.subscription?.expiresAt], ['lifetime', null])
    const again = await submitPayment(h, device.deviceToken, { planCode: 'monthly' })
    assert.equal(again.json().error.code, 'lifetime_active')
  })

  it('service-level decisions stay idempotent and conflict-free', async () => {
    const { request } = await submit()
    const actor = { label: 'test', ip: null }
    const r1 = approveRequest(h.ctx, actor, request.id)
    const r2 = approveRequest(h.ctx, actor, request.id)
    assert.equal(r1.alreadyProcessed, false)
    assert.equal(r2.alreadyProcessed, true)
    assert.equal(r1.subscriptionId, r2.subscriptionId)
    assert.throws(() => cancelRequest(h.ctx, actor, request.id, 'late cancel'), /already approved/)
    const other = await submit()
    cancelRequest(h.ctx, actor, other.request.id, 'no funds')
    assert.throws(() => approveRequest(h.ctx, actor, other.request.id), /already cancelled/)
  })

  it('stacks monthly renewals and restores access after the trial expired', async () => {
    const { device, links } = await submit()
    await submitReview(h, links.confirm, { verified: 'yes' })
    const renewal = await submitPayment(h, device.deviceToken, { planCode: 'monthly' })
    await submitReview(h, (await emailedLinks(h, renewal.json().request.id)).confirm, { verified: 'yes' })
    assert.equal((await statusOf(h, device.deviceToken)).subscription?.expiresAt, '2026-03-10T12:00:00.000Z')

    const late = await registerDevice(h)
    h.clock.advance(TRIAL_DURATION_MS + 60_000)
    assert.equal((await statusOf(h, late.deviceToken)).access.allowed, false)
    const lateReq = await submitPayment(h, late.deviceToken, { planCode: 'monthly' })
    await submitReview(h, (await emailedLinks(h, lateReq.json().request.id)).confirm, { verified: 'yes' })
    assert.equal((await statusOf(h, late.deviceToken)).access.allowed, true)
  })

  it('reports a lapsed monthly subscription', async () => {
    const { device, links } = await submit()
    await submitReview(h, links.confirm, { verified: 'yes' })
    h.clock.set(new Date('2026-02-10T12:00:00.001Z'))
    const status = await statusOf(h, device.deviceToken)
    assert.equal(status.subscription?.status, 'expired')
    assert.deepEqual(status.access, { allowed: false, reason: 'subscription_expired', until: null })
  })
})

describe('migration to email-only decisions', () => {
  it('keeps decisions recorded by earlier administrator accounts', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const { migrate } = await import('../src/db/sqlite.js')
    const { MIGRATIONS } = await import('../src/db/migrations.js')
    const db = new DatabaseSync(':memory:')
    migrate(db, MIGRATIONS.filter((m) => m.version <= 2))
    db.exec('PRAGMA foreign_keys = ON')
    db.prepare(`INSERT INTO devices (id, fingerprint_hash, token_hash, reference_code, platform, app_version, created_at, last_seen_at, token_rotated_at) VALUES ('dev', 'f', 't', 'TP-1', 'linux', '1', 't', 't', 't')`).run()
    for (const r of ['r1', 'r2']) {
      db.prepare(`INSERT INTO payment_requests (id, device_id, plan_code, amount_cents, currency, transaction_id, status, created_at, decided_at) VALUES (?, 'dev', 'monthly', 2000, 'USD', ?, 'cancelled', 't', 't')`).run(r, `TXN-${r}-0000`)
    }
    db.prepare(`INSERT INTO admins (id, email, display_name, password_hash, role, created_at, updated_at) VALUES ('a1', 'old@example.test', 'Old', 'x', 'superadmin', 't', 't')`).run()
    db.prepare(`INSERT INTO admin_decisions (id, request_id, admin_id, decision, reason, created_at) VALUES ('d1', 'r1', 'a1', 'cancelled', 'no funds', 't')`).run()
    assert.deepEqual(migrate(db), [3])
    const row = db.prepare('SELECT admin_id, decided_by, decision, reason FROM admin_decisions').get() as Record<string, unknown>
    assert.deepEqual({ ...row }, { admin_id: 'a1', decided_by: 'admin:old@example.test', decision: 'cancelled', reason: 'no funds' })
    db.prepare(`INSERT INTO admin_decisions (id, request_id, admin_id, decided_by, decision, reason, created_at) VALUES ('d2', 'r2', NULL, 'email:x@example.test', 'approved', NULL, 't')`).run()
    db.close()
  })
})

describe('review passphrase protection', () => {
  it('locks all decisions for 15 minutes after repeated wrong passphrases', async () => {
    const h = await createHarness()
    try {
      const d = await registerDevice(h)
      const res = await submitPayment(h, d.deviceToken)
      const { confirm } = await emailedLinks(h, res.json().request.id)
      for (let i = 0; i < 10; i++) {
        const r = await submitReview(h, confirm, { verified: 'yes' }, { passphrase: `wrong-guess-${i}-xxxx` })
        assert.equal(r.res.statusCode, 401)
      }
      const locked = await submitReview(h, confirm, { verified: 'yes' })
      assert.equal(locked.res.statusCode, 429, 'even the right passphrase while locked')
      assert.match(locked.res.body, /locked for 15 minutes/)
      h.clock.advance(15 * 60_000 + 1)
      assert.equal((await submitReview(h, confirm, { verified: 'yes' })).res.statusCode, 200)
    } finally {
      await h.close()
    }
  })

  it('without a configured passphrase no request is accepted and no decision is possible', async () => {
    const h = await createHarness({ passphrase: false })
    try {
      const d = await registerDevice(h)
      const plans = (await h.app.inject({ method: 'GET', url: '/v1/plans', headers: { authorization: `Bearer ${d.deviceToken}` } })).json()
      assert.equal(plans.payments.available, false)
      assert.equal(plans.payments.problemCode, 'review_passphrase_missing')
      assert.equal(plans.payments.setupCommand, 'npm run review:passphrase -w @tradepilot/server -- --write')
      assert.match(plans.payments.problem, /review passphrase that ourswebsolutions@gmail\.com enters.*has not been created.*REVIEW_PASSPHRASE_HASH/)
      const res = await submitPayment(h, d.deviceToken)
      assert.equal(res.statusCode, 503)
      assert.equal(res.json().error.code, 'payments_not_configured')
    } finally {
      await h.close()
    }
  })

  it('rejects a plain passphrase where its hash is expected', async () => {
    const { loadConfig } = await import('../src/config.js')
    assert.throws(() => loadConfig({ NODE_ENV: 'test', REVIEW_PASSPHRASE_HASH: 'my secret passphrase' }), /must be the scrypt hash/)
  })
})
