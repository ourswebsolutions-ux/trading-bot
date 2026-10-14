import { randomUUID } from 'node:crypto'
import { audit, type Db } from './db.js'
import { UserError } from './errors.js'
import type { PaperOrder, PaperPosition } from '../shared/ipc.js'

interface OrderRow {
  id: string
  symbol: string
  side: 'buy' | 'sell'
  quantity: number
  fill_price: number
  created_at: string
}

const toOrder = (r: OrderRow): PaperOrder => ({ id: r.id, symbol: r.symbol, side: r.side, quantity: r.quantity, fillPrice: r.fill_price, createdAt: r.created_at })

/** Average-cost position accounting over the paper order log. */
export function computePositions(orders: PaperOrder[], marks: Record<string, number>): PaperPosition[] {
  const book = new Map<string, { qty: number; avg: number; realized: number }>()
  for (const o of [...orders].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const p = book.get(o.symbol) ?? { qty: 0, avg: 0, realized: 0 }
    const signed = o.side === 'buy' ? o.quantity : -o.quantity
    if (p.qty === 0 || Math.sign(p.qty) === Math.sign(signed)) {
      p.avg = (p.avg * Math.abs(p.qty) + o.fillPrice * Math.abs(signed)) / (Math.abs(p.qty) + Math.abs(signed))
      p.qty += signed
    } else {
      const closing = Math.min(Math.abs(signed), Math.abs(p.qty))
      p.realized += closing * (o.fillPrice - p.avg) * Math.sign(p.qty)
      const remaining = p.qty + signed
      if (Math.abs(remaining) < 1e-12) {
        p.qty = 0
        p.avg = 0
      } else if (Math.sign(remaining) !== Math.sign(p.qty)) {
        p.qty = remaining
        p.avg = o.fillPrice
      } else p.qty = remaining
    }
    book.set(o.symbol, p)
  }
  return [...book.entries()].map(([symbol, p]) => {
    const mark = marks[symbol] ?? null
    return {
      symbol,
      quantity: p.qty,
      avgPrice: p.avg,
      markPrice: mark,
      unrealizedPnl: mark !== null && p.qty !== 0 ? (mark - p.avg) * p.qty : p.qty === 0 ? 0 : null,
      realizedPnl: p.realized
    }
  })
}

/** Paper trading only: orders fill at the current exchange mark price and never leave this computer. */
export class PaperBroker {
  constructor(
    private readonly db: Db,
    private readonly markPrice: (symbol: string) => Promise<number>
  ) {}

  orders(): PaperOrder[] {
    return (this.db.prepare('SELECT * FROM paper_orders ORDER BY created_at DESC LIMIT 500').all() as unknown as OrderRow[]).map(toOrder)
  }

  async place(symbol: string, side: 'buy' | 'sell', quantity: number): Promise<PaperOrder> {
    if (!/^[A-Z0-9_]{2,32}$/.test(symbol)) throw new UserError('validation_failed', 'Choose a symbol.', { symbol: 'Required' })
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1e9) throw new UserError('validation_failed', 'Quantity must be a positive number.', { quantity: 'Must be > 0' })
    const price = await this.markPrice(symbol)
    const order: PaperOrder = { id: randomUUID(), symbol, side, quantity, fillPrice: price, createdAt: new Date().toISOString() }
    this.db.prepare('INSERT INTO paper_orders (id, symbol, side, quantity, fill_price, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(order.id, symbol, side, quantity, price, order.createdAt)
    audit(this.db, 'paper.order_filled', { symbol, side, quantity, price })
    return order
  }

  async positions(marks: Record<string, number>): Promise<PaperPosition[]> {
    return computePositions(this.orders(), marks).filter((p) => p.quantity !== 0 || p.realizedPnl !== 0)
  }

  async close(symbol: string): Promise<PaperOrder> {
    const pos = computePositions(this.orders(), {}).find((p) => p.symbol === symbol)
    if (!pos || pos.quantity === 0) throw new UserError('no_position', `There is no open paper position in ${symbol}.`)
    return this.place(symbol, pos.quantity > 0 ? 'sell' : 'buy', Math.abs(pos.quantity))
  }

  reset(): void {
    this.db.prepare('DELETE FROM paper_orders').run()
    audit(this.db, 'paper.reset')
  }
}
