import type { StrategyDefinition } from '../src/shared/strategyRules.js'
import { AiUsageTracker } from '../src/main/ai/provider.js'
import { ConsentStore } from '../src/main/channels/whatsapp.js'
import { openDatabase, type Db } from '../src/main/db.js'
import { IntegrationService } from '../src/main/integrations.js'
import { buildIntegrationSpecs, migrateIntegrationConfig } from '../src/main/integrationSpecs.js'
import type { MarketDataService } from '../src/main/marketData.js'
import { SecretStore, type SecretCipher } from '../src/main/secrets.js'

/** Reversible stand-in for safeStorage so tests can assert that plaintext never hits the DB. */
export const fakeCipher: SecretCipher = {
  available: () => ({ ok: true, backend: 'test', reason: null }),
  encrypt: (s) => Buffer.from(`enc:${Buffer.from(s).reverse().toString('base64')}`),
  decrypt: (b) => Buffer.from(b.toString().slice(4), 'base64').reverse().toString()
}

export function memoryDb() {
  return openDatabase(':memory:')
}

export function secretStore(db = memoryDb()) {
  return { db, store: new SecretStore(db, fakeCipher) }
}

export function integrationService(db: Db, store: SecretStore, opts: { fetchImpl?: typeof fetch; market?: MarketDataService } = {}) {
  const usage = new AiUsageTracker(db)
  const consents = new ConsentStore(db)
  const svc: IntegrationService = new IntegrationService(
    db,
    store,
    buildIntegrationSpecs({
      integrations: () => svc,
      market: () => opts.market ?? (null as unknown as MarketDataService),
      usage,
      consents,
      defaultSymbol: () => 'BTCUSD',
      fetchImpl: opts.fetchImpl
    }),
    () => {},
    migrateIntegrationConfig
  )
  return { svc, usage, consents }
}

export interface FakeCall {
  url: string
  method: string
  headers: Record<string, string>
  body: string | undefined
}

/** Scripted fetch: each handler returns [status, body, headers?] or throws. */
export function fakeFetch(handler: (call: FakeCall, n: number) => [number, unknown, Record<string, string>?] | Promise<[number, unknown, Record<string, string>?]>) {
  const calls: FakeCall[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const rawHeaders = init?.headers ?? (input instanceof Request ? input.headers : undefined)
    const headers: Record<string, string> = {}
    new Headers(rawHeaders as HeadersInit | undefined).forEach((v, k) => (headers[k] = v))
    const body = typeof init?.body === 'string' ? init.body : input instanceof Request ? await input.clone().text() : undefined
    const call = { url, method: (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase(), headers, body }
    calls.push(call)
    const [status, payload, extra] = await handler(call, calls.length)
    return new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), { status, headers: { 'content-type': 'application/json', ...(extra ?? {}) } })
  }) as typeof fetch
  return { impl, calls }
}

export const noSleep = async () => {}

/** A complete, valid rule-based strategy for tests. */
export function rsiStrategy(over: Partial<StrategyDefinition> = {}): StrategyDefinition {
  return {
    version: 2,
    name: 'RSI dip buyer',
    description: 'Buy oversold dips',
    symbol: 'BTCUSD',
    timeframe: '1h',
    direction: 'long',
    indicators: [{ id: 'rsi_14', kind: 'rsi', period: 14 }],
    entry: { long: { match: 'all', conditions: [{ left: { type: 'indicator', id: 'rsi_14' }, op: '<', right: { type: 'value', value: 30 } }] }, short: null },
    exit: { long: { match: 'all', conditions: [{ left: { type: 'indicator', id: 'rsi_14' }, op: '>', right: { type: 'value', value: 55 } }] }, short: null },
    risk: { stopLoss: { type: 'percent', value: 2 }, takeProfit: { type: 'risk_multiple', value: 2 }, sizing: { type: 'risk_percent', value: 1 }, maxDailyLossPct: 3, maxTradesPerDay: 4, feeBps: 5 },
    ...over
  }
}
