import assert from 'node:assert/strict'
import path from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'
import { EngineBridge } from '../src/main/engine.js'
import { ProviderError } from '../src/main/net.js'
import { StrategyStore } from '../src/main/strategies.js'
import { AutomationService } from '../src/main/trading/automation.js'
import { PaperExchange, type ExchangeAdapter, type MarketOrderRequest, type OrderResult } from '../src/main/trading/exchange.js'
import { DEFAULT_RISK } from '../src/shared/tradingRisk.js'
import type { Candle, Instrument } from '../src/shared/ipc.js'
import type { StrategyDefinition } from '../src/shared/strategyRules.js'
import { memoryDb } from './helpers.js'

const HOUR = 3600
const T0 = Date.UTC(2026, 5, 1, 0, 0, 10) // 10 s after a candle boundary
const INSTRUMENT: Instrument = { symbol: 'BTCUSD', productId: 27, settlingAsset: 'USD', description: 'BTC', underlying: 'BTC', quoteAsset: 'USD', tickSize: 0.5, contractValue: 0.001, tradingStatus: 'operational' }

/** Buys on every closed candle when flat (so each new candle produces a signal). */
const ALWAYS_LONG: StrategyDefinition = {
  version: 2, name: 'Always long', description: '', symbol: 'BTCUSD', timeframe: '1h', direction: 'long',
  indicators: [],
  entry: { long: { match: 'all', conditions: [{ left: { type: 'price', field: 'close' }, op: '>', right: { type: 'value', value: 0 } }] }, short: null },
  exit: { long: null, short: null },
  risk: { stopLoss: { type: 'percent', value: 1 }, takeProfit: { type: 'percent', value: 2 }, sizing: { type: 'percent_equity', value: 50 }, maxDailyLossPct: 5, maxTradesPerDay: 5, feeBps: 5 }
}

/** Scripted stand-in for Delta Exchange (tests only). */
class FakeDelta implements ExchangeAdapter {
  readonly mode = 'live' as const
  posSize = 0
  orders = new Map<string, OrderResult>()
  placed: MarketOrderRequest[] = []
  cancelAllCalls: boolean[] = []
  fills: { side: 'buy' | 'sell'; size: number; price: number; fee: number; at: string }[] = []
  nextPlace: 'fill' | 'timeout_but_filled' | 'timeout_not_received' | 'reject' | 'partial' = 'fill'
  price = 100_000
  async placeMarket(o: MarketOrderRequest): Promise<OrderResult> {
    this.placed.push(o)
    const mode = this.nextPlace
    this.nextPlace = 'fill'
    if (mode === 'reject') throw new ProviderError('invalid_request', 'Insufficient margin: the account does not have enough available funds for this order.', 400, undefined, 'insufficient_margin')
    const filled = mode === 'partial' ? Math.max(1, Math.floor(o.size / 2)) : o.size
    const r: OrderResult = { exchangeOrderId: String(this.placed.length), state: mode === 'partial' ? 'partially_filled' : 'filled', size: o.size, filled, avgPrice: this.price, fee: 0.05 * filled, note: null }
    if (mode !== 'timeout_not_received') {
      this.orders.set(o.clientOrderId, mode === 'partial' ? { ...r, state: 'partially_filled' } : r)
      this.posSize += (o.side === 'buy' ? 1 : -1) * filled * (o.reduceOnly ? 1 : 1)
    }
    if (mode === 'timeout_but_filled' || mode === 'timeout_not_received') throw new ProviderError('timeout', 'Request timed out after 15s.')
    return r
  }
  async orderByClientId(cid: string) {
    return this.orders.get(cid) ?? null
  }
  async cancel(id: string) {
    for (const [k, v] of this.orders) if (v.exchangeOrderId === id && v.state === 'partially_filled') this.orders.set(k, { ...v, state: 'partially_filled', note: 'cancelled: remainder' })
  }
  async position() {
    return { size: this.posSize, entryPrice: this.posSize ? this.price : null }
  }
  async cancelAll(_p: number, includeStops: boolean) {
    this.cancelAllCalls.push(includeStops)
  }
  async fillsSince() {
    return this.fills
  }
}

