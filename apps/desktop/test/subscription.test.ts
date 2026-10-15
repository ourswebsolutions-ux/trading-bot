import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { AddressInfo } from 'node:net'
import { signEntitlement } from '@tradepilot/shared/entitlement'
import { evaluateEntitlement } from '../src/main/entitlement.js'
import { SubscriptionService, type ClientEmail } from '../src/main/subscription.js'
import { BUSINESS_EMAIL, createHarness, PNG_1PX, submitReview, type Harness } from '../../server/test/helpers.js'
import type { SmtpMessage } from '@tradepilot/shared/smtp'
import { memoryDb, secretStore } from './helpers.js'

describe('offline entitlement evaluation', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  const now = new Date('2026-03-01T00:00:00Z')
  const token = (over: Record<string, unknown> = {}) =>
    signEntitlement({ v: 1, deviceId: 'dev-1', allowed: true, reason: 'trial', planCode: null, until: '2026-03-02T00:00:00.000Z', serverTime: now.toISOString(), exp: '2026-03-01T12:00:00.000Z', ...over } as never, privateKey)

  it('allows a valid, fresh token for this device', () => {
    assert.equal(evaluateEntitlement(token(), pub, 'dev-1', now).allowed, true)
  })
  it('rejects forged, foreign, stale and rolled-back-clock tokens', () => {
    const other = generateKeyPairSync('ed25519').privateKey
    const forged = signEntitlement({ v: 1, deviceId: 'dev-1', allowed: true, reason: 'subscription', planCode: 'lifetime', until: null, serverTime: now.toISOString(), exp: '2099-01-01T00:00:00.000Z' }, other)
    assert.equal(evaluateEntitlement(forged, pub, 'dev-1', now).allowed, false)
    assert.equal(evaluateEntitlement(token(), pub, 'dev-2', now).allowed, false)
    assert.equal(evaluateEntitlement(token(), pub, 'dev-1', new Date('2026-03-01T12:00:00Z')).allowed, false)
    const rolledBack = evaluateEntitlement(token(), pub, 'dev-1', new Date('2026-02-20T00:00:00Z'))
    assert.equal(rolledBack.allowed, false)
    assert.match(rolledBack.detail, /clock/)
  })
  it('honours a server "not allowed" verdict', () => {
    const d = evaluateEntitlement(token({ allowed: false, reason: 'trial_expired', until: null }), pub, 'dev-1', now)
    assert.equal(d.allowed, false)
    assert.match(d.detail, /trial has ended/)
  })
})

