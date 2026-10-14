import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { classifySmtpError, sendSmtp, verifySmtp, type SmtpSettings } from '@tradepilot/shared/smtp'
import { WhatsAppClient, whatsappErrorFrom } from '../src/main/channels/whatsapp.js'
import { redact, registerSecret } from '../src/main/redact.js'
import { fakeFetch, integrationService, memoryDb, secretStore } from './helpers.js'

/** Minimal SMTP server: AUTH PLAIN, rejects recipients starting with "reject". */
function fakeSmtp(password: string): Promise<{ server: Server; port: number; received: string[] }> {
  const received: string[] = []
  const server = createServer((sock) => {
    let data = false
    let buf = ''
    sock.write('220 fake.test ESMTP\r\n')
    sock.on('data', (chunk) => {
      buf += chunk.toString()
      if (data) {
        if (buf.includes('\r\n.\r\n')) {
          received.push(buf)
          buf = ''
          data = false
          sock.write('250 2.0.0 OK queued as FAKE123\r\n')
        }
        return
      }
      let idx
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const cmd = line.toUpperCase()
        if (cmd.startsWith('EHLO')) sock.write('250-fake.test\r\n250 AUTH PLAIN\r\n')
        else if (cmd.startsWith('AUTH PLAIN')) {
          const decoded = Buffer.from(line.split(' ')[2] ?? '', 'base64').toString()
          sock.write(decoded.endsWith(`\u0000${password}`) ? '235 2.7.0 Authentication successful\r\n' : '535 5.7.8 Authentication credentials invalid\r\n')
        } else if (cmd.startsWith('MAIL FROM')) sock.write('250 OK\r\n')
        else if (cmd.startsWith('RCPT TO')) sock.write(cmd.includes('REJECT') ? '550 5.1.1 No such user\r\n' : '250 OK\r\n')
        else if (cmd === 'DATA') {
          data = true
          sock.write('354 End data with <CR><LF>.<CR><LF>\r\n')
        } else if (cmd === 'QUIT') {
          sock.write('221 Bye\r\n')
          sock.end()
        } else if (cmd === 'RSET' || cmd === 'NOOP') sock.write('250 OK\r\n')
        else sock.write('502 Command not implemented\r\n')
      }
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port, received })))
}

describe('SMTP (shared with the subscription server)', () => {
  let smtp: Awaited<ReturnType<typeof fakeSmtp>>
  before(async () => (smtp = await fakeSmtp('right-password')))
  after(() => smtp.server.close())
  const cfg = (password: string): SmtpSettings => ({ host: '127.0.0.1', port: smtp.port, secure: false, requireTLS: false, user: 'me', password, from: 'TradePilot <me@fake.test>', timeoutMs: 5000 })

  it('verifies a connection and reports the server reply on delivery', async () => {
    await verifySmtp(cfg('right-password'))
    const r = await sendSmtp(cfg('right-password'), { to: 'ops@fake.test', subject: 'Hi', text: 'Body' })
    assert.deepEqual(r.accepted, ['ops@fake.test'])
    assert.match(r.response, /250 2\.0\.0 OK queued as FAKE123/)
    assert.match(smtp.received.at(-1)!, /Subject: Hi/)
  })

  it('reports authentication failures and rejected recipients accurately', async () => {
    await assert.rejects(verifySmtp(cfg('wrong')), (e: Error & { kind?: string }) => e.kind === 'auth' && /Authentication failed/.test(e.message))
    await assert.rejects(sendSmtp(cfg('right-password'), { to: 'reject@fake.test', subject: 'x', text: 'y' }), /rejected|No recipients/)
  })

  it('explains unreachable servers and TLS mismatches', () => {
    assert.equal(classifySmtpError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })).kind, 'connection')
    assert.equal(classifySmtpError(Object.assign(new Error('wrong version number'), { code: 'ESOCKET' })).kind, 'tls')
  })

  it('runs connection test and test email through the integration service, without exposing the password', async () => {
    const { db, store } = secretStore()
    const { svc } = integrationService(db, store)
    svc.save({ id: 'smtp', config: { host: '127.0.0.1', port: String(smtp.port), secure: 'false', requireTLS: 'false', username: 'me', from: 'me@fake.test', testRecipient: 'ops@fake.test' }, secrets: { password: 'right-password' } })
    const test = await svc.run('smtp', 'test')
    assert.equal(test.result.ok, true)
    assert.match(test.result.message, /No email was sent/)
    const sent = await svc.run('smtp', 'sendTest')
    assert.match(sent.result.message, /Accepted by 127\.0\.0\.1 for ops@fake\.test/)
    assert.ok(sent.view.lastSuccessAt)
    assert.ok(!JSON.stringify(sent.view).includes('right-password'))
  })
})

