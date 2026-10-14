import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { IntegrationService, deltaSignature } from '../src/main/integrations.js'
import { maskHint, SecretStore } from '../src/main/secrets.js'
import { memoryDb, secretStore } from './helpers.js'

describe('credential storage', () => {
  it('encrypts secrets at rest and only exposes masked hints', () => {
    const { db, store } = secretStore()
    store.set('openai.apiKey', 'sk-test-1234567890abcd')
    const raw = db.prepare('SELECT ciphertext, hint FROM secrets').get() as { ciphertext: Uint8Array; hint: string }
    assert.ok(!Buffer.from(raw.ciphertext).toString().includes('sk-test'))
    assert.equal(raw.hint, '••••abcd')
    assert.equal(store.get('openai.apiKey'), 'sk-test-1234567890abcd')
    assert.equal(maskHint('short'), '••••')
  })

  it('refuses to store secrets when OS encryption is unavailable', () => {
    const store = new SecretStore(memoryDb(), {
      available: () => ({ ok: false, backend: 'basic_text', reason: 'no keyring' }),
      encrypt: () => Buffer.alloc(0),
      decrypt: () => ''
    })
    assert.throws(() => store.set('x', 'value'), /no keyring/)
  })

  it('integration views never contain secret values and saving resets the test status', () => {
    const { db, store } = secretStore()
    const svc = new IntegrationService(db, store)
    assert.equal(svc.view('delta').state, 'not_configured')
    assert.throws(() => svc.save({ id: 'delta', config: { baseUrl: 'https://evil.example' }, secrets: { apiKey: 'k' } }), /highlighted/)
    const view = svc.save({ id: 'delta', config: { baseUrl: 'https://api.india.delta.exchange' }, secrets: { apiKey: 'AKEY-0000-1111-2222', apiSecret: 'SECRET-aaaa-bbbb-cccc' } })
    assert.equal(view.state, 'untested')
    assert.equal(view.secrets.apiKey, '••••2222')
    assert.ok(!JSON.stringify(view).includes('SECRET-aaaa'))
    // omitted secrets keep their stored value
    svc.save({ id: 'delta', config: { baseUrl: 'https://api.delta.exchange' }, secrets: {} })
    assert.equal(svc.secret('delta', 'apiSecret'), 'SECRET-aaaa-bbbb-cccc')
    assert.equal(svc.clear('delta').state, 'not_configured')
    assert.equal(svc.secret('delta', 'apiSecret'), null)
  })

  it('computes Delta Exchange request signatures (known-answer vector from openssl)', () => {
    assert.equal(deltaSignature('secret', 'GET', '1700000000', '/v2/wallet/balances'), '7ca79ae4b830eaf1806ed9a1c82c39250005bc3bc693c61893a32d286356d3b4')
  })
})