describe('automated trading', () => {
  let engine: EngineBridge
  before(async () => {
    engine = new EngineBridge(path.resolve(import.meta.dirname, '../../../engine'), () => 'python3')
    const st = await engine.start()
    assert.equal(st.state, 'ready', st.message ?? '')
  })
  after(() => engine.stop())

  let now: number
  let db: ReturnType<typeof memoryDb>
  let store: StrategyStore
  let fake: FakeDelta
  let mark: number
  let alerts: string[]
  let liveConfigured: boolean

  const candles = async (_s: string, _tf: string, _days: number): Promise<Candle[]> => {
    const lastClosed = Math.floor(now / 1000 / HOUR) * HOUR - HOUR
    return Array.from({ length: 60 }, (_, i) => {
      const t = lastClosed - (59 - i) * HOUR
      return { time: t, open: mark, high: mark * 1.001, low: mark * 0.999, close: mark, volume: 1 }
    })
  }

  const service = () =>
    new AutomationService({
      db,
      now: () => now,
      engine: (m, p) => engine.request(m, p, 30_000),
      strategy: (id) => store.get(id).catch(() => null),
      validate: (d) => store.validate(d),
      candles,
      instruments: async () => [INSTRUMENT],
      markPrice: async () => mark,
      liveExchange: () => (liveConfigured ? fake : null),
      paperExchange: new PaperExchange(async () => mark, () => 0.001, () => 5),
      liveAccount: async () => ({ equity: 10_000, available: 9_000 }),
      liveChecks: () => [{ id: 'delta', label: 'Delta', ok: liveConfigured, detail: liveConfigured ? 'ok' : 'Run a successful Delta Exchange connection test.' }],
      region: () => ({ id: 'india_testnet', label: 'Delta Exchange India (testnet)', testnet: true }),
      watchSymbols: () => {},
      alert: (a) => alerts.push(a.title),
      onChange: () => {},
      sleep: async () => {}
    })

  const enabledStrategy = async (def: StrategyDefinition = ALWAYS_LONG) => {
    const s = await store.save(undefined, def)
    return store.setEnabled(s.id, true)
  }
  const nextCandle = () => (now += HOUR * 1000)
  const sessions = (svc: AutomationService) => svc.overview({}).then((o) => o.sessions)

  beforeEach(() => {
    now = T0
    db = memoryDb()
    store = new StrategyStore(db, async () => ({ instruments: ['BTCUSD'] }))
    fake = new FakeDelta()
    mark = 100_000
    alerts = []
    liveConfigured = true
  })

  it('refuses to start without risk settings, an enabled strategy, or live trading turned on', async () => {
    const svc = service()
    const s = await enabledStrategy()
    await assert.rejects(svc.start(s.id, 'paper'), /risk settings/)
    svc.saveRisk({ ...DEFAULT_RISK, configured: true })
    await store.setEnabled(s.id, false)
    await assert.rejects(svc.start(s.id, 'paper'), /enabled/)
    await store.setEnabled(s.id, true)
    await assert.rejects(svc.start(s.id, 'live'), /Live trading is turned off/)
    liveConfigured = false
    assert.throws(() => svc.setLive(true), /connection test/)
    liveConfigured = true
    svc.setLive(true)
    fake.posSize = 3
    await assert.rejects(svc.start(s.id, 'live'), /already shows an open BTCUSD position/)
  })

  it('paper: enters on a new closed candle once, never twice, and exits at the stop-loss', async () => {
    const svc = service()
    svc.saveRisk({ ...DEFAULT_RISK, configured: true, maxOrderNotionalUsd: 100_000 })
    const s = await enabledStrategy()
    await svc.start(s.id, 'paper')
    await svc.tick()
    assert.equal((await sessions(svc))[0]!.position, null, 'no action on the candle that closed before the start')
    nextCandle()
    await svc.tick()
    await svc.tick() // same candle again: must not trade twice
    let ss = (await sessions(svc))[0]!
    assert.equal(ss.position?.side, 'long')
    assert.equal(ss.position?.contracts, 50, '50% of 10,000 / (100,000 × 0.001)')
    assert.equal(ss.position?.stopPrice, 99_000)
    const orders = (await svc.overview({})).orders
    assert.equal(orders.filter((o) => o.purpose === 'entry').length, 1)
    assert.equal(orders[0]!.state, 'filled')
    mark = 98_900
    await svc.tick()
    ss = (await sessions(svc))[0]!
    assert.equal(ss.position, null)
    const trade = (await svc.overview({})).trades[0]!
    assert.equal(trade.exitReason, 'stop_loss')
    assert.ok(trade.netPnl < trade.grossPnl, 'fees are deducted')
    assert.ok(Math.abs(trade.grossPnl - (98_900 - 100_000) * 50 * 0.001) < 1e-6)
  })

  it('live: sends integer contracts with a client order id and exchange-side stop/target; a restart cannot repeat the signal', async () => {
    const svc = service()
    svc.saveRisk({ ...DEFAULT_RISK, configured: true, maxOrderNotionalUsd: 2_000 })
    svc.setLive(true)
    const s = await enabledStrategy()
    await svc.start(s.id, 'live')
    nextCandle()
    await svc.tick()
    assert.equal(fake.placed.length, 1)
    const o = fake.placed[0]!
    assert.equal(o.side, 'buy')
    assert.equal(o.size, 20, 'capped by the 2,000 USD order notional limit')
    assert.ok(Number.isInteger(o.size))
    assert.match(o.clientOrderId, /^e[0-9a-f]{30}$/)
    assert.equal(o.stopPrice, 99_000)
    assert.equal(o.takePrice, 102_000)
    assert.equal(o.reduceOnly, false)

    // simulate an app restart on the same database, still within the same candle
    fake.posSize = 0
    db.prepare(`UPDATE automation_sessions SET position = NULL`).run()
    const restarted = service()
    await restarted.tick()
    assert.equal(fake.placed.length, 1, 'the same signal is never sent again')
  })

  it('live: resolves timeouts by client order id, gives up on orders the exchange never received, and records rejections', async () => {
    const svc = service()
    svc.saveRisk({ ...DEFAULT_RISK, configured: true, maxOrderNotionalUsd: 2_000 })
    svc.setLive(true)
    const s = await enabledStrategy()
    await svc.start(s.id, 'live')

    fake.nextPlace = 'timeout_but_filled'
    nextCandle()
    await svc.tick()
    let ov = await svc.overview({})
    assert.equal(ov.orders[0]!.state, 'unknown')
    assert.equal(ov.sessions[0]!.position, null)
    await svc.reconcile()
    const after = await svc.overview({})
    assert.equal(after.orders[0]!.state, 'filled')
    assert.equal(after.sessions[0]!.position?.contracts, 20, 'reconciliation opened the position from the exchange record')
  })

  it('live: an order the exchange never received is marked rejected; a margin rejection leaves no position', async () => {
    const svc = service()
    svc.saveRisk({ ...DEFAULT_RISK, configured: true, maxOrderNotionalUsd: 2_000 })
    svc.setLive(true)
    const s = await enabledStrategy()
    await svc.start(s.id, 'live')
    fake.nextPlace = 'timeout_not_received'
    nextCandle()
    await svc.tick()
    now += 61_000
    await svc.reconcile()
    let ov = await svc.overview({})
    assert.equal(ov.orders[0]!.state, 'rejected')
    assert.match(ov.orders[0]!.error ?? '', /no record/)

    fake.nextPlace = 'reject'
    nextCandle()
    await svc.tick()
    ov = await svc.overview({})
    assert.equal(ov.orders[0]!.state, 'rejected')
    assert.match(ov.orders[0]!.error ?? '', /Insufficient margin/)
    assert.equal(ov.sessions[0]!.position, null)
    assert.ok(alerts.includes('Order rejected'))
  })

  it('live: a partial fill opens only the filled size', async () => {
    const svc = service()
    svc.saveRisk({ ...DEFAULT_RISK, configured: true, maxOrderNotionalUsd: 2_000 })
    svc.setLive(true)
    const s = await enabledStrategy()
    await svc.start(s.id, 'live')
    fake.nextPlace = 'partial'
    nextCandle()
    await svc.tick()
    const ov = await svc.overview({})
    assert.equal(ov.orders[0]!.state, 'partially_filled')
    assert.equal(ov.sessions[0]!.position?.contracts, 10)
  })

  it('live: reconciles positions closed on the exchange and blocks entries on untracked positions', async () => {
    const svc = service()
    svc.saveRisk({ ...DEFAULT_RISK, configured: true, maxOrderNotionalUsd: 2_000 })
    svc.setLive(true)
    const s = await enabledStrategy()
    await svc.start(s.id, 'live')
    nextCandle()
    await svc.tick()
    // the exchange's bracket stop fired
    fake.posSize = 0
    fake.fills = [{ side: 'sell', size: 20, price: 99_000, fee: 0.4, at: new Date(now).toISOString() }]
    await svc.reconcile()
    let ov = await svc.overview({})
    assert.equal(ov.sessions[0]!.position, null)
    assert.equal(ov.trades[0]!.exitReason, 'stop_loss_on_exchange')
    // someone opened a position manually on the same contract
    fake.posSize = 7
    await svc.reconcile()
    ov = await svc.overview({})
    assert.match(ov.sessions[0]!.warning ?? '', /did not open/)
    const before = fake.placed.length
    nextCandle()
    await svc.tick()
    assert.equal(fake.placed.length, before, 'no new entry on top of an untracked position')
  })

  it('emergency stop closes positions with reduce-only orders, stops everything and blocks new starts', async () => {
    const svc = service()
    svc.saveRisk({ ...DEFAULT_RISK, configured: true, maxOrderNotionalUsd: 2_000, emergencyAction: 'close_positions' })
    svc.setLive(true)
    const s = await enabledStrategy()
    await svc.start(s.id, 'live')
    nextCandle()
    await svc.tick()
    await svc.emergencyStop()
    const exit = fake.placed.at(-1)!
    assert.equal(exit.reduceOnly, true)
    assert.equal(exit.side, 'sell')
    assert.deepEqual(fake.cancelAllCalls[0], true, 'protective orders cancelled before closing')
    const ov = await svc.overview({})
    assert.equal(ov.emergency.active, true)
    assert.equal(ov.sessions[0]!.status, 'stopped')
    assert.equal(ov.sessions[0]!.position, null)
    await assert.rejects(svc.start(s.id, 'paper'), /emergency stop is active/)
    svc.clearEmergency()
    await svc.start(s.id, 'paper')
  })

  it('emergency stop can keep positions with their exchange-side protection', async () => {
    const svc = service()
    svc.saveRisk({ ...DEFAULT_RISK, configured: true, maxOrderNotionalUsd: 2_000, emergencyAction: 'keep_positions' })
    svc.setLive(true)
    const s = await enabledStrategy()
    await svc.start(s.id, 'live')
    nextCandle()
    await svc.tick()
    const placed = fake.placed.length
    await svc.emergencyStop()
    assert.equal(fake.placed.length, placed, 'no closing order')
    assert.deepEqual(fake.cancelAllCalls, [false], 'only working entry orders cancelled; stop-loss/take-profit kept')
    assert.equal((await sessions(svc))[0]!.position?.contracts, 20)
  })

  it('keeps strategies under automation from being deleted and pauses automation when live trading is turned off', async () => {
    const svc = service()
    svc.saveRisk({ ...DEFAULT_RISK, configured: true })
    svc.setLive(true)
    const s = await enabledStrategy()
    await svc.start(s.id, 'live')
    assert.equal((await store.save(s.id, { ...ALWAYS_LONG, name: 'changed' })).version, 2, 'edits create a new version')
    assert.throws(() => store.delete(s.id), /Stop the live automation/)
    await assert.rejects(store.setEnabled(s.id, false), /Stop the live automation/)
    svc.setLive(false)
    assert.equal((await sessions(svc))[0]!.status, 'paused')
  })

  it('never trades a strategy that was not confirmed, enabled and valid', async () => {
    const svc = service()
    svc.saveRisk({ ...DEFAULT_RISK, configured: true })
    svc.setLive(true)
    // an AI interpretation saved by the client starts disabled and cannot be run
    const draft = await store.save(undefined, ALWAYS_LONG, { source: 'ai', aiProvider: 'anthropic', prompt: 'buy on every candle' })
    assert.equal(draft.status, 'disabled')
    await assert.rejects(svc.start(draft.id, 'paper'), /Only enabled/)
    await assert.rejects(svc.start(draft.id, 'live'), /Only enabled/)
    // an invalid strategy cannot be enabled
    const bad = await store.save(undefined, { ...ALWAYS_LONG, name: 'No stop', risk: { ...ALWAYS_LONG.risk, stopLoss: null } })
    await assert.rejects(store.setEnabled(bad.id, true), /before enabling/)
    // a pinned definition that no longer validates (e.g. tampered with) is never sent to the exchange
    await store.setEnabled(draft.id, true)
    await svc.start(draft.id, 'live')
    db.prepare('UPDATE automation_sessions SET definition = ?').run(JSON.stringify({ ...ALWAYS_LONG, risk: { ...ALWAYS_LONG.risk, stopLoss: null } }))
    nextCandle()
    await svc.tick()
    assert.equal(fake.placed.length, 0, 'no order')
    assert.equal((await sessions(svc))[0]!.status, 'paused')
    // and the engine itself refuses such a definition even if the desktop check were bypassed
    await assert.rejects(engine.request('session_evaluate', { definition: { ...ALWAYS_LONG, risk: { ...ALWAYS_LONG.risk, stopLoss: null } }, risk: { ...DEFAULT_RISK, configured: true }, candles: [] }), /strategy is not valid/)
  })

  it('applies paper slippage against every simulated fill', async () => {
    const paper = new PaperExchange(async () => 100, () => 1, () => 0, () => 10)
    const buy = await paper.placeMarket({ productId: 1, symbol: 'BTCUSD', side: 'buy', size: 1, clientOrderId: 'a', reduceOnly: false, tickSize: 0.5 })
    const sell = await paper.placeMarket({ productId: 1, symbol: 'BTCUSD', side: 'sell', size: 1, clientOrderId: 'b', reduceOnly: true, tickSize: 0.5 })
    assert.equal(buy.avgPrice, 100.1)
    assert.equal(sell.avgPrice, 99.9)
  })

  it('runs the pinned version: edits never alter an open position and apply only when flat', async () => {
    const svc = service()
    svc.saveRisk({ ...DEFAULT_RISK, configured: true })
    const s = await enabledStrategy()
    await svc.start(s.id, 'paper')
    nextCandle()
    await svc.tick()
    let [sess] = await sessions(svc)
    const firstContracts = sess!.position!.contracts
    const v2 = await store.save(s.id, { ...ALWAYS_LONG, risk: { ...ALWAYS_LONG.risk, sizing: { type: 'percent_equity', value: 2 } } }, { source: 'ai', aiProvider: 'anthropic', changeRequest: 'use 2% per trade' })
    assert.equal(v2.version, 2)
    assert.equal(v2.status, 'enabled')
    ;[sess] = await sessions(svc)
    assert.equal(sess!.strategyVersion, 1)
    assert.equal(sess!.latestVersion, 2)
    assert.equal(sess!.position!.contracts, firstContracts, 'the open position is untouched')
    await assert.rejects(svc.applyLatestVersion(sess!.id), /keeps those rules/)
    await assert.rejects(store.save(s.id, { ...ALWAYS_LONG, risk: { ...ALWAYS_LONG.risk, stopLoss: null } }), /only a valid version/)
    assert.equal((await store.get(s.id)).version, 2, 'the invalid edit was not saved')

    // take-profit closes the version-1 position; the trade records version 1
    mark *= 1.03
    await svc.tick()
    const o = await svc.overview({})
    assert.equal(o.sessions[0]!.position, null)
    assert.equal(o.trades[0]!.strategyVersion, 1)

    await svc.applyLatestVersion(sess!.id)
    ;[sess] = await sessions(svc)
    assert.equal(sess!.strategyVersion, 2)
    nextCandle()
    await svc.tick()
    ;[sess] = await sessions(svc)
    assert.ok(sess!.position!.contracts < firstContracts, 'new entries use the applied version (2% sizing)')
    const versions = store.versions(s.id)
    assert.deepEqual(versions.map((v) => v.version), [2, 1])
    assert.equal(versions[0]!.changeRequest, 'use 2% per trade')
    const activity = svc.strategyActivity(s.id, {})
    assert.equal(activity.sessions.length, 1)
    assert.equal(activity.trades.length, 1)
    assert.ok(activity.events.some((e) => /version 2/.test(e.message)))
  })
})
