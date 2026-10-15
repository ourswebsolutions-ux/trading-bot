import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { createHarness, emailedLinks, registerDevice, submitPayment, submitReview, type Harness } from './helpers.js'

describe('review link protections (no administrator accounts)', () => {
  let h: Harness
  before(async () => {
    h = await createHarness()
  })
  after(async () => h.close())

  const pending = async (note?: string) => {
    const d = await registerDevice(h)
    const res = await submitPayment(h, d.deviceToken, note ? { note } : {})
    return { id: res.json().request.id as string, links: await emailedLinks(h, res.json().request.id) }
  }

  it('rate-limits decision attempts per IP address', async () => {
    const { links } = await pending()
    const codes: number[] = []
    // missing confirmation box: rejected without consuming the link, so it can be retried until throttled
    for (let i = 0; i < 11; i++) codes.push((await submitReview(h, links.confirm, {}, { remoteAddress: '192.0.2.50' })).res.statusCode)
    assert.deepEqual(codes.slice(0, 10), Array(10).fill(400))
    assert.equal(codes[10], 429)
  })

  it('a link token cannot be guessed from another request: tokens are per request and per action', async () => {
    const a = await pending()
    const b = await pending()
    assert.notEqual(a.links.confirm, b.links.confirm)
    assert.notEqual(a.links.confirm, a.links.cancel)
    const res = await submitReview(h, a.links.confirm, { verified: 'yes' })
    assert.equal(res.res.statusCode, 200)
    assert.equal(h.ctx.db.prepare('SELECT status FROM payment_requests WHERE id = ?').get(b.id)!.status, 'pending', 'other requests untouched')
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

  it('exposes no administrator dashboard or login', async () => {
    for (const url of ['/admin', '/admin/login', '/admin/settings', '/admin/audit']) assert.equal((await h.app.inject({ method: 'GET', url })).statusCode, 404, url)
  })
})
