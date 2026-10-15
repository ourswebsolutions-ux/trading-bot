import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { PaymentRequestDto, PlansResponse } from '@tradepilot/shared'
import { BUSINESS_EMAIL, createHarness, PNG_1PX, registerDevice, submitPayment, type Harness } from './helpers.js'

describe('payment request submission', () => {
  let h: Harness
  before(async () => (h = await createHarness()))
  after(async () => h.close())

  it('lists the two plans with server-defined prices and reports that payments can be submitted', async () => {
    const d = await registerDevice(h)
    const res = await h.app.inject({ method: 'GET', url: '/v1/plans', headers: { authorization: `Bearer ${d.deviceToken}` } })
    const body = res.json() as PlansResponse
    assert.deepEqual(body.plans.map((p) => [p.code, p.priceCents, p.currency, p.billing]), [
      ['monthly', 2000, 'USD', 'monthly'],
      ['lifetime', 50000, 'USD', 'one_time']
    ])
    assert.equal(body.paymentInstructions, null, 'no manually configured instructions are needed')
    assert.deepEqual(body.payments, { available: true, businessEmail: BUSINESS_EMAIL, problem: null, problemCode: null, setupCommand: null })
    assert.equal(body.referenceCode, d.referenceCode)
  })

  it('creates a pending request, ignores client-supplied amounts and returns the review links for the app to email', async () => {
    const d = await registerDevice(h)
    const res = await submitPayment(h, d.deviceToken, { planCode: 'lifetime', transactionId: 'abc-12345', amountCents: '1' })
    assert.equal(res.statusCode, 201, res.body)
    const req = (res.json() as { request: PaymentRequestDto }).request
    assert.equal(req.status, 'pending')
    assert.equal(req.amountCents, 50000)
    assert.equal(req.transactionId, 'ABC-12345')

    const created = res.json()
    assert.equal(created.businessEmail, BUSINESS_EMAIL)
    assert.ok(created.review.confirmUrl.startsWith('https://admin.example.test/review/'))
    assert.notEqual(created.review.confirmUrl, created.review.cancelUrl)
    // the request alone grants nothing: entitlement still comes from the trial
    const status = (await h.app.inject({ method: 'GET', url: '/v1/status', headers: { authorization: `Bearer ${d.deviceToken}` } })).json()
    assert.equal(status.subscription, null)
    assert.equal(status.pendingRequestId, req.id)
  })

  it('validates required fields, transaction ID format and screenshot type', async () => {
    const d = await registerDevice(h)
    const badTxn = await submitPayment(h, d.deviceToken, { transactionId: 'x' })
    assert.equal(badTxn.statusCode, 400)
    assert.ok(badTxn.json().error.fields.transactionId)

    const badPlan = await submitPayment(h, d.deviceToken, { planCode: 'weekly' })
    assert.ok(badPlan.json().error.fields.planCode)

    const noFile = await submitPayment(h, d.deviceToken, {}, null)
    assert.ok(noFile.json().error.fields.screenshot)

    const fakeImage = await submitPayment(h, d.deviceToken, {}, { filename: 'proof.png', contentType: 'image/png', data: Buffer.from('<svg onload=alert(1)>') })
    assert.equal(fakeImage.statusCode, 400)
    assert.match(fakeImage.json().error.fields.screenshot, /PNG, JPEG or WebP/)

    const big = Buffer.concat([PNG_1PX, Buffer.alloc(5 * 1024 * 1024)])
    const tooBig = await submitPayment(h, d.deviceToken, {}, { filename: 'big.png', contentType: 'image/png', data: big })
    assert.equal(tooBig.statusCode, 400)
    assert.match(tooBig.json().error.fields.screenshot, /5 MB/)

    const badEmail = await submitPayment(h, d.deviceToken, { contactEmail: 'nope' })
    assert.ok(badEmail.json().error.fields.contactEmail)
    const noEmail = await submitPayment(h, d.deviceToken, { contactEmail: '' })
    assert.equal(noEmail.statusCode, 400)
    assert.match(noEmail.json().error.fields.contactEmail, /email address/, 'the client\'s registered email is required')
  })

  it('rejects a duplicate transaction ID, even from another device and in different case', async () => {
    const a = await registerDevice(h)
    const b = await registerDevice(h)
    assert.equal((await submitPayment(h, a.deviceToken, { transactionId: 'DUP-998877' })).statusCode, 201)
    const dup = await submitPayment(h, b.deviceToken, { transactionId: ' dup-998877 ' })
    assert.equal(dup.statusCode, 409)
    assert.equal(dup.json().error.code, 'duplicate_transaction')
  })

  it('allows only one pending request per device', async () => {
    const d = await registerDevice(h)
    assert.equal((await submitPayment(h, d.deviceToken)).statusCode, 201)
    const second = await submitPayment(h, d.deviceToken)
    assert.equal(second.statusCode, 409)
    assert.equal(second.json().error.code, 'request_pending')
  })

  it('shows optional extra payment details configured on the server', async () => {
    const h2 = await createHarness({ paymentDetails: 'Bank: Example Bank, account 0001' })
    try {
      const d = await registerDevice(h2)
      const body = (await h2.app.inject({ method: 'GET', url: '/v1/plans', headers: { authorization: `Bearer ${d.deviceToken}` } })).json() as PlansResponse
      assert.equal(body.paymentInstructions, 'Bank: Example Bank, account 0001')
    } finally {
      await h2.close()
    }
  })

  it('the app can withdraw its own undecided request (e.g. its email failed), then submit the same transaction again', async () => {
    const d = await registerDevice(h)
    const other = await registerDevice(h)
    const res = await submitPayment(h, d.deviceToken, { transactionId: 'RETRY-123456' })
    const id = res.json().request.id as string
    const del = (token: string, rid = id) => h.app.inject({ method: 'DELETE', url: `/v1/payment-requests/${rid}`, headers: { authorization: `Bearer ${token}` }, payload: { reason: 'SMTP failed' } })
    assert.equal((await del(other.deviceToken)).statusCode, 404, 'another device cannot withdraw it')
    assert.equal((await del(d.deviceToken)).statusCode, 204)
    assert.equal((h.ctx.db.prepare('SELECT COUNT(*) AS n FROM payment_requests WHERE id = ?').get(id) as { n: number }).n, 0)
    assert.equal((h.ctx.db.prepare('SELECT COUNT(*) AS n FROM review_tokens WHERE request_id = ?').get(id) as { n: number }).n, 0, 'its links are gone')
    const status = (await h.app.inject({ method: 'GET', url: '/v1/status', headers: { authorization: `Bearer ${d.deviceToken}` } })).json()
    assert.equal(status.pendingRequestId, null)
    const retry = await submitPayment(h, d.deviceToken, { transactionId: 'RETRY-123456' })
    assert.equal(retry.statusCode, 201, retry.body)
  })

  it('a decided request cannot be withdrawn', async () => {
    const { approveRequest } = await import('../src/services/payments.js')
    const d = await registerDevice(h)
    const id = (await submitPayment(h, d.deviceToken)).json().request.id as string
    approveRequest(h.ctx, { label: 'test', ip: null }, id)
    const res = await h.app.inject({ method: 'DELETE', url: `/v1/payment-requests/${id}`, headers: { authorization: `Bearer ${d.deviceToken}` } })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().error.code, 'already_decided')
  })
})