describe('WhatsApp Business (Cloud API)', () => {
  const cfg = { phoneNumberId: '1234567890', businessAccountId: '99887766', apiVersion: 'v23.0' }

  it('validates the number, lists templates and sends an approved template', async () => {
    const f = fakeFetch((c) => {
      if (c.method === 'POST') return [200, { messaging_product: 'whatsapp', contacts: [{ input: '919876543210', wa_id: '919876543210' }], messages: [{ id: 'wamid.ABC', message_status: 'accepted' }] }]
      if (c.url.includes('message_templates')) return [200, { data: [{ name: 'hello_world', status: 'APPROVED', language: 'en_US' }] }]
      return [200, { id: '1234567890', display_phone_number: '+1 555 0100', verified_name: 'Axora' }]
    })
    const client = new WhatsAppClient(cfg, 'EAAtoken', f.impl)
    assert.equal((await client.phoneNumber()).verified_name, 'Axora')
    assert.equal((await client.templates())[0]!.status, 'APPROVED')
    const r = await client.sendTemplate('919876543210', 'hello_world', 'en_US')
    assert.deepEqual(r, { messageId: 'wamid.ABC', status: 'accepted' })
    const post = f.calls.find((c) => c.method === 'POST')!
    assert.equal(post.url, 'https://graph.facebook.com/v23.0/1234567890/messages')
    assert.deepEqual(JSON.parse(post.body!), { messaging_product: 'whatsapp', recipient_type: 'individual', to: '919876543210', type: 'template', template: { name: 'hello_world', language: { code: 'en_US' } } })
    assert.equal(post.headers.authorization, 'Bearer EAAtoken')
  })

  it('never retries sends and maps Meta error codes', async () => {
    const f = fakeFetch(() => [400, { error: { message: 'Rate limit hit', type: 'OAuthException', code: 130429 } }])
    await assert.rejects(new WhatsAppClient(cfg, 't', f.impl).sendTemplate('919876543210', 'hello_world', 'en_US'), (e: Error & { kind?: string }) => e.kind === 'rate_limited')
    assert.equal(f.calls.length, 1)
    assert.equal(whatsappErrorFrom(401, { error: { code: 190, message: 'expired' } }).kind, 'auth')
    assert.match(whatsappErrorFrom(400, { error: { code: 131030 } }).message, /allowed list/)
    assert.match(whatsappErrorFrom(400, { error: { code: 132001 } }).message, /Template does not exist/)
  })

  it('requires recorded opt-in consent before any test message', async () => {
    const { db, store } = secretStore()
    const f = fakeFetch(() => [200, { messages: [{ id: 'wamid.X' }] }])
    const { svc, consents } = integrationService(db, store, { fetchImpl: f.impl })
    svc.save({ id: 'whatsapp', config: { phoneNumberId: '1234567890', apiVersion: 'v23.0', templateName: 'hello_world', templateLanguage: 'en_US' }, secrets: { accessToken: 'EAAsecrettoken12345' } })
    const denied = await svc.run('whatsapp', 'sendTest', { recipient: '+91 98765 43210' })
    assert.equal(denied.result.ok, false)
    assert.match(denied.result.message, /not opted in/)
    assert.equal(f.calls.length, 0)
    const noConfirm = await svc.run('whatsapp', 'addConsent', { recipient: '+91 98765 43210', confirmed: false })
    assert.equal(noConfirm.result.ok, false)
    await svc.run('whatsapp', 'addConsent', { recipient: '+91 98765 43210', confirmed: true, note: 'signed up on website' })
    assert.equal(consents.list().length, 1)
    const sent = await svc.run('whatsapp', 'sendTest', { recipient: '+919876543210' })
    assert.equal(sent.result.ok, true)
    assert.match(sent.result.message, /wamid\.X/)
    assert.equal(sent.view.state !== 'failed', true, 'a rejected send never marks the connection failed')
  })
})

describe('secret redaction and integration status', () => {
  it('redacts registered secrets and common token formats', () => {
    registerSecret('super-secret-value-123')
    const out = redact('failed with key super-secret-value-123; Authorization: Bearer abcdefghijklmnop sk-ant-fake-ABCDEFGHIJKLMNOPQRS api-key=XYZ123456 {"password":"hunter22"}')
    for (const leaked of ['super-secret-value-123', 'abcdefghijklmnop', 'ABCDEFGHIJKLMNOPQRS', 'XYZ123456', 'hunter22']) assert.ok(!out.includes(leaked), leaked)
  })

  it('records last-success time, keeps settings across restarts, and reports provider errors without secrets', async () => {
    const { db, store } = secretStore()
    let fail = false
    const f = fakeFetch(() => (fail ? [401, { error: { message: 'Incorrect API key provided: sk-live-ABCDEFGH12345678' } }] : [200, { data: [{ id: 'gpt-x' }] }]))
    const { svc } = integrationService(db, store, { fetchImpl: f.impl })
    svc.save({ id: 'openai', config: { model: 'gpt-x' }, secrets: { apiKey: 'sk-live-ABCDEFGH12345678' } })
    const ok = await svc.run('openai', 'test')
    assert.equal(ok.view.state, 'connected')
    assert.match(ok.result.message, /configured model gpt-x is available/)
    const firstSuccess = ok.view.lastSuccessAt
    assert.ok(firstSuccess)
    assert.deepEqual((ok.view.extras.models as { id: string }[]).map((m) => m.id), ['gpt-x'])
    fail = true
    const bad = await svc.run('openai', 'test')
    assert.equal(bad.view.state, 'failed')
    assert.equal(bad.view.lastSuccessAt, firstSuccess, 'last success is kept after a failure')
    assert.ok(!JSON.stringify(bad).includes('ABCDEFGH12345678'))

    // a new service on the same database = app restart
    const { svc: restarted } = integrationService(db, store)
    const v = restarted.view('openai')
    assert.equal(v.config.model, 'gpt-x')
    assert.equal(v.secrets.apiKey, '••••5678')
    assert.equal(v.state, 'failed')
    assert.equal(v.lastSuccessAt, firstSuccess)
  })
})
