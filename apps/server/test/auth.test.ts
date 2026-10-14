import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { hashPassword, verifyPassword } from '../src/security/passwords.js'
import { LOCKOUT_MS, MAX_FAILED_LOGINS, SESSION_IDLE_MS } from '../src/services/admins.js'
import { ADMIN_EMAIL, adminLogin, createAdminAccount, createHarness, registerDevice, submitPayment, type Harness } from './helpers.js'

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

describe('administrator authentication', () => {
  let h: Harness
  before(async () => {
    h = await createHarness()
    await createAdminAccount(h, 'superadmin')
    await createAdminAccount(h, 'reviewer', 'reviewer@example.test')
  })
  after(async () => h.close())

  it('redirects anonymous visitors to sign-in and never serves evidence publicly', async () => {
    const d = await registerDevice(h)
    const id = (await submitPayment(h, d.deviceToken)).json().request.id
    const page = await h.app.inject({ method: 'GET', url: `/admin/requests/${id}` })
    assert.equal(page.statusCode, 302)
    assert.match(page.headers.location as string, /^\/admin\/login/)
    const evidence = await h.app.inject({ method: 'GET', url: `/admin/requests/${id}/evidence` })
    assert.equal(evidence.statusCode, 302)
    const approve = await h.app.inject({ method: 'POST', url: `/admin/requests/${id}/approve`, payload: { verified: 'yes' } })
    assert.equal(approve.statusCode, 401)
  })

  it('signs in with valid credentials and sets a hardened session cookie', async () => {
    const { res, cookie } = await adminLogin(h)
    assert.equal(res.statusCode, 303)
    assert.ok(cookie.startsWith('__Host-tp_admin='))
    const setCookie = String(res.headers['set-cookie'])
    assert.match(setCookie, /HttpOnly/)
    assert.match(setCookie, /Secure/)
    assert.match(setCookie, /SameSite=Strict/)
  })

  it('rejects a wrong password and locks the account after repeated failures', async () => {
    for (let i = 0; i < MAX_FAILED_LOGINS - 1; i++) {
      const { res } = await adminLogin(h, 'reviewer@example.test', 'wrong password!!')
      assert.equal(res.statusCode, 401)
      assert.match(res.body, /Incorrect email or password/)
    }
    const { res: locking } = await adminLogin(h, 'reviewer@example.test', 'wrong password!!')
    assert.match(locking.body, /temporarily locked/)
    // even the correct password is refused while locked
    const { res: blocked } = await adminLogin(h, 'reviewer@example.test')
    assert.equal(blocked.statusCode, 401)
    h.clock.advance(LOCKOUT_MS + 1)
    const { cookie } = await adminLogin(h, 'reviewer@example.test')
    assert.ok(cookie)
  })

  it('rate-limits sign-in attempts per IP address', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 11; i++) statuses.push((await adminLogin(h, 'nobody@example.test', 'guess-guess-guess', '192.0.2.77')).res.statusCode)
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(401))
    assert.equal(statuses[10], 429)
  })

  it('does not reveal whether an account exists', async () => {
    const { res } = await adminLogin(h, 'nobody@example.test', 'whatever password')
    assert.equal(res.statusCode, 401)
    assert.match(res.body, /Incorrect email or password/)
  })

  it('requires a valid CSRF token on login and on admin actions', async () => {
    const noToken = await h.app.inject({ method: 'POST', url: '/admin/login', payload: { email: ADMIN_EMAIL, password: 'x' } })
    assert.equal(noToken.statusCode, 403)

    const { cookie } = await adminLogin(h)
    const d = await registerDevice(h)
    const id = (await submitPayment(h, d.deviceToken)).json().request.id
    const forged = await h.app.inject({ method: 'POST', url: `/admin/requests/${id}/approve`, headers: { cookie }, payload: { _csrf: 'forged', verified: 'yes' } })
    assert.equal(forged.statusCode, 403)
    assert.equal(h.ctx.db.prepare('SELECT status FROM payment_requests WHERE id = ?').get(id)!.status, 'pending')
  })

  it('rejects cross-origin form posts', async () => {
    const { cookie, csrf } = await adminLogin(h)
    const res = await h.app.inject({
      method: 'POST', url: '/admin/settings', headers: { cookie, origin: 'https://evil.example' },
      payload: { _csrf: csrf, notifyEmail: 'x@example.test', paymentInstructions: 'pay me please now' }
    })
    assert.equal(res.statusCode, 403)
  })

  it('enforces roles: reviewers cannot change settings or read the audit log', async () => {
    const { cookie } = await adminLogin(h, 'reviewer@example.test')
    assert.equal((await h.app.inject({ method: 'GET', url: '/admin/settings', headers: { cookie } })).statusCode, 403)
    assert.equal((await h.app.inject({ method: 'GET', url: '/admin/audit', headers: { cookie } })).statusCode, 403)
    assert.equal((await h.app.inject({ method: 'GET', url: '/admin', headers: { cookie } })).statusCode, 200)
  })

  it('expires idle sessions and invalidates the session on logout', async () => {
    const { cookie, csrf } = await adminLogin(h)
    h.clock.advance(SESSION_IDLE_MS + 1)
    assert.equal((await h.app.inject({ method: 'GET', url: '/admin', headers: { cookie } })).statusCode, 302)

    const fresh = await adminLogin(h)
    const out = await h.app.inject({ method: 'POST', url: '/admin/logout', headers: { cookie: fresh.cookie }, payload: { _csrf: fresh.csrf } })
    assert.equal(out.statusCode, 303)
    assert.equal((await h.app.inject({ method: 'GET', url: '/admin', headers: { cookie: fresh.cookie } })).statusCode, 302)
    void csrf
  })

  it('sends a real SMTP test email and reports the outcome', async () => {
    const { cookie, csrf } = await adminLogin(h)
    const ok = await h.app.inject({ method: 'POST', url: '/admin/settings/test-email', headers: { cookie }, payload: { _csrf: csrf, to: 'ops@example.test' } })
    assert.match(ok.body, /accepted by the SMTP server/)
    assert.equal(h.mailer.sent.at(-1)!.to, 'ops@example.test')
    h.mailer.failNext = true
    const bad = await h.app.inject({ method: 'POST', url: '/admin/settings/test-email', headers: { cookie }, payload: { _csrf: csrf, to: 'ops@example.test' } })
    assert.match(bad.body, /was not sent: simulated SMTP failure/)
  })

  it('escapes user-supplied content in admin pages', async () => {
    const d = await registerDevice(h)
    const res = await submitPayment(h, d.deviceToken, { note: '<script>alert(1)</script>' })
    const { cookie } = await adminLogin(h)
    const page = await h.app.inject({ method: 'GET', url: `/admin/requests/${res.json().request.id}`, headers: { cookie } })
    assert.ok(!page.body.includes('<script>alert(1)</script>'))
    assert.ok(page.body.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
  })
})
