import { randomUUID } from 'node:crypto'
import type { DeltaRest, ExchangeOrderRaw } from '../delta/rest.js'
import type { AutomationMode, OrderState } from '../../shared/ipc.js'

export interface OrderResult {
  exchangeOrderId: string | null
  state: OrderState
  size: number
  filled: number
  avgPrice: number | null
  fee: number
  note: string | null
  /** MT5: the position the fill opened or changed. */
  positionTicket?: number | null
}

export interface MarketOrderRequest {
  productId: number
  symbol: string
  side: 'buy' | 'sell'
  size: number
  clientOrderId: string
  reduceOnly: boolean
  stopPrice?: number | null
  takePrice?: number | null
  tickSize: number
  /** MT5: close/reduce this position (hedging accounts can hold several per symbol). */
  positionTicket?: number | null
}

export interface ExchangeFill {
  side: 'buy' | 'sell'
  size: number
  price: number
  fee: number
  at: string
}

/**
 * Execution venue. Live = Delta Exchange (by product id) or MetaTrader 5 (by symbol); paper =
 * simulated fills. The symbol arguments are optional so Delta keeps its original calls.
 */
export interface ExchangeAdapter {
  readonly mode: AutomationMode
  placeMarket(o: MarketOrderRequest): Promise<OrderResult>
  orderByClientId(clientOrderId: string): Promise<OrderResult | null>
  cancel(exchangeOrderId: string, productId: number, symbol?: string): Promise<void>
  /** Signed position size in the venue's volume unit (null when the venue has no independent position record). */
  position(productId: number, symbol?: string): Promise<{ size: number; entryPrice: number | null } | null>
  cancelAll(productId: number, includeProtectiveOrders: boolean, symbol?: string): Promise<void>
  /** MT5 passes the position ticket so a position's own closing deals are found exactly. */
  fillsSince(productId: number, sinceMs: number, symbol?: string, positionTicket?: number | null): Promise<ExchangeFill[]>
}

export function priceString(price: number, tick: number): string {
  const decimals = tick > 0 && tick < 1 ? Math.min(10, Math.max(0, Math.ceil(-Math.log10(tick) - 1e-9))) : 0
  return price.toFixed(decimals)
}

/** Maps Delta order states (open / pending / closed / cancelled) and fill progress to TradePilot states. */
export function mapDeltaOrder(o: ExchangeOrderRaw): OrderResult {
  const size = o.size
  const unfilled = o.unfilled_size ?? (o.state === 'closed' ? 0 : size)
  const filled = Math.max(0, size - unfilled)
  let state: OrderState
  if (o.state === 'closed') state = filled >= size ? 'filled' : filled > 0 ? 'partially_filled' : 'cancelled'
  else if (o.state === 'cancelled') state = filled > 0 ? 'partially_filled' : 'cancelled'
  else if (o.state === 'open') state = filled > 0 ? 'partially_filled' : 'open'
  else state = 'pending'
  return {
    exchangeOrderId: String(o.id),
    state,
    size,
    filled,
    avgPrice: o.average_fill_price ?? null,
    fee: o.paid_commission ?? 0,
    note: o.state === 'cancelled' && o.cancellation_reason ? `cancelled: ${o.cancellation_reason}${filled > 0 ? ' (remainder after a partial fill)' : ''}` : null
  }
}

export class DeltaExchange implements ExchangeAdapter {
  readonly mode = 'live' as const
  constructor(private readonly rest: DeltaRest) {}

  async placeMarket(o: MarketOrderRequest): Promise<OrderResult> {
    const raw = await this.rest.placeMarketOrder({
      productId: o.productId,
      side: o.side,
      size: o.size,
      clientOrderId: o.clientOrderId,
      reduceOnly: o.reduceOnly,
      stopLossPrice: o.stopPrice ? priceString(o.stopPrice, o.tickSize) : undefined,
      takeProfitPrice: o.takePrice ? priceString(o.takePrice, o.tickSize) : undefined
    })
    return mapDeltaOrder(raw)
  }

  async orderByClientId(cid: string): Promise<OrderResult | null> {
    const raw = await this.rest.orderByClientId(cid)
    return raw ? mapDeltaOrder(raw) : null
  }

  async cancel(id: string, productId: number): Promise<void> {
    await this.rest.cancelOrder(id, productId)
  }

  position(productId: number) {
    return this.rest.position(productId)
  }

  cancelAll(productId: number, includeProtectiveOrders: boolean) {
    return this.rest.cancelAllOrders(productId, includeProtectiveOrders)
  }

  async fillsSince(productId: number, sinceMs: number): Promise<ExchangeFill[]> {
    return (await this.rest.fills(productId, sinceMs)).map((f) => ({ side: f.side === 'sell' ? 'sell' : 'buy', size: f.size, price: f.price, fee: f.commission ?? 0, at: f.created_at ?? new Date().toISOString() }))
  }
}

/**
 * Simulated venue: fills the full size immediately, charging the fee assumption. Delta fills at
 * the mark price; venues with a bid/ask (MT5) buy at the ask and sell at the bid, so the spread
 * is paid as it would be at the broker. Configured slippage is applied against every fill.
 */
export class PaperExchange implements ExchangeAdapter {
  readonly mode = 'paper' as const
  private orders = new Map<string, OrderResult>()

  constructor(
    private readonly markPrice: (symbol: string) => Promise<number>,
    /** Account-currency value of a 1.0 price move per unit of volume (Delta: the contract value). */
    private readonly contractValue: (symbol: string) => number,
    private readonly feeBps: (symbol: string) => number,
    /** Simulated adverse slippage per fill (basis points). */
    private readonly slippageBps: () => number = () => 0,
    /** Bid/ask source; when given, fills use it instead of the mark price. */
    private readonly quote?: (symbol: string) => Promise<{ bid: number; ask: number }>
  ) {}

  async placeMarket(o: MarketOrderRequest): Promise<OrderResult> {
    const q = this.quote ? await this.quote(o.symbol) : null
    const mark = q ? (o.side === 'buy' ? q.ask : q.bid) : await this.markPrice(o.symbol)
    const slip = Math.max(0, this.slippageBps()) / 10_000
    const price = o.side === 'buy' ? mark * (1 + slip) : mark * (1 - slip)
    const fee = o.size * this.contractValue(o.symbol) * price * (this.feeBps(o.symbol) / 10_000)
    const r: OrderResult = { exchangeOrderId: `paper-${randomUUID().slice(0, 8)}`, state: 'filled', size: o.size, filled: o.size, avgPrice: price, fee, note: 'simulated fill' }
    this.orders.set(o.clientOrderId, r)
    return r
  }

  async orderByClientId(cid: string) {
    return this.orders.get(cid) ?? null
  }

  async cancel() {}
  async position() {
    return null
  }
  async cancelAll() {}
  async fillsSince() {
    return []
  }
}
