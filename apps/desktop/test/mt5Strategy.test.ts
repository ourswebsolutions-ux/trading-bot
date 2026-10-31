import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { crossCheck, INTERPRETATION_SCHEMA, interpretationSchema, systemPrompt, toDefinition } from '../src/main/ai/strategyInterpreter.js'
import { StrategyStore } from '../src/main/strategies.js'
import { describeSizingFor, describeStop, emptyDefinition, explainDefinition, SYMBOL_PATTERN, validateDefinition, venueOf, type StrategyDefinition } from '../src/shared/strategyRules.js'
import { memoryDb } from './helpers.js'

const FX: StrategyDefinition = {
  version: 2, venue: 'mt5', name: 'EUR trend', description: '', symbol: 'EURUSD.m', timeframe: '1h', direction: 'long',
  indicators: [{ id: 'ema_20', kind: 'ema', period: 20 }],
  entry: { long: { match: 'all', conditions: [{ left: { type: 'price', field: 'close' }, op: 'crosses_above', right: { type: 'indicator', id: 'ema_20' } }] }, short: null },
  exit: { long: null, short: null },
  risk: { stopLoss: { type: 'pips', value: 25 }, takeProfit: { type: 'pips', value: 50 }, sizing: { type: 'fixed_quantity', value: 0.1 }, maxDailyLossPct: 3, maxTradesPerDay: 3, feeBps: 0 }
}
const enumOf = (schema: Record<string, unknown>, field: 'stopLoss' | 'takeProfit') =>
  JSON.stringify((schema as { properties: { strategy: { properties: Record<string, unknown> } } }).properties.strategy.properties[field])

describe('MetaTrader 5 strategies', () => {
  it('validates pips and broker-specific symbols on MT5 only', () => {
    assert.equal(venueOf(FX), 'mt5')
    assert.equal(venueOf({ ...FX, venue: undefined }), 'delta', 'no venue = Delta (older strategies)')
    assert.deepEqual(validateDefinition(FX, { instruments: ['EURUSD.m', 'GBPUSD.m'] }).errors, [])
    const onDelta = validateDefinition({ ...FX, venue: undefined, symbol: 'BTCUSD' }, { instruments: ['BTCUSD'] })
    assert.ok(onDelta.errors.some((e) => e.path.startsWith('risk.stopLoss')), 'pips are not a Delta unit')
    assert.ok(SYMBOL_PATTERN.mt5.test('XAUUSD#') && SYMBOL_PATTERN.mt5.test('EURUSD.m'))
    assert.ok(!SYMBOL_PATTERN.delta.test('EURUSD.m'))
    assert.ok(validateDefinition({ ...FX, symbol: 'EURUSD' }, { instruments: ['EURUSD.m'] }).errors.some((e) => e.path === 'symbol'), 'symbol must exist at the broker')
  })

  it('describes MT5 risk in pips and lots', () => {
    assert.match(describeStop(FX.risk.stopLoss), /25 pips/)
    assert.match(describeSizingFor(FX.risk, 'mt5'), /0\.1 lots/)
    assert.ok(explainDefinition(FX).risk.some((t) => /lot/.test(t)))
    const blank = emptyDefinition('EURUSD', 'mt5')
    assert.deepEqual({ venue: blank.venue, symbol: blank.symbol, fee: blank.risk.feeBps }, { venue: 'mt5', symbol: 'EURUSD', fee: 0 })
    assert.equal(emptyDefinition('BTCUSD').venue, undefined, 'Delta definitions are unchanged')
  })

  it('gives the AI an MT5 schema and prompt while Delta stays as before', () => {
    assert.equal(interpretationSchema('delta'), INTERPRETATION_SCHEMA)
    assert.ok(!enumOf(INTERPRETATION_SCHEMA, 'stopLoss').includes('pips'))
    assert.ok(enumOf(interpretationSchema('mt5'), 'stopLoss').includes('pips'))
    assert.ok(enumOf(interpretationSchema('mt5'), 'takeProfit').includes('pips'))
    const delta = systemPrompt(['BTCUSD'])
    const mt5 = systemPrompt(['EURUSD.m'], undefined, 'mt5')
    assert.ok(!/MetaTrader|pips|lots/.test(delta))
    assert.match(mt5, /MetaTrader 5/)
    assert.match(mt5, /EURUSD\.m/)
    assert.match(mt5, /lots/)
  })

  it('reads AI output for MT5 without upper-casing the broker symbol', () => {
    const raw = { strategy: { name: 'x', symbol: ' EURUSD.m ', timeframe: '1h', direction: 'long', stopLoss: { type: 'pips', value: 20 } } }
    const mt5 = toDefinition(raw, 0, 'mt5')
    assert.deepEqual({ venue: mt5.venue, symbol: mt5.symbol, stop: mt5.risk.stopLoss }, { venue: 'mt5', symbol: 'EURUSD.m', stop: { type: 'pips', value: 20 } })
    const delta = toDefinition({ strategy: { symbol: 'btcusd' } })
    assert.equal(delta.symbol, 'BTCUSD')
    assert.equal('venue' in delta, false)
    assert.deepEqual(crossCheck('stop-loss 20 pips', FX, 'mt5').unsupported, [])
  })

  it('stores MT5 strategies validated against the MT5 symbol list', async () => {
    const lists: Record<string, string[]> = { delta: ['BTCUSD'], mt5: ['EURUSD.m'] }
    const store = new StrategyStore(memoryDb(), async (venue) => ({ instruments: lists[venue]! }))
    const saved = await store.save(undefined, FX)
    assert.equal(saved.validation.valid, true)
    assert.equal(venueOf(saved.definition), 'mt5')
    const enabled = await store.setEnabled(saved.id, true)
    assert.equal(enabled.status, 'enabled')
  })
})
