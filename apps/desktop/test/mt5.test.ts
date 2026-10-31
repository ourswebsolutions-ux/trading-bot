import assert from 'node:assert/strict'
import path from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'
import { EngineBridge } from '../src/main/engine.js'
import { ProviderError } from '../src/main/net.js'
import { Mt5BridgeClient } from '../src/main/mt5/client.js'
import { Mt5Connection } from '../src/main/mt5/connection.js'
import { isForexWeekend, Mt5MarketData, pipSizeOf, toInstrument } from '../src/main/mt5/marketData.js'
import { describeRetcode } from '../src/main/mt5/retcodes.js'
import { StrategyStore } from '../src/main/strategies.js'
import { AutomationService, type AutomationDeps, type VenueDeps } from '../src/main/trading/automation.js'
import { PaperExchange } from '../src/main/trading/exchange.js'
import { fillingFor, Mt5Exchange } from '../src/main/trading/mt5Exchange.js'
import { DEFAULT_RISK } from '../src/shared/tradingRisk.js'
import type { StrategyDefinition } from '../src/shared/strategyRules.js'
import { FakeMt5, fxSymbol, SERVER_OFFSET_SEC } from './fakeMt5.js'
import { memoryDb } from './helpers.js'

const WED = Date.UTC(2026, 5, 3, 10, 0, 10) // Wednesday 10:00:10 UTC: forex market open
const SAT = Date.UTC(2026, 5, 6, 12, 0, 10) // Saturday: closed
const MAGIC = 260901
const CREDS = { login: '51234567', password: 'demo-pass', server: 'Broker-Demo' }

function setup(start = WED, knownOffset: number | null = null) {
  const clock = { now: start }
  const fake = new FakeMt5(() => clock.now)
  let offset: number | null = knownOffset
  const logs: string[] = []
  const conn = new Mt5Connection(fake, () => CREDS, { get: () => offset, set: (v) => (offset = v) }, () => clock.now, (m) => logs.push(m))
  const market = new Mt5MarketData({ conn, settings: () => ({ staleAfterSec: 15 }), onSnapshot: () => {}, onCandle: () => {}, now: () => clock.now, sleep: async (ms) => void (clock.now += ms) })
  const ex = new Mt5Exchange(conn, { magic: MAGIC, deviationPoints: 20, now: () => clock.now })
  return { clock, fake, conn, market, ex, logs, offset: () => offset }
}

describe('MetaTrader 5 connection', () => {
  it('reports exactly why MT5 is unavailable off Windows or without settings', async () => {
    const bridge = new Mt5BridgeClient({ engineDir: '/nowhere', bundledExecutable: null, python: () => 'python3', platform: 'linux' })
    assert.match(bridge.unavailable()!, /needs Windows/)
    const conn = new Mt5Connection(new FakeMt5(() => WED), () => null, { get: () => null, set: () => {} })
    assert.match(conn.unavailable()!, /Settings → MetaTrader 5/)
    await assert.rejects(conn.ensure(), /not set up/)
  })

  it('logs in once, reports a wrong password without echoing it, and reconnects reads once', async () => {
    const { fake, conn } = setup()
    fake.password = 'other'
    await assert.rejects(conn.ensure(), (e: Error) => /Authorization failed/.test(e.message) && !e.message.includes('demo-pass'))
    assert.equal(conn.isConnected(), false)
    fake.password = 'demo-pass'
    await conn.ensure()
    assert.equal(fake.connects, 2)
    fake.connected = false // the terminal session dropped
    const a = await conn.read((c) => c.account())
    assert.equal(a.login, 51234567)
    assert.equal(fake.connects, 3, 'one reconnect for a read')
  })

  it('never re-sends an order when the send fails', async () => {
    const { fake, conn } = setup()
    await conn.ensure()
    fake.nextSend = 'network'
    await assert.rejects(conn.send({ action: 'deal', symbol: 'EURUSD', type: 'buy', volume: 0.1 }), ProviderError)
    assert.equal(fake.sent.length, 1)
  })

  it('learns the broker server time only from a moving market', async () => {
    const { fake, conn, market, clock } = setup(SAT)
    // Friday evening's last tick on a Saturday: it could pass for a "fresh" tick at UTC-12
    fake.frozen = true
    fake.tickTimeUtcMs = Date.UTC(2026, 5, 5, 20, 59, 0)
    for (let i = 0; i < 3; i++) {
      await market.tickers(['EURUSD'])
      clock.now += 1000
    }
    assert.equal(conn.serverOffset(), null, 'a frozen tick never sets the clock')
    fake.frozen = false
    await market.tickers(['EURUSD'])
    assert.equal(conn.serverOffset(), null, 'one moving tick is not enough')
    clock.now += 1000
    await market.tickers(['EURUSD'])
    assert.equal(conn.serverOffset(), SERVER_OFFSET_SEC)
    assert.equal(conn.toUtc(1_000_000 + SERVER_OFFSET_SEC), 1_000_000)
  })
})

