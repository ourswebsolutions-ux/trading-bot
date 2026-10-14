import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { TRIAL_DURATION_MS, type StatusResponse } from '@tradepilot/shared'
import { verifyEntitlement } from '@tradepilot/shared/entitlement'
import { createHarness, registerDevice, submitPayment, T0, type Harness } from './helpers.js'

describe('subscription authorization', () => {
  let h: Harness
  before(async () => (h = await createHarness()))
  after(async () => h.close())

  it('requires a valid device credential on every subscription endpoint', async () => {
    for (const url of ['/v1/status', '/v1/plans', '/v1/payment-requests', '/v1/entitlement', '/v1/notifications']) {
      assert.equal((await h.app.inject({ method: 'GET', url })).statusCode, 401, url)
      assert.equal((await h.app.inject({ method: 'GET', url, headers: { authorization: 'Bearer forged-token' } })).statusCode, 401, url)
    }
  })

  it('isolates devices: one device cannot see another device’s requests', async () => {
    const a = await registerDevice(h)
    const b = await registerDevice(h)
    await submitPayment(h, a.deviceToken)
    const list = await h.app.inject({ method: 'GET', url: '/v1/payment-requests', headers: { authorization: `Bearer ${b.deviceToken}` } })
    assert.deepEqual(list.json().requests, [])
  })

  it('issues Ed25519-signed entitlements that the desktop can verify and cannot forge', async () => {
    const d = await registerDevice(h)
    const status = (await h.app.inject({ method: 'GET', url: '/v1/status', headers: { authorization: `Bearer ${d.deviceToken}` } })).json() as StatusResponse
    const verified = verifyEntitlement(status.entitlementToken, h.ctx.keys.publicKeyBase64)
    assert.ok(verified.ok)
    assert.equal(verified.payload.deviceId, d.deviceId)
    assert.equal(verified.payload.allowed, true)
    assert.equal(verified.payload.reason, 'trial')

    // flip "allowed" in an expired token: the signature no longer matches
    const [body, sig] = status.entitlementToken.split('.') as [string, string]
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString())
    const tampered = Buffer.from(JSON.stringify({ ...payload, allowed: true, reason: 'subscription', until: null })).toString('base64url')
    assert.deepEqual(verifyEntitlement(`${tampered}.${sig}`, h.ctx.keys.publicKeyBase64), { ok: false, error: 'bad_signature' })
    assert.deepEqual(verifyEntitlement('not-a-token', h.ctx.keys.publicKeyBase64), { ok: false, error: 'malformed' })
  })

  it('never lets an offline token outlive the trial', async () => {
    const d = await registerDevice(h)
    h.clock.set(new Date(T0.getTime() + TRIAL_DURATION_MS - 3600_000)) // 1h of trial left, token TTL is 12h
    const status = (await h.app.inject({ method: 'GET', url: '/v1/status', headers: { authorization: `Bearer ${d.deviceToken}` } })).json() as StatusResponse
    const verified = verifyEntitlement(status.entitlementToken, h.ctx.keys.publicKeyBase64)
    assert.ok(verified.ok)
    assert.equal(verified.payload.exp, status.trial.endsAt)
    h.clock.set(T0)
  })

  it('returns a signed "not allowed" entitlement once access ends', async () => {
    const d = await registerDevice(h)
    h.clock.advance(TRIAL_DURATION_MS)
    const res = await h.app.inject({ method: 'GET', url: '/v1/entitlement', headers: { authorization: `Bearer ${d.deviceToken}` } })
    assert.equal(res.statusCode, 402)
    const verified = verifyEntitlement(res.json().entitlementToken, h.ctx.keys.publicKeyBase64)
    assert.ok(verified.ok)
    assert.equal(verified.payload.allowed, false)
    h.clock.set(T0)
  })

  it('applies append-only protection to the audit trail', () => {
    assert.throws(() => h.ctx.db.exec('DELETE FROM audit_events'), /append-only/)
    assert.throws(() => h.ctx.db.exec(`UPDATE audit_events SET action = 'x'`), /append-only/)
  })
})
