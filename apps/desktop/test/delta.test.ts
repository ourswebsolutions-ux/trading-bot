import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { DeltaRest, deltaErrorFrom, deltaSignature } from '../src/main/delta/rest.js'
import { regionFromLegacyBaseUrl } from '../src/main/delta/regions.js'
import { ProviderError, requestJson } from '../src/main/net.js'
import { fakeFetch, noSleep } from './helpers.js'

const product = (symbol: string) => ({ id: 1, symbol, description: `${symbol} perpetual`, contract_type: 'perpetual_futures', state: 'live', trading_status: 'operational', tick_size: '0.5', contract_value: '0.001', underlying_asset: { symbol: 'BTC' }, quoting_asset: { symbol: 'USD' } })

describe('Delta Exchange REST client', () => {
  it('signs private requests with api-key, timestamp and HMAC over method+timestamp+path+query', async () => {
    const f = fakeFetch(() => [200, { success: true, result: [{ asset_symbol: 'USD', balance: '125.50', available_balance: '100' }] }])
    const rest = new DeltaRest('india', { apiKey: 'KEY123', apiSecret: 'SECRET456' }, f.impl, noSleep)
    const balances = await rest.balances()
    assert.deepEqual(balances.map((b) => [b.asset_symbol, b.balance, b.available_balance]), [['USD', 125.5, 100]])
    const call = f.calls[0]!
    assert.equal(call.url, 'https://api.india.delta.exchange/v2/wallet/balances')
    assert.equal(call.headers['api-key'], 'KEY123')
    assert.equal(call.headers.signature, deltaSignature('SECRET456', 'GET', call.headers.timestamp!, '/v2/wallet/balances', ''))
    assert.ok(Math.abs(Number(call.headers.timestamp) - Date.now() / 1000) < 5)
  })

  it('includes the query string in the signature and re-signs every retry', async () => {
    const f = fakeFetch((_c, n) => (n === 1 ? [429, { error: 'too_many_requests' }, { 'x-rate-limit-reset': '5' }] : [200, { success: true, result: [] }]))
    const rest = new DeltaRest('global', { apiKey: 'K', apiSecret: 'S' }, f.impl, noSleep)
    await rest.orderHistory(10)
    assert.equal(f.calls.length, 2)
    for (const c of f.calls) {
      assert.ok(c.url.startsWith('https://api.delta.exchange/v2/orders/history?page_size=10'))
      assert.equal(c.headers.signature, deltaSignature('S', 'GET', c.headers.timestamp!, '/v2/orders/history', '?page_size=10'))
    }
  })

  it('does not call private endpoints without credentials', async () => {
    const f = fakeFetch(() => [200, {}])
    await assert.rejects(new DeltaRest('india', null, f.impl).balances(), /not configured/)
    assert.equal(f.calls.length, 0)
  })

  it('maps both error shapes and region blocks to actionable messages', () => {
    assert.match(deltaErrorFrom(401, { error: 'unauthorized', success: false }).message, /rejected the credentials/)
    assert.equal(deltaErrorFrom(401, { error: { code: 'invalid_api_key' }, success: false }).kind, 'auth')
    assert.match(deltaErrorFrom(401, { error: { code: 'expired_signature', context: {} } }).message, /clock/)
    assert.match(deltaErrorFrom(401, { error: { code: 'ip_not_whitelisted_for_api_key' } }).message, /whitelist/)
    const blocked = deltaErrorFrom(403, { error: 'ACCESS_RESTRICTED', title: 'Access Restricted: Region Not Supported' })
    assert.equal(blocked.kind, 'region_blocked')
    assert.equal(deltaErrorFrom(503, null).kind, 'provider')
  })

  it('validates responses and rejects unexpected shapes instead of showing bad data', async () => {
    const ok = fakeFetch(() => [200, { success: true, result: [product('BTCUSD'), product('ETHUSD')] }])
    const products = await new DeltaRest('india', null, ok.impl).products()
    assert.deepEqual(products.map((p) => [p.symbol, p.tick_size, p.contract_value]), [['BTCUSD', 0.5, 0.001], ['ETHUSD', 0.5, 0.001]])
    assert.match(ok.calls[0]!.url, /contract_types=perpetual_futures&states=live/)

    const bad = fakeFetch(() => [200, { success: true, result: [{ symbol: 'X', tick_size: 'abc' }] }])
    await assert.rejects(new DeltaRest('india', null, bad.impl).products(), (e: ProviderError) => e.kind === 'bad_response')
  })

  it('maps the Phase 1 base URL setting to a region', () => {
    assert.equal(regionFromLegacyBaseUrl('https://api.delta.exchange'), 'global')
    assert.equal(regionFromLegacyBaseUrl('https://cdn-ind.testnet.deltaex.org'), 'india_testnet')
    assert.equal(regionFromLegacyBaseUrl('https://elsewhere'), null)
  })
})

describe('bounded HTTP retries and timeouts', () => {
  it('retries 5xx and 429 a bounded number of times, then returns the last response', async () => {
    const sleeps: number[] = []
    const f = fakeFetch(() => [503, { error: 'down' }])
    const res = await requestJson('https://x.test/a', { fetchImpl: f.impl, attempts: 3, sleep: async (ms) => void sleeps.push(ms) })
    assert.equal(res.status, 503)
    assert.equal(f.calls.length, 3)
    assert.deepEqual(sleeps, [500, 1000])
  })

  it('honours Retry-After but caps the wait', async () => {
    const sleeps: number[] = []
    const f = fakeFetch((_c, n) => (n === 1 ? [429, {}, { 'retry-after': '600' }] : [200, { ok: 1 }]))
    const res = await requestJson('https://x.test/b', { fetchImpl: f.impl, sleep: async (ms) => void sleeps.push(ms) })
    assert.equal(res.status, 200)
    assert.deepEqual(sleeps, [10_000])
  })

  it('never retries POST by default and does not retry 4xx', async () => {
    const post = fakeFetch(() => [500, {}])
    await requestJson('https://x.test/c', { method: 'POST', body: '{}', fetchImpl: post.impl, sleep: noSleep })
    assert.equal(post.calls.length, 1)
    const bad = fakeFetch(() => [400, {}])
    await requestJson('https://x.test/d', { fetchImpl: bad.impl, sleep: noSleep })
    assert.equal(bad.calls.length, 1)
  })

  it('reports timeouts and network failures as classified errors', async () => {
    // AbortSignal.timeout uses an unref'd timer; keep the test process alive while it runs
    const keepAlive = setTimeout(() => {}, 5000)
    after(() => clearTimeout(keepAlive))
    const hang = (async (_u: unknown, init?: RequestInit) =>
      new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('t'), { name: 'TimeoutError' }))))) as typeof fetch
    await assert.rejects(requestJson('https://x.test/e', { fetchImpl: hang, timeoutMs: 50, attempts: 1 }), (e: ProviderError) => e.kind === 'timeout')
    const down = (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch
    await assert.rejects(requestJson('https://x.test/f', { fetchImpl: down, attempts: 2, sleep: noSleep }), (e: ProviderError) => e.kind === 'network')
  })
})