describe('MetaTrader 5 market data', () => {
  it('maps broker symbols to lot-based instruments with pips and value per point', async () => {
    const { market } = setup()
    const list = await market.instruments()
    const eur = list.find((i) => i.symbol === 'EURUSD')!
    assert.deepEqual(
      { venue: eur.venue, pip: eur.pipSize, vpp: eur.valuePerPoint, step: eur.volumeStep, min: eur.volumeMin, max: eur.volumeMax, unit: eur.volumeUnit, perVol: eur.unitsPerVolume, cs: eur.contractSize, minStop: eur.minStopDistance, cls: eur.assetClass },
      { venue: 'mt5', pip: 0.0001, vpp: 100_000, step: 0.01, min: 0.01, max: 50, unit: 'lots', perVol: 1, cs: 100_000, minStop: 10 * 0.00001, cls: 'forex' }
    )
    const jpy = list.find((i) => i.symbol === 'USDJPY')!
    assert.equal(jpy.pipSize, 0.01)
    assert.equal(jpy.valuePerPoint, 666.7, 'USD value of a 1.0 JPY move per lot')
    assert.equal(pipSizeOf(2, 0.01), 0.01, 'indices/metals with 2 digits: one point')
    assert.equal(toInstrument(fxSymbol({ trade_tick_value: 0 })).valuePerPoint, null, 'no tick value: cannot be sized')
    await assert.rejects(market.requireSupported('GBPUSD.x'), /not offered by your MetaTrader 5 broker/)
  })

  it('returns closed candles only, in UTC, with the spread in price units', async () => {
    const { market, conn, clock, fake } = setup()
    fake.frozen = true // no ticks: the clock cannot be learned
    await assert.rejects(market.series('EURUSD', '1h', 2, true), /server time/, 'automation waits for the broker clock')
    fake.frozen = false
    // automation samples moving ticks itself (no chart needs to be open)
    const s = await market.series('EURUSD', '1h', 2, true)
    assert.equal(conn.serverOffset(), SERVER_OFFSET_SEC)
    const last = s.candles.at(-1)!
    const lastClosed = Math.floor(clock.now / 1000 / 3600) * 3600 - 3600
    assert.equal(last.time, lastClosed, 'forming bar dropped; server time converted to UTC')
    assert.ok(Math.abs(last.spread! - 0.00012) < 1e-12)
    assert.equal(conn.serverOffset(), SERVER_OFFSET_SEC)
  })

  it('labels quotes live, stale or closed and knows when the market is closed', async () => {
    const open = setup(WED)
    open.market.watch('test', ['EURUSD'])
    await open.market.tickers(['EURUSD'])
    assert.equal(open.market.snapshot().quotes.EURUSD!.state, 'live')
    assert.equal(await open.market.isMarketOpen('EURUSD'), true)
    open.market.stop()
    const shut = setup(SAT)
    shut.fake.frozen = true
    shut.fake.tickTimeUtcMs = Date.UTC(2026, 5, 5, 20, 59, 0) // Friday's last tick
    assert.equal(await shut.market.isMarketOpen('EURUSD'), false)
    shut.market.watch('test', ['EURUSD'])
    await shut.market.tickers(['EURUSD'])
    assert.equal(shut.market.snapshot().quotes.EURUSD!.state, 'closed')
    shut.market.stop()
    assert.equal(isForexWeekend(SAT), true)
    assert.equal(isForexWeekend(WED), false)
  })
})

