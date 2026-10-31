import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'
import { EngineBridge } from '../src/main/engine.js'
import { GoldService } from '../src/main/gold/service.js'
import { Mt5Connection } from '../src/main/mt5/connection.js'
import { Mt5MarketData } from '../src/main/mt5/marketData.js'
import { tradeModeOf } from '../src/main/mt5/account.js'
import { ProviderError } from '../src/main/net.js'
import { StrategyStore } from '../src/main/strategies.js'
import { AutomationService, type VenueDeps } from '../src/main/trading/automation.js'
import { PaperExchange } from '../src/main/trading/exchange.js'
import { Mt5Exchange } from '../src/main/trading/mt5Exchange.js'
import { DEFAULT_GOLD_SETTINGS, detectGoldSymbols, goldDefinition, validateGoldSettings, type GoldSettings } from '../src/shared/gold.js'
import { requiredBars, validateDefinition } from '../src/shared/strategyRules.js'
import { DEFAULT_RISK } from '../src/shared/tradingRisk.js'
import { FakeMt5, fxSymbol, goldSymbol, SERVER_OFFSET_SEC } from './fakeMt5.js'
import { memoryDb } from './helpers.js'

const WED = Date.UTC(2026, 5, 3, 10, 0, 10)
const SAT = Date.UTC(2026, 5, 6, 12, 0, 10)
const BOT = 260901
const MANUAL = 260902
const CREDS = { login: '51234567', password: 'demo-pass', server: 'Broker-Demo' }
const sym = (symbol: string, description = '', underlying: string | null = null, quoteAsset: string | null = null, tradingStatus = '4') => ({ symbol, description, underlying, quoteAsset, tradingStatus })

describe('XAUUSD symbol detection', () => {
  it('finds the broker’s spot gold symbol whatever it is called', () => {
    for (const [list, expected] of [
      [[sym('EURUSD'), sym('XAUUSD', 'Gold vs US Dollar', 'XAU', 'USD')], 'XAUUSD'],
      [[sym('XAUUSDm', 'Gold', 'XAU', 'USD'), sym('XAGUSDm', 'Silver', 'XAG', 'USD')], 'XAUUSDm'],
      [[sym('GOLD', 'Spot Gold', 'XAU', 'USD'), sym('GOLDEUR', 'Gold in euro', 'XAU', 'EUR')], 'GOLD'],
      [[sym('XAUUSD.r'), sym('XAUUSD.pro', 'Gold')], 'XAUUSD.pro'],
      [[sym('XAUUSD#', 'Gold spot'), sym('GC.Z26', 'Gold futures Dec 2026')], 'XAUUSD#']
    ] as const) {
      assert.equal(detectGoldSymbols([...list])[0]?.symbol, expected, JSON.stringify(list.map((x) => x.symbol)))
    }
  })

  it('never picks gold in another currency, silver, futures or a disabled symbol', () => {
    assert.deepEqual(detectGoldSymbols([sym('XAUEUR', 'Gold vs Euro', 'XAU', 'EUR'), sym('XAGUSD', 'Silver', 'XAG', 'USD'), sym('EURUSD', 'Euro', 'EUR', 'USD')]), [])
    assert.deepEqual(detectGoldSymbols([sym('XAUUSD', 'Gold', 'XAU', 'USD', '0')]), [])
    const ranked = detectGoldSymbols([sym('XAUUSDZ26', 'Gold future'), sym('XAUUSD', 'Gold', 'XAU', 'USD')])
    assert.equal(ranked[0]!.symbol, 'XAUUSD')
    const closeOnly = detectGoldSymbols([sym('XAUUSD', 'Gold', 'XAU', 'USD', '3'), sym('GOLD', 'Gold', 'XAU', 'USD')])
    assert.equal(closeOnly[0]!.symbol, 'GOLD', 'a close-only symbol is a last resort')
  })
})

