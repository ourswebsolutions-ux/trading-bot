import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MIGRATIONS, migrate } from '../src/main/db.js'
import { computePositions, PaperBroker } from '../src/main/paper.js'
import { memoryDb } from './helpers.js'

describe('local database migrations', () => {
  it('applies once, is idempotent and refuses edited migrations', () => {
    const db = memoryDb()
    assert.deepEqual(migrate(db), [])
    assert.throws(() => migrate(db, [{ ...MIGRATIONS[0]!, sql: MIGRATIONS[0]!.sql + ' ' }]), /modified/)
  })
})

describe('paper trading', () => {
  it('fills at the mark price and tracks average-cost positions and realized P&L', async () => {
    const prices: Record<string, number> = { BTCUSD: 100 }
    const broker = new PaperBroker(memoryDb(), async (s) => prices[s]!)
    await broker.place('BTCUSD', 'buy', 2)
    prices.BTCUSD = 110
    await broker.place('BTCUSD', 'buy', 2)
    let [pos] = await broker.positions({ BTCUSD: 120 })
    assert.equal(pos!.quantity, 4)
    assert.equal(pos!.avgPrice, 105)
    assert.equal(pos!.unrealizedPnl, 60)
    prices.BTCUSD = 130
    await broker.close('BTCUSD')
    ;[pos] = await broker.positions({ BTCUSD: 130 })
    assert.equal(pos!.quantity, 0)
    assert.equal(pos!.realizedPnl, 100)
    await assert.rejects(broker.close('BTCUSD'), /no open paper position/)
    await assert.rejects(broker.place('BTCUSD', 'buy', -1), /positive/)
  })

  it('handles position flips', () => {
    const [p] = computePositions(
      [
        { id: '1', symbol: 'ETHUSD', side: 'buy', quantity: 1, fillPrice: 100, createdAt: '2026-01-01T00:00:00Z' },
        { id: '2', symbol: 'ETHUSD', side: 'sell', quantity: 3, fillPrice: 90, createdAt: '2026-01-01T00:01:00Z' }
      ],
      { ETHUSD: 80 }
    )
    assert.equal(p!.quantity, -2)
    assert.equal(p!.avgPrice, 90)
    assert.equal(p!.realizedPnl, -10)
    assert.equal(p!.unrealizedPnl, 20)
  })
})