describe('MetaTrader 5 execution', () => {
  it('sends a market order with stops on the position, magic number and signal comment', async () => {
    const { fake, ex } = setup()
    const r = await ex.placeMarket({ productId: 0, symbol: 'EURUSD', side: 'buy', size: 0.1, clientOrderId: 'e0123456789abcdef0123456789abcd', reduceOnly: false, stopPrice: 1.083123456, takePrice: 1.0891, tickSize: 0.00001 })
    const req = fake.sent[0]!
    assert.deepEqual(
      { action: req.action, type: req.type, volume: req.volume, price: req.price, sl: req.sl, tp: req.tp, magic: req.magic, comment: req.comment, filling: req.filling, deviation: req.deviation },
      { action: 'deal', type: 'buy', volume: 0.1, price: 1.08512, sl: 1.08312, tp: 1.0891, magic: MAGIC, comment: 'e0123456789abcdef0123456789abcd', filling: 'ioc', deviation: 20 }
    )
    assert.equal(r.state, 'filled')
    assert.equal(r.filled, 0.1)
    assert.equal(r.avgPrice, 1.08512, 'bought at the ask')
    assert.ok(Math.abs(r.fee - 0.35) < 1e-9, 'commission from the deal')
    assert.ok(r.positionTicket! > 0)
    assert.deepEqual([fillingFor(2), fillingFor(1), fillingFor(0)], ['ioc', 'fok', 'return'])
  })

  it('refuses orders that could never succeed without contacting the broker', async () => {
    const { fake, ex } = setup()
    const base = { productId: 0, symbol: 'EURUSD', side: 'buy' as const, clientOrderId: 'e1', reduceOnly: false, takePrice: null, tickSize: 0.00001 }
    await assert.rejects(ex.placeMarket({ ...base, size: 0.015, stopPrice: 1.08 }), /not valid for EURUSD \(step 0.01/)
    await assert.rejects(ex.placeMarket({ ...base, size: 100, stopPrice: 1.08 }), /maximum 50 lots/)
    await assert.rejects(ex.placeMarket({ ...base, size: 0.1, stopPrice: 1.08507 }), /closer to the market .* than this broker allows/)
    fake.symbols_.EURUSD = { ...fake.symbols_.EURUSD!, trade_mode: 3 }
    await assert.rejects(ex.placeMarket({ ...base, size: 0.1, stopPrice: 1.08 }), /close-only/)
    assert.equal(fake.sent.length, 0)
  })

  it('maps MT5 return codes: definite rejections vs. outcomes that need reconciliation', async () => {
    const { fake, ex } = setup()
    const order = (cid: string) => ex.placeMarket({ productId: 0, symbol: 'EURUSD', side: 'buy', size: 0.1, clientOrderId: cid, reduceOnly: false, stopPrice: 1.08, takePrice: null, tickSize: 0.00001 })
    fake.nextSend = 10019
    await assert.rejects(order('a'), (e: ProviderError) => e.kind === 'invalid_request' && /Not enough free margin/.test(e.message))
    fake.nextSend = 10027
    await assert.rejects(order('b'), /Algo Trading/)
    fake.nextSend = 10031
    await assert.rejects(order('c'), (e: ProviderError) => e.kind === 'network', 'no connection to the trade server: outcome unknown')
    assert.match(describeRetcode(99999).message, /Unrecognised/)
    assert.equal(describeRetcode(99999).unknown, true)
  })

  it('finds an order whose send timed out by its comment, and reports a lost one as absent', async () => {
    const { fake, ex } = setup()
    const req = { productId: 0, symbol: 'EURUSD', side: 'buy' as const, size: 0.2, reduceOnly: false, stopPrice: 1.08, takePrice: null, tickSize: 0.00001 }
    fake.nextSend = 'timeout_filled'
    await assert.rejects(ex.placeMarket({ ...req, clientOrderId: 'efilled' }), (e: ProviderError) => e.kind === 'timeout')
    const found = await ex.orderByClientId('efilled')
    assert.equal(found?.state, 'filled')
    assert.equal(found?.filled, 0.2)
    assert.ok(found?.positionTicket)
    fake.nextSend = 'timeout_lost'
    await assert.rejects(ex.placeMarket({ ...req, clientOrderId: 'elost' }))
    assert.equal(await ex.orderByClientId('elost'), null)
  })

  it('closes by position ticket and counts positions per account type', async () => {
    const { fake, ex, conn } = setup()
    const open = await ex.placeMarket({ productId: 0, symbol: 'EURUSD', side: 'buy', size: 0.3, clientOrderId: 'eopen', reduceOnly: false, stopPrice: 1.08, takePrice: null, tickSize: 0.00001 })
    // a manual trade on the same symbol (no magic number)
    fake.positions_.push({ ...fake.positions_[0]!, ticket: 9, magic: 0, volume: 1, type: 1, comment: 'manual' })
    assert.deepEqual(await ex.position(0, 'EURUSD'), { size: 0.3, entryPrice: 1.08512 }, 'hedging: only TradePilot positions')
    fake.account_ = { ...fake.account_, margin_mode: 0 }
    await conn.account()
    assert.equal((await ex.position(0, 'EURUSD'))!.size, -0.7, 'netting: the whole symbol')
    fake.account_ = { ...fake.account_, margin_mode: 2 }
    await conn.account()
    const close = await ex.placeMarket({ productId: 0, symbol: 'EURUSD', side: 'sell', size: 0.3, clientOrderId: 'xclose', reduceOnly: true, tickSize: 0.00001, positionTicket: open.positionTicket })
    const sent = fake.sent.at(-1)!
    assert.equal(sent.position, open.positionTicket)
    assert.equal(sent.sl, undefined)
    assert.equal(close.avgPrice, 1.085, 'sold at the bid')
    assert.deepEqual(await ex.position(0, 'EURUSD'), { size: 0, entryPrice: null })
  })

  it('reports closing deals in UTC with commission and swap as costs', async () => {
    const { fake, ex, clock } = setup(WED, SERVER_OFFSET_SEC)
    const open = await ex.placeMarket({ productId: 0, symbol: 'EURUSD', side: 'buy', size: 0.1, clientOrderId: 'eA', reduceOnly: false, stopPrice: 1.083, takePrice: null, tickSize: 0.00001 })
    clock.now += 60_000
    fake.hitStop(open.positionTicket!)
    const fills = await ex.fillsSince(0, WED, 'EURUSD')
    assert.equal(fills.length, 1)
    assert.deepEqual({ side: fills[0]!.side, size: fills[0]!.size, price: fills[0]!.price }, { side: 'sell', size: 0.1, price: 1.083 })
    assert.ok(Math.abs(fills[0]!.fee - 0.75) < 1e-9, '0.35 commission + 0.40 swap')
    assert.equal(fills[0]!.at, new Date(clock.now - (clock.now % 1000)).toISOString())
  })
})

describe('MetaTrader 5 automation (real engine, scripted terminal)', () => {
  let engine: EngineBridge
  before(async () => {
    engine = new EngineBridge(path.resolve(import.meta.dirname, '../../../engine'), () => 'python3')
    assert.equal((await engine.start()).state, 'ready')
  })
  after(() => engine.stop())

  const FX: StrategyDefinition = {
    version: 2, venue: 'mt5', name: 'EUR trend', description: '', symbol: 'EURUSD', timeframe: '1h', direction: 'long',
    indicators: [],
    entry: { long: { match: 'all', conditions: [{ left: { type: 'price', field: 'close' }, op: '>', right: { type: 'value', value: 0 } }] }, short: null },
    exit: { long: null, short: null },
    risk: { stopLoss: { type: 'pips', value: 25 }, takeProfit: { type: 'pips', value: 40 }, sizing: { type: 'risk_percent', value: 1 }, maxDailyLossPct: 5, maxTradesPerDay: 5, feeBps: 0 }
  }

  let env: ReturnType<typeof setup>
  let db: ReturnType<typeof memoryDb>
  let store: StrategyStore
  let deltaCalls: string[]
  beforeEach(() => {
    // the broker clock was learned earlier (it is remembered across restarts)
    env = setup(WED, SERVER_OFFSET_SEC)
    db = memoryDb()
    store = new StrategyStore(db, async (venue) => ({ instruments: venue === 'mt5' ? ['EURUSD', 'USDJPY'] : ['BTCUSD'] }))
    deltaCalls = []
  })

  const service = () => {
    const { market, fake, conn } = env
    const mt5: VenueDeps = {
      candles: (s, tf, d) => market.candles(s, tf, d),
      instruments: () => market.instruments(),
      instrument: (s) => market.instrument(s),
      markPrice: (s) => market.markPrice(s),
      quote: (s) => market.quote(s),
      isMarketOpen: (s) => market.isMarketOpen(s),
      liveExchange: () => env.ex,
      paperExchange: new PaperExchange((s) => market.markPrice(s), () => 0, () => 0, () => 0, (s) => market.quote(s)),
      liveAccount: async () => ({ equity: (await conn.account()).equity, available: null }),
      liveChecks: () => [{ id: 'mt5', label: 'MT5', ok: fake.connected || true, detail: 'ok' }],
      region: () => ({ id: 'mt5', label: 'MetaTrader 5 · Broker-Demo', testnet: true }),
      watchSymbols: () => {}
    }
    const unused = (name: string) => () => {
      deltaCalls.push(name)
      throw new Error(`Delta ${name} must not be used by an MT5 session`)
    }
    const deps: AutomationDeps = {
      db,
      now: () => env.clock.now,
      engine: (m, p) => engine.request(m, p, 30_000),
      strategy: (id) => store.get(id).catch(() => null),
      validate: (d) => store.validate(d),
      candles: unused('candles') as never,
      instruments: unused('instruments') as never,
      markPrice: unused('markPrice') as never,
      liveExchange: () => null,
      paperExchange: new PaperExchange(unused('paper') as never, () => 0, () => 5),
      liveAccount: unused('liveAccount') as never,
      liveChecks: () => [{ id: 'delta', label: 'Delta', ok: false, detail: 'Delta not connected.' }],
      region: () => ({ id: 'india', label: 'Delta Exchange India', testnet: false }),
      watchSymbols: () => {},
      venues: { mt5 },
      alert: () => {},
      onChange: () => {},
      sleep: async () => {}
    }
    return new AutomationService(deps)
  }
  const enabled = async (d: StrategyDefinition = FX) => store.setEnabled((await store.save(undefined, d)).id, true)
  const nextCandle = () => (env.clock.now += 3600_000)

  it('paper: sizes in lots from pips, buys at the ask and stops out at the bid', async () => {
    const svc = service()
    svc.saveRisk({ ...DEFAULT_RISK, configured: true, maxOrderNotionalUsd: 1_000_000, maxExposurePct: 500 })
    const s = await enabled()
    await svc.start(s.id, 'paper')
    nextCandle()
    await svc.tick()
    const o = await svc.overview({}, 'mt5')
    const sess = o.sessions[0]!
    assert.equal(sess.broker, 'mt5')
    // risk 1% of 10,000 over 25 pips (0.0025) at 100,000 per lot per 1.0 → 0.4 lots (43,400 notional, inside 500% exposure)
    assert.equal(sess.position?.contracts, 0.4)
    assert.equal(sess.position?.entryPrice, 1.08512)
    assert.equal(sess.position?.stopPrice, 1.08262, 'stop measured from the ask the buy fills at')
    assert.equal(sess.position?.takePrice, 1.08912)
    env.fake.setPrice('EURUSD', 1.0826) // bid below the stop
    await svc.tick()
    const after = await svc.overview({}, 'mt5')
    assert.equal(after.sessions[0]!.position, null)
    const t = after.trades[0]!
    assert.equal(t.broker, 'mt5')
    assert.equal(t.exitReason, 'stop_loss')
    assert.equal(t.exitPrice, 1.0826, 'closed at the bid')
    assert.ok(Math.abs(t.grossPnl - (1.0826 - 1.08512) * 0.4 * 100_000) < 1e-6)
    assert.deepEqual(deltaCalls, [], 'Delta untouched')
  })

  it('live: per-broker enable, order with stops at the broker, reconciliation after a broker stop-out', async () => {
    const svc = service()
    svc.saveRisk({ ...DEFAULT_RISK, configured: true, maxOrderNotionalUsd: 1_000_000, maxExposurePct: 500 })
    const s = await enabled()
    await assert.rejects(svc.start(s.id, 'live'), /turned off for MetaTrader 5/)
    svc.setLive(true, 'mt5')
    assert.equal(svc.liveEnabled('mt5').enabled, true)
    assert.equal(svc.liveEnabled('delta').enabled, false, 'enabling MT5 does not enable Delta')
    await env.conn.ensure()
    await svc.start(s.id, 'live')
    nextCandle()
    await svc.tick()
    const sent = env.fake.sent[0]!
    assert.deepEqual({ type: sent.type, volume: sent.volume, sl: sent.sl, tp: sent.tp, magic: sent.magic }, { type: 'buy', volume: 0.4, sl: 1.08262, tp: 1.08912, magic: MAGIC })
    assert.match(sent.comment!, /^e[0-9a-f]{30}$/)
    let sess = (await svc.overview({}, 'mt5')).sessions[0]!
    const ticket = sess.position!.ticket!
    assert.ok(ticket > 0)
    // a second tick on the same candle never sends again
    await svc.tick()
    assert.equal(env.fake.sent.length, 1)
    env.clock.now += 60_000
    env.fake.hitStop(ticket)
    await svc.reconcile()
    sess = (await svc.overview({}, 'mt5')).sessions[0]!
    assert.equal(sess.position, null)
    const t = (await svc.overview({}, 'mt5')).trades[0]!
    assert.equal(t.exitReason, 'stop_loss_on_exchange')
    assert.ok(Math.abs(t.fees - (1.4 + 1.4 + 0.4)) < 1e-6, 'entry + exit commission and swap')
    svc.setLive(false, 'mt5')
    assert.equal(svc.liveEnabled('mt5').enabled, false)
  })

  it('emergency stop closes MT5 positions by ticket', async () => {
    const svc = service()
    svc.saveRisk({ ...DEFAULT_RISK, configured: true, maxOrderNotionalUsd: 1_000_000, maxExposurePct: 500, emergencyAction: 'close_positions' })
    svc.setLive(true, 'mt5')
    await env.conn.ensure()
    const s = await enabled()
    await svc.start(s.id, 'live')
    nextCandle()
    await svc.tick()
    const ticket = (await svc.overview({}, 'mt5')).sessions[0]!.position!.ticket!
    await svc.emergencyStop()
    const close = env.fake.sent.at(-1)!
    assert.deepEqual({ type: close.type, position: close.position, volume: close.volume }, { type: 'sell', position: ticket, volume: 0.4 })
    assert.equal(env.fake.positions_.length, 0)
  })

  it('stays quiet and sends nothing while the market is closed', async () => {
    env = setup(SAT, SERVER_OFFSET_SEC)
    env.fake.frozen = true
    env.fake.tickTimeUtcMs = Date.UTC(2026, 5, 5, 20, 59, 0)
    const svc = service()
    svc.saveRisk({ ...DEFAULT_RISK, configured: true, maxOrderNotionalUsd: 1_000_000, maxExposurePct: 500 })
    const s = await enabled()
    await svc.start(s.id, 'paper')
    nextCandle()
    await svc.tick()
    nextCandle()
    await svc.tick()
    const o = await svc.overview({}, 'mt5')
    assert.equal(o.sessions[0]!.position, null)
    assert.equal(o.sessions[0]!.lastDecision?.reason, 'market closed')
    assert.equal(o.events.filter((e) => e.level !== 'info').length, 0, 'no warnings for a closed market')
  })

  it('records the broker on sessions and trades (migration 6 defaults existing rows to Delta)', async () => {
    const cols = db.prepare(`PRAGMA table_info(automation_sessions)`).all() as { name: string; dflt_value: string | null }[]
    assert.equal(cols.find((c) => c.name === 'broker')?.dflt_value, "'delta'")
    for (const t of ['auto_orders', 'auto_trades']) assert.ok((db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).some((c) => c.name === 'broker'), t)
    const idx = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'ux_automation_live_symbol'`).get() as { sql: string }
    assert.match(idx.sql, /\(broker, symbol\)/)
  })
})

describe('MetaTrader 5 bridge process (real protocol, fake MetaTrader5 package)', () => {
  const engineDir = path.resolve(import.meta.dirname, '../../../engine')
  let bridge: Mt5BridgeClient
  const logs: string[] = []
  before(() => {
    bridge = new Mt5BridgeClient({
      engineDir,
      bundledExecutable: null,
      python: () => 'python3',
      overrideCommand: { command: 'python3', args: ['-u', path.join(engineDir, 'tests', 'run_fake_mt5_bridge.py')], cwd: engineDir },
      log: (m) => logs.push(m)
    })
  })
  after(() => bridge.shutdown())

  it('refuses a wrong password without echoing it, then logs in', async () => {
    await assert.rejects(bridge.connect({ ...CREDS, password: 'wrong-secret-123' }), (e: unknown) => e instanceof ProviderError && e.kind === 'auth' && !e.message.includes('wrong-secret-123'))
    const { account, terminal } = await bridge.connect(CREDS)
    assert.equal(account.currency, 'USD')
    assert.equal(typeof terminal.trade_allowed, 'boolean')
    assert.ok(logs.every((l) => !l.includes('demo-pass') && !l.includes('wrong-secret-123')), 'passwords never logged')
  })

  it('reads symbols, ticks and bars, and sends an order with readable names', async () => {
    const syms = await bridge.symbols()
    const eur = syms.find((s) => s.name === 'EURUSD')!
    assert.equal(eur.volume_step, 0.01)
    const ticks = await bridge.ticks(['EURUSD', 'NOPE'])
    assert.ok(ticks.EURUSD!.ask > ticks.EURUSD!.bid)
    assert.equal(ticks.NOPE, null)
    const bars = await bridge.rates('EURUSD', '1h', 5)
    assert.equal(bars.length, 5)
    const sent = await bridge.orderSend({ action: 'deal', symbol: 'EURUSD', type: 'buy', volume: 0.1, deviation: 20, magic: MAGIC, comment: 'etest', filling: 'ioc', sl: 1.08, tp: 1.09 })
    assert.equal(sent.retcode, 10009)
    assert.deepEqual({ volume: sent.volume, price: sent.price }, { volume: 0.1, price: ticks.EURUSD!.ask }, 'a buy fills at the ask')
    assert.ok(Array.isArray(await bridge.positions({ magic: MAGIC })))
    assert.equal((await bridge.constants()).TRADE_RETCODE_DONE, 10009)
  })
})

describe('MetaTrader 5 audit regressions', () => {
  it('does not report a fill for 10008 PLACED without a deal', async () => {
    const { fake, ex } = setup(WED, SERVER_OFFSET_SEC)
    // a placed (not yet executed) order echoes the requested volume
    fake.orderSend = async (req) => ({ retcode: 10008, deal: 0, order: 4242, volume: req.volume!, price: 0, bid: 0, ask: 0, comment: 'Request placed', request_id: 1, retcode_external: 0 })
    const r = await ex.placeMarket({ productId: 0, symbol: 'EURUSD', side: 'buy', size: 0.1, clientOrderId: 'eplaced', reduceOnly: false, stopPrice: 1.083, takePrice: null, tickSize: 0.00001 })
    assert.deepEqual({ state: r.state, filled: r.filled }, { state: 'open', filled: 0 })
  })

  it('treats a broker timeout (10012) as unknown, to be looked up rather than assumed', async () => {
    const { fake, ex } = setup(WED, SERVER_OFFSET_SEC)
    fake.nextSend = 10012
    await assert.rejects(
      ex.placeMarket({ productId: 0, symbol: 'EURUSD', side: 'buy', size: 0.1, clientOrderId: 'etimeout', reduceOnly: false, stopPrice: 1.083, takePrice: null, tickSize: 0.00001 }),
      (e: unknown) => e instanceof ProviderError && e.kind === 'network'
    )
  })

  it('never sends a remove request for an executed market order', async () => {
    const { fake, ex } = setup(WED, SERVER_OFFSET_SEC)
    const r = await ex.placeMarket({ productId: 0, symbol: 'EURUSD', side: 'buy', size: 0.1, clientOrderId: 'ecancel', reduceOnly: false, stopPrice: 1.083, takePrice: null, tickSize: 0.00001 })
    const sends = fake.sent.length
    await ex.cancel(r.exchangeOrderId!)
    assert.equal(fake.sent.length, sends)
  })

  it('finds a manual close in the terminal through the position ticket', async () => {
    const { fake, ex, clock } = setup(WED, SERVER_OFFSET_SEC)
    const open = await ex.placeMarket({ productId: 0, symbol: 'EURUSD', side: 'buy', size: 0.1, clientOrderId: 'emanual', reduceOnly: false, stopPrice: 1.083, takePrice: null, tickSize: 0.00001 })
    clock.now += 60_000
    fake.hitStop(open.positionTicket!)
    fake.deals_.at(-1)!.magic = 0 // closed by hand: the closing deal carries no magic number
    assert.equal((await ex.fillsSince(0, WED, 'EURUSD')).length, 0, 'not visible by magic number')
    const fills = await ex.fillsSince(0, WED, 'EURUSD', open.positionTicket)
    assert.deepEqual(fills.map((f) => [f.side, f.size]), [['sell', 0.1]])
  })

  it('reports a broken terminal connection instead of calling the market closed', async () => {
    const { fake, market } = setup(WED, SERVER_OFFSET_SEC)
    assert.equal(await market.isMarketOpen('EURUSD'), true)
    fake.ticks = async () => {
      throw new ProviderError('provider', 'Terminal: IPC timeout')
    }
    await assert.rejects(market.isMarketOpen('EURUSD'), /IPC timeout/)
  })

  it('survives a bridge process that exits immediately (no unhandled EPIPE)', async () => {
    const dead = new Mt5BridgeClient({ engineDir: '/tmp', bundledExecutable: null, python: () => 'false', overrideCommand: { command: 'false', args: [], cwd: '/tmp' } })
    for (let i = 0; i < 3; i++) await assert.rejects(dead.account(), /bridge stopped|could not start/)
    await assert.rejects(dead.ticks(Array.from({ length: 50 }, () => 'X'.repeat(31))), /bridge stopped|could not start/)
  })
})