describe('Gold Bot settings and strategy', () => {
  it('generates a valid strategy for every reasonable combination of options', () => {
    const events = [{ start: '2026-06-05T12:25:00Z', end: '2026-06-05T13:15:00Z', label: 'US jobs report' }]
    const combos: Partial<GoldSettings>[] = [{}, { useMacd: false }, { useRsi: false, useCandleConfirmation: false }, { entryStyle: 'breakout' }, { entryStyle: 'momentum', useMacd: false }, { direction: 'long' }, { lotMode: 'fixed' }, { session: null }, { timeframe: '1m' }, { trendTimeframe: '1h' }, { useVwap: true }, { useTrendFilter: false }, { events }]
    for (const over of combos) {
      const s: GoldSettings = { ...DEFAULT_GOLD_SETTINGS, ...over }
      assert.deepEqual(validateGoldSettings(s), {})
      const d = goldDefinition(s, 'XAUUSDm')
      const v = validateDefinition(d, { instruments: ['XAUUSDm'] })
      assert.deepEqual(v.errors, [], JSON.stringify(over))
      assert.equal(d.venue, 'mt5')
      assert.equal(d.risk.stopLoss?.type, 'atr', 'no forex pips in the gold workflow')
      assert.ok(d.entry.long!.conditions.length >= 3, 'never one indicator alone')
    }
    const d = goldDefinition(DEFAULT_GOLD_SETTINGS, 'XAUUSD')
    assert.deepEqual(d.indicators.filter((i) => i.timeframe).map((i) => [i.id, i.timeframe]), [['trend_ema_20', '15m'], ['trend_ema_50', '15m']])
    assert.deepEqual({ cooldown: d.risk.cooldownBars, maxBars: d.risk.maxTradeBars, streak: d.risk.maxConsecutiveLosses }, { cooldown: 2, maxBars: 12, streak: 3 }, '10 min / 60 min on M5')
    assert.ok(requiredBars(d) >= 480, 'enough M5 candles for an M15 EMA 50')
  })

  it('rejects unsafe or impossible settings', () => {
    const e = validateGoldSettings({ ...DEFAULT_GOLD_SETTINGS, riskPercent: 1.5, maxDailyLossPct: 1, maxSpread: 0, session: { start: '25:00', end: '20:00' }, fixedLots: 0, takeProfitR: 1, minRiskReward: 1.5, events: [{ start: '2026-06-05T13:00:00Z', end: '2026-06-05T12:00:00Z', label: 'x' }] })
    assert.ok(e.riskPercent && e.maxSpread && e.session && e.fixedLots && e.takeProfitR && e.events)
    assert.ok(validateGoldSettings({ ...DEFAULT_GOLD_SETTINGS, timeframe: '15m' as '5m' }).timeframe, 'scalping entries are M1/M5 only')
  })
})

