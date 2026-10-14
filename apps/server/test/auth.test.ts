import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { hashPassword, verifyPassword } from '../src/security/passwords.js'
import { authenticateAdmin, LOCKOUT_MS, MAX_FAILED_LOGINS } from '../src/services/admins.js'
import { createAdminAccount, createHarness, emailedLinks, registerDevice, submitPayment, submitReview, type Harness } from './helpers.js'

describe('password hashing', () => {
  it('produces salted scrypt hashes that verify only the right password', async () => {
    const a = await hashPassword('s3cret-passphrase')
    const b = await hashPassword('s3cret-passphrase')
    assert.notEqual(a, b)
    assert.match(a, /^scrypt\$32768\$8\$1\$/)
    assert.equal(await verifyPassword('s3cret-passphrase', a), true)
    assert.equal(await verifyPassword('s3cret-passphrasE', a), false)
    assert.equal(await verifyPassword('anything', 'garbage'), false)
  })
})

describe('administrator confirmation step on review links', () => {
  let h: Harness
  before(async () => {
    h = await createHarness()
    await createAdminAccount(h)
  })
  after(async () => h.close())

  const pending = async (note?: string) => {
    const d = await registerDevice(h)
    const res = await submitPayment(h, d.deviceToken, note ? { note } : {})
    return { id: res.json().request.id as string, links: await emailedLinks(h, res.json().request.id) }
  }

  it('locks an administrator account after repeated wrong passwords', async () => {
    for (let i = 0; i < MAX_FAILED_LOGINS - 1; i++) assert.equal((await authenticateAdmin(h.ctx, 'owner@example.test', 'nope-nope-nope', null)).ok, false)
    const locked = await authenticateAdmin(h.ctx, 'owner@example.test', 'nope-nope-nope', null)
    assert.equal(locked.ok, false)
    assert.equal(!locked.ok && locked.reason, 'locked')
    assert.equal((await authenticateAdmin(h.ctx, 'owner@example.test', 'correct horse battery staple', null)).ok, false, 'even the right password while locked')
    h.clock.advance(LOCKOUT_MS + 1)
    assert.equal((await authenticateAdmin(h.ctx, 'owner@example.test', 'correct horse battery staple', null)).ok, true)
  })

  it('does not reveal whether an administrator account exists', async () => {
    const { links } = await pending()
    const r = await submitReview(h, links.confirm, { verified: 'yes' }, { email: 'nobody@example.test' })
    assert.equal(r.res.statusCode, 401)
    assert.match(r.res.body, /Incorrect administrator email or password/)
  })

  it('rate-limits decision attempts per IP address', async () => {
    const { links } = await pending()
    const codes: number[] = []
    for (let i = 0; i < 11; i++) codes.push((await submitReview(h, links.confirm, { verified: 'yes' }, { password: 'wrong-password-x', remoteAddress: '192.0.2.50' })).res.statusCode)
    assert.equal(codes[10], 429)
  })

  it('serves review pages with no-store, a strict CSP and no referrer', async () => {
    const { links } = await pending()
    const page = await h.app.inject({ method: 'GET', url: links.confirm })
    assert.equal(page.headers['cache-control'], 'no-store')
    assert.match(String(page.headers['content-security-policy']), /default-src 'none'/)
    assert.match(page.body, /name="referrer" content="no-referrer"/)
  })

  it('escapes client-supplied content on the review page', async () => {
    const { links } = await pending('<script>alert(1)</script>')
    const page = await h.app.inject({ method: 'GET', url: links.cancel })
    assert.ok(!page.body.includes('<script>alert(1)</script>'))
    assert.ok(page.body.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
  })

  it('no longer exposes an administrator dashboard', async () => {
    for (const url of ['/admin', '/admin/login', '/admin/settings', '/admin/audit']) assert.equal((await h.app.inject({ method: 'GET', url })).statusCode, 404, url)
  })
})
