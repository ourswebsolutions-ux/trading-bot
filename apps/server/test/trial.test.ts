import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { TRIAL_DURATION_MS, type StatusResponse } from '@tradepilot/shared'
import { createHarness, fingerprint, registerDevice, T0, type Harness } from './helpers.js'

const status = async (h: Harness, token: string) => {
  const res = await h.app.inject({ method: 'GET', url: '/v1/status', headers: { authorization: `Bearer ${token}` } })
  return { code: res.statusCode, body: res.json() as StatusResponse }
}

describe('72-hour server-side trial', () => {
  let h: Harness
  before(async () => (h = await createHarness()))
  after(async () => h.close())

  it('starts a 72h trial at first registration, using the server clock', async () => {
    const d = await registerDevice(h)
    const { code, body } = await status(h, d.deviceToken)
    assert.equal(code, 200)
    assert.equal(body.trial.startedAt, T0.toISOString())
    assert.equal(body.trial.endsAt, new Date(T0.getTime() + TRIAL_DURATION_MS).toISOString())
    assert.equal(body.trial.active, true)
    assert.equal(body.trial.remainingMs, TRIAL_DURATION_MS)
    assert.deepEqual(body.access, { allowed: true, reason: 'trial', until: body.trial.endsAt })
    assert.match(body.referenceCode, /^TP-[A-Z2-9]{4}-[A-Z2-9]{4}$/)
  })

  it('reports accurate remaining time as server time advances', async () => {
    const d = await registerDevice(h)
    h.clock.advance(10 * 3600_000)
    const { body } = await status(h, d.deviceToken)
    assert.equal(body.trial.remainingMs, TRIAL_DURATION_MS - 10 * 3600_000)
    h.clock.set(T0)
  })

  it('cannot be reset by reinstalling or wiping local data (same hardware fingerprint)', async () => {
    const fp = fingerprint('machine-A')
    const first = await registerDevice(h, fp)
    h.clock.advance(50 * 3600_000)
    const again = await registerDevice(h, fp) // fresh install: no local token, same machine
    assert.equal(again.deviceId, first.deviceId)
    assert.equal(again.referenceCode, first.referenceCode)
    assert.notEqual(again.deviceToken, first.deviceToken)
    const { body } = await status(h, again.deviceToken)
    assert.equal(body.trial.startedAt, T0.toISOString(), 'trial start must not move')
    assert.equal(body.trial.remainingMs, 22 * 3600_000)
    // the previous credential is revoked when re-issued
    assert.equal((await status(h, first.deviceToken)).code, 401)
    h.clock.set(T0)
  })

  it('expires exactly at 72h and then denies access server-side', async () => {
    const d = await registerDevice(h)
    h.clock.set(new Date(T0.getTime() + TRIAL_DURATION_MS - 1))
    assert.equal((await status(h, d.deviceToken)).body.access.allowed, true)
    h.clock.set(new Date(T0.getTime() + TRIAL_DURATION_MS))
    const { body } = await status(h, d.deviceToken)
    assert.equal(body.trial.active, false)
    assert.equal(body.trial.remainingMs, 0)
    assert.deepEqual(body.access, { allowed: false, reason: 'trial_expired', until: null })
    const gate = await h.app.inject({ method: 'GET', url: '/v1/entitlement', headers: { authorization: `Bearer ${d.deviceToken}` } })
    assert.equal(gate.statusCode, 402)
    h.clock.set(T0)
  })

  it('keeps subscription info, plans and request history reachable after expiry', async () => {
    const d = await registerDevice(h)
    h.clock.advance(TRIAL_DURATION_MS + 1)
    const auth = { authorization: `Bearer ${d.deviceToken}` }
    assert.equal((await h.app.inject({ method: 'GET', url: '/v1/plans', headers: auth })).statusCode, 200)
    assert.equal((await h.app.inject({ method: 'GET', url: '/v1/payment-requests', headers: auth })).statusCode, 200)
    assert.equal((await h.app.inject({ method: 'GET', url: '/v1/status', headers: auth })).statusCode, 200)
    h.clock.set(T0)
  })

  it('rejects malformed registration payloads', async () => {
    const res = await h.app.inject({ method: 'POST', url: '/v1/devices/register', payload: { fingerprint: 'not-a-hash', platform: 'x', appVersion: '1' } })
    assert.equal(res.statusCode, 400)
  })
})
