import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { PaymentRequestDto, PlansResponse } from '@tradepilot/shared'
import { createHarness, PNG_1PX, registerDevice, submitPayment, type Harness } from './helpers.js'

describe('payment request submission', () => {
  let h: Harness
  before(async () => (h = await createHarness()))
  after(async () => h.close())

  it('lists the two plans with server-defined prices and instructions', async () => {
    const d = await registerDevice(h)
    const res = await h.app.inject({ method: 'GET', url: '/v1/plans', headers: { authorization: `Bearer ${d.deviceToken}` } })
    const body = res.json() as PlansResponse
    assert.deepEqual(body.plans.map((p) => [p.code, p.priceCents, p.currency, p.billing]), [
      ['monthly', 2000, 'USD', 'monthly'],
      ['lifetime', 50000, 'USD', 'one_time']
    ])
    assert.ok(body.paymentInstructions)
    assert.equal(body.referenceCode, d.referenceCode)
  })

  it('creates a pending request, ignores client-supplied amounts and emails the administrator', async () => {
    const d = await registerDevice(h)
    const res = await submitPayment(h, d.deviceToken, { planCode: 'lifetime', transactionId: 'abc-12345', amountCents: '1' })
    assert.equal(res.statusCode, 201, res.body)
    const req = (res.json() as { request: PaymentRequestDto }).request
    assert.equal(req.status, 'pending')
    assert.equal(req.amountCents, 50000)
    assert.equal(req.transactionId, 'ABC-12345')

    await h.ctx.notifier.idle()
    const mail = h.mailer.sent.at(-1)!
    assert.equal(mail.to, 'payments@example.test')
    for (const expected of [req.id, 'Lifetime', '$500.00', 'ABC-12345', `https://admin.example.test/admin/requests/${req.id}`]) {
      assert.ok(mail.text.includes(expected), `email should include ${expected}`)
    }
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

  it('refuses submissions until payment instructions are configured', async () => {
    const h2 = await createHarness({ configurePayments: false })
    try {
      const d = await registerDevice(h2)
      const res = await submitPayment(h2, d.deviceToken)
      assert.equal(res.statusCode, 503)
      assert.equal(res.json().error.code, 'payments_not_configured')
    } finally {
      await h2.close()
    }
  })

  it('records a failed admin email instead of failing the request when SMTP errors', async () => {
    const d = await registerDevice(h)
    h.mailer.failNext = true
    const res = await submitPayment(h, d.deviceToken)
    assert.equal(res.statusCode, 201)
    await h.ctx.notifier.idle()
    const row = h.ctx.db.prepare(`SELECT status, error FROM notifications WHERE request_id = ? AND channel = 'email'`).get(res.json().request.id) as { status: string; error: string }
    assert.equal(row.status, 'failed')
    assert.match(row.error, /simulated SMTP failure/)
  })
})
