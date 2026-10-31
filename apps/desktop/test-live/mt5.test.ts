/**
 * MetaTrader 5 against a real terminal and a DEMO account: `npm run test:live -w @tradepilot/desktop`.
 * Windows only, with the MT5 terminal installed and `pip install -r engine/requirements-mt5.txt`.
 * Skipped (not faked) unless these are set:
 *   MT5_LOGIN, MT5_PASSWORD, MT5_SERVER, optional MT5_TERMINAL_PATH, MT5_PYTHON (default "python"),
 *   MT5_SYMBOL (default: the broker's detected gold symbol — XAUUSD, XAUUSDm, GOLD, …)
 * Order round trip (opens and closes the symbol's minimum volume) only with TRADEPILOT_MT5_ORDER_TEST=1.
 * Refuses to run against anything but a demo account.
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { Mt5BridgeClient } from '../src/main/mt5/client.js'
import { Mt5Connection } from '../src/main/mt5/connection.js'
import { isForexWeekend, Mt5MarketData } from '../src/main/mt5/marketData.js'
import { Mt5Exchange } from '../src/main/trading/mt5Exchange.js'
import { detectGoldSymbols } from '../src/shared/gold.js'

const env = process.env
const configured = Boolean(env.MT5_LOGIN && env.MT5_PASSWORD && env.MT5_SERVER)
const skip = process.platform !== 'win32' ? 'MetaTrader 5 needs Windows' : !configured ? 'set MT5_LOGIN, MT5_PASSWORD and MT5_SERVER (demo account)' : false
let SYMBOL = env.MT5_SYMBOL ?? ''
const MAGIC = 260901
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('MetaTrader 5 (real terminal, demo account)', { skip }, () => {
  const engineDir = path.resolve(import.meta.dirname, '../../../engine')
  let offset: number | null = null
  let client: Mt5BridgeClient
  let conn: Mt5Connection
  let market: Mt5MarketData

  before(async () => {
    client = new Mt5BridgeClient({ engineDir, bundledExecutable: null, python: () => env.MT5_PYTHON ?? 'python' })
    conn = new Mt5Connection(
      client,
      () => ({ login: env.MT5_LOGIN!, password: env.MT5_PASSWORD!, server: env.MT5_SERVER!, ...(env.MT5_TERMINAL_PATH ? { path: env.MT5_TERMINAL_PATH } : {}) }),
      { get: () => offset, set: (v) => (offset = v) },
      undefined,
      (m) => console.log(`  ${m}`)
    )
    market = new Mt5MarketData({ conn, settings: () => ({ staleAfterSec: 15 }), onSnapshot: () => {}, onCandle: () => {} })
    await conn.ensure()
    const a = await conn.account()
    // trade_mode 0 = ACCOUNT_TRADE_MODE_DEMO
    assert.equal(a.trade_mode, 0, `refusing to test against a non-demo account (${a.server} ${a.login})`)
  })
  after(() => client.shutdown())

  it('detects the broker’s gold symbol and reads its contract specification and M1 candles', async () => {
    const list = await market.instruments(true)
    const candidates = detectGoldSymbols(list)
    console.log(`  gold candidates: ${candidates.map((c) => `${c.symbol} (${c.score}: ${c.reasons.join(', ')})`).join(' · ') || 'none'}`)
    assert.ok(candidates.length > 0, 'no spot gold symbol in USD at this broker')
    SYMBOL ||= candidates[0]!.symbol
    const inst = await market.instrument(candidates[0]!.symbol)
    console.log(`  ${inst.symbol}: digits ${inst.digits}, tick ${inst.tickSize}, contract ${inst.contractSize}, value per 1.0 move per lot ${inst.valuePerPoint} ${inst.quoteAsset}, lots ${inst.volumeMin}–${inst.volumeMax} step ${inst.volumeStep}, min stop distance ${inst.minStopDistance}`)
    assert.ok((inst.valuePerPoint ?? 0) > 0 && (inst.volumeStep ?? 0) > 0)
    if (!isForexWeekend(Date.now())) {
      const m1 = await market.series(inst.symbol, '1m', 1)
      assert.ok(m1.candles.length > 100, 'M1 history available')
      console.log(`  ${m1.candles.length} M1 candles; last spread ${m1.candles.at(-1)!.spread}`)
    }
  })

  it('logs in, reads the account and terminal, and lists symbols with lot specs', async () => {
    const [a, t] = await Promise.all([conn.account(), conn.terminal()])
    console.log(`  ${a.server} (${a.company}) login ${a.login}, ${a.currency}, leverage 1:${a.leverage}, margin mode ${a.margin_mode}; terminal build ${t.build}, algo trading ${t.trade_allowed && a.trade_expert}`)
    const list = await market.instruments(true)
    const inst = list.find((i) => i.symbol === SYMBOL)
    assert.ok(inst, `${SYMBOL} not offered by this broker; set MT5_SYMBOL (first symbols: ${list.slice(0, 10).map((i) => i.symbol).join(', ')})`)
    console.log(`  ${list.length} symbols; ${SYMBOL}: digits ${inst.digits}, pip ${inst.pipSize}, value/point ${inst.valuePerPoint}, lots ${inst.volumeMin}–${inst.volumeMax} step ${inst.volumeStep}`)
    assert.ok((inst.volumeStep ?? 0) > 0 && (inst.volumeMin ?? 0) > 0)
  })

  it('reads live bid/ask, learns the server clock, and returns closed candles in UTC', { skip: isForexWeekend(Date.now()) ? 'forex market closed (weekend)' : false }, async () => {
    for (let i = 0; i < 15 && conn.serverOffset() === null; i++) {
      await market.tickers([SYMBOL])
      await sleep(2000)
    }
    assert.notEqual(conn.serverOffset(), null, 'server time offset learned from moving ticks')
    console.log(`  broker server time UTC${conn.serverOffset()! >= 0 ? '+' : ''}${conn.serverOffset()! / 3600}h`)
    const q = await market.quote(SYMBOL)
    assert.ok(q.ask >= q.bid && q.bid > 0)
    const s = await market.series(SYMBOL, '1h', 3, true)
    const last = s.candles.at(-1)!
    assert.ok(last.time + 3600 <= Date.now() / 1000 + 5, 'newest candle is closed')
    assert.ok(Date.now() / 1000 - last.time < 3 * 3600 + 600, `newest candle is recent in UTC (${new Date(last.time * 1000).toISOString()})`)
  })

  it('opens and closes the minimum volume with SL/TP at the broker', { skip: env.TRADEPILOT_MT5_ORDER_TEST === '1' ? false : 'set TRADEPILOT_MT5_ORDER_TEST=1 to send demo orders' }, async () => {
    assert.equal((await conn.account()).trade_mode, 0)
    const inst = await market.instrument(SYMBOL)
    const ex = new Mt5Exchange(conn, { magic: MAGIC, deviationPoints: 50 })
    const q = await market.quote(SYMBOL)
    // a distance every broker accepts: well beyond the spread and the minimum stop distance (no forex pips)
    const dist = Math.max((inst.minStopDistance ?? 0) * 3, (q.ask - q.bid) * 10, inst.tickSize * 200)
    const started = Date.now()
    const id = `e${randomBytes(15).toString('hex')}`
    const open = await ex.placeMarket({ productId: 0, symbol: SYMBOL, side: 'buy', size: inst.volumeMin!, clientOrderId: id, reduceOnly: false, stopPrice: q.bid - dist, takePrice: q.ask + dist, tickSize: inst.tickSize })
    console.log(`  open: ${open.state} ${open.filled} @ ${open.avgPrice}, position ${open.positionTicket}${open.note ? ` (${open.note})` : ''}`)
    assert.equal(open.state, 'filled')
    assert.ok(open.positionTicket)
    const found = await ex.orderByClientId(id)
    assert.equal(found?.exchangeOrderId, open.exchangeOrderId, 'order found again by its client id (duplicate protection)')
    const close = await ex.placeMarket({ productId: 0, symbol: SYMBOL, side: 'sell', size: open.filled, clientOrderId: `x${randomBytes(15).toString('hex')}`, reduceOnly: true, tickSize: inst.tickSize, positionTicket: open.positionTicket })
    console.log(`  close: ${close.state} @ ${close.avgPrice}`)
    assert.equal(close.state, 'filled')
    await sleep(1000)
    const fills = await ex.fillsSince(0, started - 60_000, SYMBOL)
    assert.ok(fills.some((f) => f.side === 'sell'), 'closing deal reported')
  })
})