describe('desktop ↔ server subscription flow (real HTTP)', () => {
  let h: Harness
  let baseUrl: string
  const machine = createHash('sha256').update('test-machine').digest('hex')

  before(async () => {
    h = await createHarness()
    await h.app.listen({ port: 0, host: '127.0.0.1' })
    baseUrl = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`
  })
  after(async () => h.close())

  /** Stands in for the client's SMTP connection (Settings → SMTP Email); records what would be sent. */
  const outbox: SmtpMessage[] = []
  let smtp: { configured: boolean; fail: string | null } = { configured: true, fail: null }
  const clientEmail: ClientEmail = {
    problem: () => (smtp.configured ? null : 'Set up your email connection first: open Settings → SMTP Email.'),
    address: () => (smtp.configured ? 'client@example.test' : null),
    send: async (m) => {
      if (smtp.fail) throw new Error(smtp.fail)
      outbox.push(m)
    }
  }
  const client = (db = memoryDb(), now = () => h.clock.now()) => {
    const { store } = secretStore(db)
    return new SubscriptionService({
      db, secrets: store, apiBaseUrl: baseUrl, configurationError: null, publicKey: h.ctx.keys.publicKeyBase64,
      appVersion: '0.1.0', platform: 'linux', fingerprint: async () => machine, now, clientEmail
    })
  }

  it('registers, verifies the signed status and grants trial access', async () => {
    const svc = client()
    const view = await svc.refresh()
    assert.equal(view.syncError, null)
    assert.equal(view.access.allowed, true)
    assert.equal(view.access.reason, 'trial')
    assert.equal(view.status?.trial.active, true)
    assert.ok(!('entitlementToken' in (view.status ?? {})), 'raw token must not reach the renderer')
    assert.doesNotThrow(() => svc.requireAccess('Backtesting'))
  })

  it('keeps the same trial after local data is wiped (reinstall)', async () => {
    const first = client()
    const a = await first.refresh()
    const wiped = client()
    const b = await wiped.refresh()
    assert.equal(b.status?.trial.startedAt, a.status?.trial.startedAt)
    assert.equal(b.status?.deviceId, a.status?.deviceId)
  })

  it('blocks paid features after expiry but keeps plans and history reachable, then restores on approval', async () => {
    const db = memoryDb()
    const svc = client(db)
    await svc.refresh()
    h.clock.advance(72 * 3600_000 + 1000)
    const expired = await svc.refresh()
    assert.equal(expired.access.allowed, false)
    assert.throws(() => svc.requireAccess('Backtesting'), /requires an active trial or subscription/)

    const plans = await svc.plans()
    assert.deepEqual(plans.plans.map((p) => p.priceCents), [2000, 50000])
    assert.deepEqual(plans.payments, { available: true, businessEmail: BUSINESS_EMAIL, problem: null, problemCode: null, setupCommand: null })
    assert.deepEqual(plans.clientEmail, { configured: true, address: 'client@example.test', problem: null })

    const dir = mkdtempSync(path.join(tmpdir(), 'tp-shot-'))
    const file = path.join(dir, 'proof.png')
    writeFileSync(file, PNG_1PX)
    const shot = await svc.loadScreenshot(file)
    assert.match(shot.previewDataUrl, /^data:image\/png;base64,/)
    await assert.rejects(svc.submit({ planCode: 'monthly', transactionId: 'x', screenshotId: shot.id }), /highlighted/)
    const created = await svc.submit({ planCode: 'monthly', transactionId: 'UPI-778899', screenshotId: shot.id })
    assert.equal(created.status, 'pending')
    assert.equal((await svc.requests())[0]?.id, created.id)
    assert.equal((await svc.refresh()).access.allowed, false, 'a pending request grants nothing')

    // the client's own SMTP sent the request to the business address; the server sent nothing
    const mail = outbox.find((m) => m.text.includes(created.id))!
    assert.equal(mail.to, BUSINESS_EMAIL)
    for (const s of ['Client email:     client@example.test', 'Plan:             Monthly', '$20.00', 'Transaction ID:   UPI-778899', 'Confirm Payment:', 'Cancel Request:', 'review passphrase']) assert.ok(mail.text.includes(s), s)
    assert.equal(mail.attachments?.length, 1)
    assert.ok(mail.attachments![0]!.content.equals(PNG_1PX), 'payment screenshot attached')
    assert.equal(mail.attachments![0]!.contentType, 'image/png')
    assert.ok(!h.mailer.sent.some((m) => m.to === BUSINESS_EMAIL), 'no server-side email')
    // the recipient opens the emailed link: opening changes nothing; the decision needs the passphrase
    const confirm = new URL(/Confirm Payment:\s+(\S+)/.exec(mail.text)![1]!).pathname
    assert.equal((await submitReview(h, confirm, { verified: 'yes' }, { passphrase: 'client guess 12345' })).res.statusCode, 401)
    assert.equal((await svc.refresh()).access.allowed, false, 'a wrong passphrase grants nothing')
    assert.equal((await submitReview(h, confirm, { verified: 'yes' })).res.statusCode, 200)
    const restored = await svc.refresh()
    assert.equal(restored.access.allowed, true)
    assert.equal(restored.status?.subscription?.planCode, 'monthly')
    h.clock.set(new Date('2026-01-10T12:00:00.000Z'))
  })

  const pickShot = async (svc: SubscriptionService) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tp-shot-'))
    writeFileSync(path.join(dir, 'p.png'), PNG_1PX)
    return svc.loadScreenshot(path.join(dir, 'p.png'))
  }

  it('asks the client to configure their email connection before submitting', async () => {
    smtp = { configured: false, fail: null }
    try {
      const svc = client()
      await svc.refresh()
      const plans = await svc.plans()
      assert.equal(plans.clientEmail.configured, false)
      assert.match(plans.clientEmail.problem!, /Settings → SMTP Email/)
      const shot = await pickShot(svc)
      await assert.rejects(svc.submit({ planCode: 'monthly', transactionId: 'UPI-445566', screenshotId: shot.id, contactEmail: 'me@example.test' }), /Set up your email connection first/)
      assert.equal(h.ctx.db.prepare(`SELECT COUNT(*) AS n FROM payment_requests WHERE transaction_id = 'UPI-445566'`).get()!.n, 0, 'nothing reached the server')
    } finally {
      smtp = { configured: true, fail: null }
    }
  })

  it('withdraws the request when the client\'s email cannot be sent, so nothing is left pending', async () => {
    const svc = client()
    await svc.refresh()
    const shot = await pickShot(svc)
    smtp = { configured: true, fail: 'Invalid login: 535 5.7.8 Username and Password not accepted' }
    try {
      await assert.rejects(svc.submit({ planCode: 'lifetime', transactionId: 'UPI-990011', screenshotId: shot.id }), /could not be emailed to ourswebsolutions@gmail\.com: Invalid login.*Nothing was submitted/)
    } finally {
      smtp = { configured: true, fail: null }
    }
    assert.equal(h.ctx.db.prepare(`SELECT COUNT(*) AS n FROM payment_requests WHERE transaction_id = 'UPI-990011'`).get()!.n, 0)
    assert.equal((await svc.refresh()).status?.pendingRequestId, null)
    // fixed the email settings: the same screenshot and transaction can be submitted again
    const again = await svc.submit({ planCode: 'lifetime', transactionId: 'UPI-990011', screenshotId: shot.id })
    assert.equal(again.status, 'pending')
  })

  it('re-registers transparently when its device credential was revoked', async () => {
    const db = memoryDb()
    const svc = client(db)
    await svc.refresh()
    await client().refresh() // another install on the same machine rotates the credential
    const view = await svc.refresh()
    assert.equal(view.syncError, null)
  })

  it('reports an unreachable server honestly and falls back to the cached signed status', async () => {
    const db = memoryDb()
    const svc = client(db)
    await svc.refresh()
    const offline = new SubscriptionService({
      db, secrets: secretStore(db).store, apiBaseUrl: 'http://127.0.0.1:9', configurationError: null, publicKey: h.ctx.keys.publicKeyBase64,
      appVersion: '0.1.0', platform: 'linux', fingerprint: async () => machine, now: () => h.clock.now()
    })
    const view = await offline.refresh()
    assert.match(view.syncError ?? '', /could not be reached/)
    assert.equal(view.access.source, 'offline_token')
    assert.equal(view.access.allowed, true)
  })

  it('rejects status signed by a different key', async () => {
    const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    const svc = new SubscriptionService({
      db: memoryDb(), secrets: secretStore().store, apiBaseUrl: baseUrl, configurationError: null, publicKey: other,
      appVersion: '0.1.0', platform: 'linux', fingerprint: async () => machine, now: () => h.clock.now()
    })
    const view = await svc.refresh()
    assert.match(view.syncError ?? '', /signature/)
    assert.equal(view.access.allowed, false)
  })
})

describe('update error messages', () => {
  it('explains common updater failures in plain language', async () => {
    const { describeUpdateError } = await import('../src/main/updater.js')
    assert.match(describeUpdateError(new Error('HttpError: 404 \n "method: GET url: https://github.com/x/releases.atom"')), /No published release/)
    assert.match(describeUpdateError(new Error('sha512 checksum mismatch, expected abc, got def')), /integrity check/)
    assert.match(describeUpdateError(new Error('net::ERR_INTERNET_DISCONNECTED')), /internet connection/)
    assert.match(describeUpdateError(new Error('New version 1.0.1 is not signed by the application owner: publisherNames: X')), /not signed by the expected publisher/)
    assert.match(describeUpdateError(new Error('something odd\nstack')), /^Update failed: something odd\.$/)
  })
})
