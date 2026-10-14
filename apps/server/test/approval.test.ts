import assert from 'node:assert/strict'
import { after, afterEach, before, describe, it } from 'node:test'
import { TRIAL_DURATION_MS, type PaymentRequestDto, type StatusResponse } from '@tradepilot/shared'
import { approveRequest, cancelRequest } from '../src/services/payments.js'
import { adminLogin, createAdminAccount, createHarness, registerDevice, submitPayment, T0, type Harness } from './helpers.js'

const statusOf = async (h: Harness, token: string) =>
  (await h.app.inject({ method: 'GET', url: '/v1/status', headers: { authorization: `Bearer ${token}` } })).json() as StatusResponse

describe('administrator review and activation', () => {
  let h: Harness
  let admin: { cookie: string; csrf: string }
  let adminId: string

  before(async () => {
    h = await createHarness()
    adminId = await createAdminAccount(h)
    admin = await adminLogin(h)
    assert.ok(admin.cookie, 'admin login should succeed')
  })
  after(async () => h.close())
  afterEach(async () => {
    if (h.clock.now().getTime() !== T0.getTime()) {
      h.clock.set(T0)
      admin = await adminLogin(h)
    }
  })

  const submit = async (planCode = 'monthly', contactEmail = 'user@example.test') => {
    const d = await registerDevice(h)
    const res = await submitPayment(h, d.deviceToken, { planCode, contactEmail })
    assert.equal(res.statusCode, 201, res.body)
    return { device: d, request: (res.json() as { request: PaymentRequestDto }).request }
  }

  const post = (url: string, payload: Record<string, string>) =>
    h.app.inject({ method: 'POST', url, headers: { cookie: admin.cookie, origin: 'https://admin.example.test' }, payload: { _csrf: admin.csrf, ...payload } })

  it('shows the request with its screenshot to an authenticated administrator', async () => {
    const { request } = await submit()
    const page = await h.app.inject({ method: 'GET', url: `/admin/requests/${request.id}`, headers: { cookie: admin.cookie } })
    assert.equal(page.statusCode, 200)
    assert.ok(page.body.includes('Confirm Payment') && page.body.includes('Cancel Request'))
    assert.ok(page.body.includes(request.transactionId))
    const img = await h.app.inject({ method: 'GET', url: `/admin/requests/${request.id}/evidence`, headers: { cookie: admin.cookie } })
    assert.equal(img.statusCode, 200)
    assert.equal(img.headers['content-type'], 'image/png')
    assert.equal(img.headers['cache-control'], 'private, no-store')
  })

  it('Confirm Payment activates a monthly plan exactly once and notifies the user', async () => {
    const { device, request } = await submit()
    const first = await post(`/admin/requests/${request.id}/approve`, { verified: 'yes', version: '1' })
    assert.equal(first.statusCode, 303)
    assert.match(first.headers.location as string, /notice=approved/)

    // replaying the same form (double click / back button) does not activate twice
    const replay = await post(`/admin/requests/${request.id}/approve`, { verified: 'yes', version: '1' })
    assert.equal(replay.statusCode, 303)
    assert.match(replay.headers.location as string, /notice=already_approved/)
    const count = h.ctx.db.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE request_id = ?').get(request.id) as { n: number }
    assert.equal(count.n, 1)

    const status = await statusOf(h, device.deviceToken)
    assert.equal(status.subscription?.planCode, 'monthly')
    assert.equal(status.subscription?.status, 'active')
    assert.equal(status.subscription?.activatedAt, T0.toISOString())
    assert.equal(status.subscription?.expiresAt, '2026-02-10T12:00:00.000Z')
    assert.equal(status.access.reason, 'subscription')

    await h.ctx.notifier.idle()
    assert.ok(h.mailer.sent.some((m) => m.to === 'user@example.test' && m.subject.includes('confirmed')))
    const inApp = await h.app.inject({ method: 'GET', url: '/v1/notifications', headers: { authorization: `Bearer ${device.deviceToken}` } })
    assert.equal(inApp.json().notifications[0].kind, 'payment_approved')

    const audit = h.ctx.db.prepare(`SELECT action FROM audit_events WHERE entity_id IN (?, ?) ORDER BY id`).all(request.id, device.deviceId) as { action: string }[]
    assert.ok(audit.some((a) => a.action === 'payment_request.approved'))
    assert.ok(audit.some((a) => a.action === 'subscription.activated'))
  })

  it('requires the "payment verified" confirmation box', async () => {
    const { request } = await submit()
    const res = await post(`/admin/requests/${request.id}/approve`, { version: '1' })
    assert.equal(res.statusCode, 400)
    assert.equal(h.ctx.db.prepare('SELECT status FROM payment_requests WHERE id = ?').get(request.id)!.status, 'pending')
  })

  it('activates lifetime with no expiry', async () => {
    const { device, request } = await submit('lifetime')
    await post(`/admin/requests/${request.id}/approve`, { verified: 'yes', version: '1' })
    const status = await statusOf(h, device.deviceToken)
    assert.deepEqual([status.subscription?.planCode, status.subscription?.expiresAt, status.access.until], ['lifetime', null, null])
    // a further plan purchase is refused while lifetime is active
    const again = await submitPayment(h, device.deviceToken, { planCode: 'monthly' })
    assert.equal(again.statusCode, 409)
    assert.equal(again.json().error.code, 'lifetime_active')
  })

  it('Cancel Request records the reason, grants nothing and lets the user resubmit', async () => {
    const { device, request } = await submit()
    const noReason = await post(`/admin/requests/${request.id}/cancel`, { reason: ' ', version: '1' })
    assert.equal(noReason.statusCode, 400)

    const res = await post(`/admin/requests/${request.id}/cancel`, { reason: 'No matching payment received', version: '1' })
    assert.equal(res.statusCode, 303)
    const list = (await h.app.inject({ method: 'GET', url: '/v1/payment-requests', headers: { authorization: `Bearer ${device.deviceToken}` } })).json()
    assert.equal(list.requests[0].status, 'cancelled')
    assert.equal(list.requests[0].cancellationReason, 'No matching payment received')
    assert.equal((await statusOf(h, device.deviceToken)).subscription, null)

    // the same transaction reference may be resubmitted once the earlier request was cancelled
    const retry = await submitPayment(h, device.deviceToken, { transactionId: request.transactionId })
    assert.equal(retry.statusCode, 201)
  })

  it('blocks conflicting decisions: approve after cancel, cancel after approve, stale versions', async () => {
    const a = await submit()
    await post(`/admin/requests/${a.request.id}/cancel`, { reason: 'Duplicate', version: '1' })
    const approveCancelled = await post(`/admin/requests/${a.request.id}/approve`, { verified: 'yes', version: '1' })
    assert.equal(approveCancelled.statusCode, 409)

    const b = await submit()
    await post(`/admin/requests/${b.request.id}/approve`, { verified: 'yes', version: '1' })
    const cancelApproved = await post(`/admin/requests/${b.request.id}/cancel`, { reason: 'oops', version: '2' })
    assert.equal(cancelApproved.statusCode, 409)

    const c = await submit()
    const stale = await post(`/admin/requests/${c.request.id}/approve`, { verified: 'yes', version: '7' })
    assert.equal(stale.statusCode, 409)
    assert.equal(h.ctx.db.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE request_id = ?').get(c.request.id)!.n, 0)
  })

  it('service-level approval is idempotent under repeated calls', async () => {
    const { request } = await submit()
    const actor = { id: adminId, email: 'owner@example.test', ip: null }
    const r1 = approveRequest(h.ctx, actor, request.id)
    const r2 = approveRequest(h.ctx, actor, request.id)
    assert.equal(r1.alreadyProcessed, false)
    assert.equal(r2.alreadyProcessed, true)
    assert.equal(r1.subscriptionId, r2.subscriptionId)
    assert.throws(() => cancelRequest(h.ctx, actor, request.id, 'late cancel'), /already approved/)
  })

  it('stacks a monthly renewal after the current period and restores access after trial expiry', async () => {
    const { device, request } = await submit()
    await post(`/admin/requests/${request.id}/approve`, { verified: 'yes', version: '1' })
    const renewal = await submitPayment(h, device.deviceToken, { planCode: 'monthly' })
    await post(`/admin/requests/${renewal.json().request.id}/approve`, { verified: 'yes', version: '1' })
    const status = await statusOf(h, device.deviceToken)
    assert.equal(status.subscription?.expiresAt, '2026-03-10T12:00:00.000Z')

    // a device whose trial has lapsed regains access as soon as its payment is confirmed
    const late = await registerDevice(h)
    h.clock.advance(TRIAL_DURATION_MS + 60_000)
    admin = await adminLogin(h) // the earlier session idled out during the time jump
    assert.equal((await statusOf(h, late.deviceToken)).access.allowed, false)
    const lateReq = await submitPayment(h, late.deviceToken, { planCode: 'monthly' })
    assert.equal(lateReq.statusCode, 201)
    await post(`/admin/requests/${lateReq.json().request.id}/approve`, { verified: 'yes', version: '1' })
    const after = await statusOf(h, late.deviceToken)
    assert.equal(after.access.allowed, true)
    assert.equal(after.access.reason, 'subscription')
    h.clock.set(T0)
  })

  it('reports an expired monthly subscription and denies access after it lapses', async () => {
    const { device, request } = await submit()
    await post(`/admin/requests/${request.id}/approve`, { verified: 'yes', version: '1' })
    h.clock.set(new Date('2026-02-10T12:00:00.001Z'))
    admin = await adminLogin(h)
    const status = await statusOf(h, device.deviceToken)
    assert.equal(status.subscription?.status, 'expired')
    assert.deepEqual(status.access, { allowed: false, reason: 'subscription_expired', until: null })
    h.clock.set(T0)
  })
})