describe('Gold engine: MACD, filters, broker lot rules, commission', () => {
  let engine: EngineBridge
  before(async () => {
    engine = new EngineBridge(path.resolve(import.meta.dirname, '../../../engine'), () => 'python3')
    assert.equal((await engine.start()).state, 'ready')
  })
  after(() => engine.stop())

  // a gold-like hourly series: trending legs with pullbacks, spread $0.30
  // gold-like M5 candles: a seeded random walk with trending regimes, spread $0.30, aligned to 00:00 UTC
  const T0 = 1_780_000_000 - (1_780_000_000 % 86400)
  const series = (n = 3000, seed = 7) => {
    let x = seed
    const rnd = () => (x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296
    const out = []
    let p = 2600
    let drift = 0
    for (let i = 0; i < n; i++) {
      if (i % 150 === 0) drift = (rnd() - 0.5) * 0.5
      const o = p
      const c = p + drift + (rnd() - 0.5) * 1.6
      out.push({ time: T0 + i * 300, open: o, high: Math.max(o, c) + rnd() * 0.6, low: Math.min(o, c) - rnd() * 0.6, close: c, spread: 0.3, volume: 50 + Math.floor(rnd() * 100) })
      p = c
    }
    return out
  }

  it('backtests the Gold strategy with spread, per-lot commission and the broker’s lot step', async () => {
    const d = goldDefinition({ ...DEFAULT_GOLD_SETTINGS, session: null, maxSpread: 1, maxTradesPerDay: 50 }, 'XAUUSD')
    const params = { definition: d, candles: series(), initialEquity: 10_000, slippageBps: 1, pointValue: 1, unitsPerLot: 100, volumeStep: 0.01, volumeMin: 0.01, volumeMax: 100, extraMetrics: true }
    const free = await engine.request<{ metrics: Record<string, number>; trades: { quantity: number; pnl: number }[] }>('backtest_rules', { ...params, commissionPerLot: 0 })
    const paid = await engine.request<{ metrics: Record<string, number>; trades: { quantity: number }[] }>('backtest_rules', { ...params, commissionPerLot: 3.5 })
    assert.ok(free.metrics.trades! > 0, 'the strategy trades on a trending series')
    for (const t of free.trades) {
      const lots = t.quantity / 100
      assert.ok(Math.abs(lots * 100 - Math.round(lots * 100)) < 1e-6, `lots ${lots} on the 0.01 step`)
    }
    assert.ok(paid.metrics.totalFees! > free.metrics.totalFees!, 'commission per lot is charged')
    for (const k of ['winRatePct', 'profitFactor', 'maxDrawdownPct', 'netPnl', 'avgTradeDurationSec', 'avgWin', 'avgLoss', 'maxConsecutiveWins', 'timeExits']) assert.ok(k in free.metrics, k)
    assert.ok(free.metrics.avgTradeDurationSec! <= 12 * 300, 'no trade outlives the maximum duration (12 M5 candles)')
    assert.equal(free.metrics.signalsSkippedSpread, 0)
  })

  it('skips entries when the spread is too wide or outside the session', async () => {
    // fewer confirmations, so the series gives several signals
    const g = (over: Partial<GoldSettings>) => goldDefinition({ ...DEFAULT_GOLD_SETTINGS, useRsi: false, useCandleConfirmation: false, maxTradesPerDay: 50, cooldownMinutes: 0, maxExtensionAtr: 10, abnormalRangeAtr: 20, ...over }, 'XAUUSD')
    const base = { candles: series(3000, 42), initialEquity: 10_000, pointValue: 1, unitsPerLot: 100 }
    const all = await engine.request<{ metrics: Record<string, number> }>('backtest_rules', { ...base, definition: g({ session: null, maxSpread: 1 }) })
    const wide = await engine.request<{ metrics: Record<string, number> }>('backtest_rules', { ...base, definition: g({ session: null, maxSpread: 0.1 }) })
    const session = await engine.request<{ metrics: Record<string, number> }>('backtest_rules', { ...base, definition: g({ session: { start: '08:00', end: '12:00' }, maxSpread: 1 }) })
    assert.equal(wide.metrics.trades, 0)
    assert.ok(wide.metrics.signalsSkippedSpread! > 0)
    assert.ok(session.metrics.trades! < all.metrics.trades!)
    assert.ok(session.metrics.signalsSkippedSession! > 0)
  })

  it('reads the market: trend, MACD, ATR, support and resistance from closed candles', async () => {
    const a = await engine.request<Record<string, unknown>>('market_analysis', { candles: series(400), emas: [9, 20, 50] })
    assert.ok(['up', 'down', 'sideways'].includes(a.trend as string))
    assert.equal(typeof (a.macd as { line: number }).line, 'number')
    assert.ok((a.atr as number) > 0)
    assert.equal(a.enoughHistory, true)
    assert.ok(['low', 'normal', 'high', 'extreme'].includes(a.volatility as string))
    assert.equal(typeof a.vwap, 'number', 'VWAP from tick volume')
    await assert.rejects(engine.request('market_analysis', { candles: series(20) }), /at least 50/)
  })
})

describe('Gold Bot with a scripted MT5 terminal and the real engine', () => {
  let engine: EngineBridge
  before(async () => {
    engine = new EngineBridge(path.resolve(import.meta.dirname, '../../../engine'), () => 'python3')
    assert.equal((await engine.start()).state, 'ready')
  })
  after(() => engine.stop())

  const setup = (start = WED) => {
    const clock = { now: start }
    const fake = new FakeMt5(() => clock.now)
    fake.symbols_ = { XAUUSDm: goldSymbol({ name: 'XAUUSDm' }), XAUEUR: goldSymbol({ name: 'XAUEUR', description: 'Gold vs Euro', currency_profit: 'EUR' }), EURUSD: fxSymbol() }
    let offset: number | null = SERVER_OFFSET_SEC
    const conn = new Mt5Connection(fake, () => CREDS, { get: () => offset, set: (v) => (offset = v) }, () => clock.now)
    const market = new Mt5MarketData({ conn, settings: () => ({ staleAfterSec: 15 }), onSnapshot: () => {}, onCandle: () => {}, now: () => clock.now, sleep: async (ms) => void (clock.now += ms) })
    const db = memoryDb()
    const store = new StrategyStore(db, async (venue) => ({ instruments: venue === 'mt5' ? (await market.instruments()).map((i) => i.symbol) : ['BTCUSD'] }))
    const botEx = new Mt5Exchange(conn, { magic: BOT, deviationPoints: 30, now: () => clock.now })
    const manualEx = new Mt5Exchange(conn, { magic: MANUAL, deviationPoints: 30, now: () => clock.now })
    const mt5: VenueDeps = {
      candles: (s, tf, d) => market.candles(s, tf, d, true),
      instruments: () => market.instruments(),
      instrument: (s) => market.instrument(s),
      markPrice: (s) => market.markPrice(s),
      quote: (s) => market.quote(s),
      isMarketOpen: (s) => market.isMarketOpen(s),
      liveExchange: () => botEx,
      paperExchange: new PaperExchange((s) => market.markPrice(s), () => 0, () => 0, () => 0, (s) => market.quote(s)),
      liveAccount: async () => ({ equity: (await conn.account()).equity, available: null }),
      liveChecks: () => [{ id: 'mt5', label: 'MT5', ok: true, detail: 'ok' }],
      region: () => ({ id: 'mt5', label: 'MetaTrader 5 · Broker-Demo', testnet: true }),
      watchSymbols: () => {},
      accountIdentity: async () => {
        const a = await conn.account()
        return { login: String(a.login), mode: tradeModeOf(a) }
      }
    }
    const fail = () => {
      throw new Error('Delta must not be used')
    }
    const automation = new AutomationService({
      db, now: () => clock.now, engine: (m, p) => engine.request(m, p, 30_000), strategy: (id) => store.get(id).catch(() => null), validate: (d) => store.validate(d),
      candles: fail as never, instruments: fail as never, markPrice: fail as never, liveExchange: () => null, paperExchange: new PaperExchange(fail as never, () => 0, () => 0), liveAccount: fail as never,
      liveChecks: () => [], region: () => ({ id: 'india', label: 'Delta', testnet: false }), watchSymbols: () => {}, venues: { mt5 }, alert: () => {}, onChange: () => {}, sleep: async () => {}
    })
    automation.saveRisk({ ...DEFAULT_RISK, configured: true, maxOrderNotionalUsd: 100_000, maxExposurePct: 500, maxOpenPositions: 2 })
    const gold = new GoldService({ db, now: () => clock.now, conn, market, automation, strategies: store, engine: (m, p) => engine.request(m, p, 30_000), manualExchange: () => manualEx, botMagic: BOT, manualMagic: MANUAL, configured: () => true })
    return { clock, fake, conn, market, db, store, automation, gold }
  }
  let env: ReturnType<typeof setup>
  beforeEach(() => {
    env = setup()
  })
  const buy = () => env.gold.manualOrder('buy', randomUUID())

  it('detects the broker symbol and shows price, spread, specs, account, analysis and signal', async () => {
    const st = await env.gold.status()
    assert.equal(st.symbol, 'XAUUSDm')
    assert.equal(st.symbolSource, 'detected')
    assert.equal(st.connected, true)
    assert.deepEqual({ bid: st.quote!.bid, ask: st.quote!.ask, spread: st.quote!.spread }, { bid: 2650, ask: 2650.25, spread: 0.25 })
    assert.deepEqual({ min: st.spec!.volumeMin, step: st.spec!.volumeStep, contract: st.spec!.contractSize, vpp: st.spec!.valuePerPoint }, { min: 0.01, step: 0.01, contract: 100, vpp: 100 })
    assert.equal(st.account!.mode, 'demo')
    assert.equal(st.accountModeProblem, null)
    assert.ok(st.analysis, st.analysisError ?? '')
    assert.ok(st.signal, st.signalError ?? '')
    assert.ok(st.bot.strategyId, st.bot.strategyProblem ?? '')
    const strat = await env.store.get(st.bot.strategyId!)
    assert.equal(strat.status, 'enabled')
    assert.equal(strat.symbol, 'XAUUSDm')
  })

  it('never trades until automatic trading is switched on', async () => {
    await assert.rejects(buy(), /automatic trading is off/)
    assert.equal(env.fake.sent.length, 0)
  })

  it('demo mode: BUY and SELL on a demo account, sized from risk with SL/TP at the broker', async () => {
    env.automation.setLive(true, 'mt5')
    const b = await buy()
    assert.equal(b.state, 'filled')
    assert.equal(b.accountMode, 'demo')
    const sent = env.fake.sent.at(-1)!
    // risk 0.25% of 10,000 = 25; ATR(14) of the scripted bars = 2.65; stop 1.2 × ATR = 3.18 → 25 / (3.18 × 100) = 0.0786 → 0.07 (rounded down)
    assert.equal(sent.volume, 0.07)
    assert.equal(sent.magic, MANUAL)
    assert.ok(sent.sl! < 2650.25 && sent.tp! > 2650.25, 'stop below and target above the ask')
    assert.ok(Math.abs(sent.tp! - 2650.25 - 1.5 * (2650.25 - sent.sl!)) < 0.02, '1.5R target')
    const s = await env.gold.manualOrder('sell', randomUUID())
    assert.equal(s.state, 'filled')
    assert.equal(s.volume, 0.07)
    const st = await env.gold.status()
    assert.equal(st.positions.filter((p) => p.source === 'manual').length, 2)
    assert.equal(st.stats.todayTrades, 2)
  })

  it('shrinks an order to fit the exposure limit and says so; never enlarges it', async () => {
    env.automation.setLive(true, 'mt5')
    env.automation.saveRisk({ ...env.automation.risk(), maxExposurePct: 100 })
    const o = await buy()
    // 100% of 10,000 / (2650.25 × 100 per lot) = 0.0377 → 0.03
    assert.equal(o.volume, 0.03)
    assert.match(o.note!, /reduced from 0.07 to 0.03 lots by your exposure limit/)
  })

  it('a repeated click (same request) never sends a second order', async () => {
    env.automation.setLive(true, 'mt5')
    const id = randomUUID()
    const [a, b] = await Promise.all([env.gold.manualOrder('buy', id), env.gold.manualOrder('buy', id)])
    assert.equal(a.id, b.id)
    assert.equal(env.fake.sent.filter((r) => r.action === 'deal').length, 1)
  })

  it('refuses orders the risk settings or the broker would not allow', async () => {
    env.automation.setLive(true, 'mt5')
    // demo mode with a real-money account
    env.fake.account_ = { ...env.fake.account_, trade_mode: 2 }
    await assert.rejects(buy(), /REAL-MONEY/)
    env.fake.account_ = { ...env.fake.account_, trade_mode: 0 }
    // spread above the maximum
    env.fake.setPrice('XAUUSDm', 2650, 0.9)
    await assert.rejects(buy(), /spread/)
    env.fake.setPrice('XAUUSDm', 2650, 0.25)
    // a fixed lot off the broker's step is refused, not rounded
    await env.gold.saveSettings({ ...env.gold.settings(), lotMode: 'fixed', fixedLots: 0.015 })
    await assert.rejects(buy(), /not valid/)
    await env.gold.saveSettings({ ...env.gold.settings(), lotMode: 'fixed', fixedLots: 0.01 })
    // risk too small for the minimum lot
    await env.gold.saveSettings({ ...env.gold.settings(), lotMode: 'risk', riskPercent: 0.01 })
    await assert.rejects(buy(), /below the minimum of 0.01/)
    await env.gold.saveSettings({ ...env.gold.settings(), riskPercent: 0.5 })
    // max open positions (2)
    assert.equal((await buy()).state, 'filled')
    assert.equal((await buy()).state, 'filled')
    await assert.rejects(buy(), /maximum of 2 open positions/)
    // order value above the maximum order size
    env.automation.saveRisk({ ...env.automation.risk(), maxOrderNotionalUsd: 1000, maxOpenPositions: 5 })
    await assert.rejects(buy(), /maximum order size/)
    // emergency stop blocks everything
    env.automation.saveRisk({ ...env.automation.risk(), maxOrderNotionalUsd: 100_000 })
    await env.automation.emergencyStop()
    await assert.rejects(buy(), /emergency stop/)
  })

  it('closes one position, changes SL/TP, and closes all TradePilot positions but not others', async () => {
    env.automation.setLive(true, 'mt5')
    await buy()
    await buy()
    // a position opened elsewhere (another EA or by hand)
    env.fake.positions_.push({ ...env.fake.positions_[0]!, ticket: 9999, identifier: 9999, magic: 0 })
    let st = await env.gold.status()
    const [first, second] = st.positions.filter((p) => p.source === 'manual')
    await env.gold.modifyPosition(first!.id, 2640, 2670)
    assert.deepEqual([env.fake.positions_.find((p) => p.ticket === first!.ticket)!.sl, env.fake.positions_.find((p) => p.ticket === first!.ticket)!.tp], [2640, 2670])
    await assert.rejects(env.gold.modifyPosition(first!.id, 2655, null), /below the current price/)
    await env.gold.closePosition(second!.id)
    await assert.rejects(env.gold.closePosition('9999'), /not opened by TradePilot/)
    const r = await env.gold.closeAll()
    assert.deepEqual(r, { closed: 1, failed: [] })
    st = await env.gold.status()
    assert.deepEqual(st.positions.map((p) => p.source), ['other'])
  })

  it('reports connection failures and refuses to trade while disconnected', async () => {
    env.automation.setLive(true, 'mt5')
    env.fake.password = 'changed'
    const st = await env.gold.status()
    assert.equal(st.connected, false)
    assert.match(st.connectionError!, /Authorization failed/)
    await assert.rejects(buy(), /not connected/)
    env.fake.password = 'demo-pass'
    await env.gold.disconnect()
    assert.equal((await env.gold.status()).userDisconnected, true)
    await assert.rejects(buy(), /not connected/)
    await env.gold.connect()
    assert.equal((await env.gold.status()).connected, true)
  })

  it('market data interruption: no orders while the market is closed or prices stop', async () => {
    env = setup(SAT)
    env.automation.setLive(true, 'mt5')
    env.fake.frozen = true
    env.fake.tickTimeUtcMs = Date.UTC(2026, 5, 5, 20, 59, 0)
    const st = await env.gold.status()
    assert.equal(st.quote?.state, 'closed')
    await assert.rejects(buy(), /market is closed/)
    // the terminal stops answering during the week
    env = setup(WED)
    env.automation.setLive(true, 'mt5')
    env.fake.ticks = async () => {
      throw new ProviderError('network', 'IPC timeout')
    }
    await assert.rejects(buy())
    assert.equal(env.fake.sent.length, 0)
  })

  it('the bot runs in paper mode until automatic trading is on, then only on the selected account type', async () => {
    await env.gold.startBot()
    let st = await env.gold.status()
    assert.equal(st.bot.session?.mode, 'paper')
    await env.gold.stopBot(false)
    env.automation.setLive(true, 'mt5')
    env.fake.account_ = { ...env.fake.account_, trade_mode: 2 }
    await assert.rejects(env.gold.startBot(), /REAL-MONEY/)
    env.fake.account_ = { ...env.fake.account_, trade_mode: 0 }
    await env.gold.startBot()
    st = await env.gold.status()
    assert.equal(st.bot.session?.mode, 'live')
    await assert.rejects(env.gold.disconnect(), /Stop the bot first/)
    // the terminal is switched to a real account while the bot runs: the next entry is refused and the bot paused
    env.fake.account_ = { ...env.fake.account_, login: 99999999, trade_mode: 2 }
    const sid = st.bot.session!.id
    const guarded = (env.automation as unknown as { accountProblem: (s: unknown) => Promise<string | null> }).accountProblem
    const row = env.db.prepare('SELECT * FROM automation_sessions WHERE id = ?').get(sid)
    assert.match((await guarded.call(env.automation, row))!, /99999999/)
  })

  it('switching to live mode needs an explicit confirmation', async () => {
    await assert.rejects(env.gold.saveSettings({ ...env.gold.settings(), accountMode: 'live' }), /confirmation/)
    await env.gold.saveSettings({ ...env.gold.settings(), accountMode: 'live' }, true)
    assert.equal(env.gold.settings().accountMode, 'live')
    env.automation.setLive(true, 'mt5')
    await assert.rejects(buy(), /demo account/, 'live mode refuses a demo account')
  })
})

describe('migration 7 repair', () => {
  it('upgrades a database that applied the earlier migration 7 (without manual_orders.note)', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const { MIGRATIONS, migrate } = await import('../src/main/db.js')
    const db = new DatabaseSync(':memory:')
    const m7 = MIGRATIONS.find((m) => m.version === 7)!
    const early = { ...m7, sql: m7.sql.replace(/\n  -- e\.g\. "size reduced[^\n]*\n  note TEXT,/, '') }
    assert.notEqual(early.sql, m7.sql)
    migrate(db as never, [...MIGRATIONS.filter((m) => m.version < 7), early])
    const cols = () => (db.prepare('PRAGMA table_info(manual_orders)').all() as { name: string }[]).map((c) => c.name)
    assert.ok(!cols().includes('note'))
    assert.deepEqual(migrate(db as never), [])
    assert.ok(cols().includes('note'))
    assert.deepEqual(migrate(db as never), [], 'the repaired checksum is accepted afterwards')
  })
})
