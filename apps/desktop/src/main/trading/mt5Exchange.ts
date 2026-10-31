import { ProviderError } from '../net.js'
import { isValidVolume, sameVolume } from '../../shared/sizing.js'
import type { Mt5Deal, Mt5HistoryOrder, Mt5Position, Mt5Symbol, Mt5TradeRequest } from '../mt5/client.js'
import type { Mt5Connection } from '../mt5/connection.js'
import { toInstrument } from '../mt5/marketData.js'
import { describeRetcode } from '../mt5/retcodes.js'
import type { ExchangeAdapter, ExchangeFill, MarketOrderRequest, OrderResult } from './exchange.js'
import { sizingSpecOf } from '../../shared/sizing.js'

/** MetaQuotes enum values (MQL5 reference). The bridge reports the package's own values via `constants`. */
const TRADE_MODE = { DISABLED: 0, LONGONLY: 1, SHORTONLY: 2, CLOSEONLY: 3, FULL: 4 }
const ORDER_STATE = { STARTED: 0, PLACED: 1, CANCELED: 2, PARTIAL: 3, FILLED: 4, REJECTED: 5, EXPIRED: 6 }
const DEAL_ENTRY = { IN: 0, OUT: 1, INOUT: 2, OUT_BY: 3 }
const DEAL_TYPE_BUY = 0
const POSITION_TYPE_BUY = 0
const MARGIN_MODE_HEDGING = 2
const SYMBOL_FILLING_FOK = 1
const SYMBOL_FILLING_IOC = 2
const HISTORY_LOOKBACK_SEC = 7 * 86400

export interface Mt5ExchangeOptions {
  /** Identifies TradePilot's orders and positions at the broker. */
  magic: number
  /** Maximum accepted slippage for market orders, in points. */
  deviationPoints: number
  now?: () => number
}

/** Filling policy the symbol allows (IOC preferred, then FOK, else the broker's "return" mode). */
export function fillingFor(fillingMode: number): 'ioc' | 'fok' | 'return' {
  if (fillingMode & SYMBOL_FILLING_IOC) return 'ioc'
  if (fillingMode & SYMBOL_FILLING_FOK) return 'fok'
  return 'return'
}

const roundTo = (price: number, digits: number) => Number(price.toFixed(Math.max(0, Math.min(10, digits))))

/**
 * Live execution on MetaTrader 5. Market orders carry their stop-loss and take-profit on the
 * position at the broker. Duplicate prevention: every order carries TradePilot's magic number and
 * the client order id (a hash of the signal) as its comment; an unclear outcome is looked up in
 * the order history by that comment, never re-sent. Results are interpreted from MT5 return codes.
 */
export class Mt5Exchange implements ExchangeAdapter {
  readonly mode = 'live' as const
  private readonly now: () => number

  constructor(
    private readonly conn: Mt5Connection,
    private readonly o: Mt5ExchangeOptions
  ) {
    this.now = o.now ?? (() => Date.now())
  }

  private async hedging(): Promise<boolean> {
    const acct = this.conn.cachedAccount() ?? (await this.conn.account())
    return acct.margin_mode === MARGIN_MODE_HEDGING
  }

  private historyRange() {
    const nowSec = Math.floor(this.now() / 1000)
    return { fromServerSec: this.conn.toServer(nowSec - HISTORY_LOOKBACK_SEC), toServerSec: this.conn.toServer(nowSec) }
  }

  /** Checks that leave the broker untouched when the order could never succeed. */
  private precheck(info: Mt5Symbol, o: MarketOrderRequest, price: number): void {
    const reject = (msg: string) => {
      throw new ProviderError('invalid_request', msg)
    }
    if (info.trade_mode === TRADE_MODE.DISABLED) reject(`Trading ${o.symbol} is disabled at this broker.`)
    if (!o.reduceOnly) {
      if (info.trade_mode === TRADE_MODE.CLOSEONLY) reject(`${o.symbol} is close-only at this broker; new positions cannot be opened.`)
      if (info.trade_mode === TRADE_MODE.LONGONLY && o.side === 'sell') reject(`Only long positions are allowed on ${o.symbol} at this broker.`)
      if (info.trade_mode === TRADE_MODE.SHORTONLY && o.side === 'buy') reject(`Only short positions are allowed on ${o.symbol} at this broker.`)
    }
    const spec = sizingSpecOf(toInstrument(info))
    if (!spec || !isValidVolume(o.size, { ...spec, volumeMin: o.reduceOnly ? spec.volumeStep : spec.volumeMin })) {
      reject(`Volume ${o.size} is not valid for ${o.symbol} (step ${info.volume_step}, minimum ${info.volume_min}, maximum ${info.volume_max} lots).`)
    }
    const minDist = Math.max(0, info.trade_stops_level) * info.point
    if (!o.reduceOnly && minDist > 0) {
      for (const [label, level] of [['stop-loss', o.stopPrice], ['take-profit', o.takePrice]] as const) {
        if (level !== null && level !== undefined && Math.abs(price - level) < minDist) {
          reject(`The ${label} ${level} is closer to the market (${price}) than this broker allows (${minDist.toFixed(info.digits)}). Widen it in the strategy.`)
        }
      }
    }
  }

  async placeMarket(o: MarketOrderRequest): Promise<OrderResult> {
    const info = await this.conn.read((c) => c.symbolInfo(o.symbol))
    const tick = (await this.conn.read((c) => c.ticks([o.symbol])))[o.symbol]
    if (!tick || !(tick.bid > 0) || !(tick.ask > 0)) throw new ProviderError('invalid_request', `No current price for ${o.symbol}; the market may be closed.`)
    this.conn.noteTick(tick)
    const price = o.side === 'buy' ? tick.ask : tick.bid
    this.precheck(info, o, price)

    let position = o.positionTicket ?? undefined
    if (o.reduceOnly && position === undefined && (await this.hedging())) {
      // a hedging account needs the exact position to close
      const mine = (await this.conn.read((c) => c.positions({ symbol: o.symbol, magic: this.o.magic }))).filter((p) => (p.type === POSITION_TYPE_BUY) === (o.side === 'sell'))
      position = mine[0]?.ticket
      if (position === undefined) throw new ProviderError('invalid_request', `No TradePilot position on ${o.symbol} to close.`)
    }
    const request: Mt5TradeRequest = {
      action: 'deal',
      symbol: o.symbol,
      type: o.side,
      volume: o.size,
      price,
      deviation: this.o.deviationPoints,
      magic: this.o.magic,
      comment: o.clientOrderId,
      filling: fillingFor(info.filling_mode),
      ...(position !== undefined ? { position } : {}),
      ...(!o.reduceOnly && o.stopPrice ? { sl: roundTo(o.stopPrice, info.digits) } : {}),
      ...(!o.reduceOnly && o.takePrice ? { tp: roundTo(o.takePrice, info.digits) } : {})
    }
    // sent exactly once; a timeout or unknown result is resolved via orderByClientId
    const res = await this.conn.send(request)
    const rc = describeRetcode(res.retcode, res.comment)
    if (!rc.ok) {
      if (rc.unknown) throw new ProviderError('network', rc.message)
      throw new ProviderError('invalid_request', rc.message)
    }
    const deal = res.deal ? (await this.conn.read((c) => c.historyDeals({ ticket: res.deal })).catch(() => [] as Mt5Deal[]))[0] : undefined
    // no deal ticket (e.g. 10008 PLACED in exchange execution): nothing is confirmed as executed
    // yet; the caller resolves the order from the history by its client id
    const filled = res.deal ? (res.volume > 0 ? res.volume : deal?.volume ?? 0) : 0
    return {
      exchangeOrderId: String(res.order),
      state: filled <= 0 ? 'open' : sameVolume(filled, o.size) || filled > o.size ? 'filled' : 'partially_filled',
      size: o.size,
      filled,
      avgPrice: (deal?.price ?? res.price) || null,
      fee: deal ? -(deal.commission + deal.fee) : 0,
      note: deal ? null : 'commission not yet reported by the broker',
      positionTicket: (o.positionTicket ?? deal?.position_id) || res.order || null
    }
  }

  async orderByClientId(clientOrderId: string): Promise<OrderResult | null> {
    const orders = await this.conn.read((c) => c.historyOrders({ ...this.historyRange(), magic: this.o.magic }))
    // brokers may append to comments, so match the start
    const hit: Mt5HistoryOrder | undefined = orders.find((x) => x.comment === clientOrderId || x.comment.startsWith(clientOrderId))
    if (!hit) return null
    const filled = Math.max(0, hit.volume_initial - hit.volume_current)
    const deals = await this.conn.read((c) => c.historyDeals({ ...this.historyRange(), magic: this.o.magic })).catch(() => [] as Mt5Deal[])
    const own = deals.filter((d) => d.order === hit.ticket)
    const vol = own.reduce((a, d) => a + d.volume, 0)
    const avg = vol > 0 ? own.reduce((a, d) => a + d.price * d.volume, 0) / vol : null
    const state: OrderResult['state'] =
      hit.state === ORDER_STATE.FILLED ? 'filled' : hit.state === ORDER_STATE.PARTIAL ? 'partially_filled' : hit.state === ORDER_STATE.REJECTED ? 'rejected' : hit.state === ORDER_STATE.CANCELED || hit.state === ORDER_STATE.EXPIRED ? (filled > 0 ? 'partially_filled' : 'cancelled') : 'open'
    return {
      exchangeOrderId: String(hit.ticket),
      state,
      size: hit.volume_initial,
      filled,
      avgPrice: avg,
      fee: own.reduce((a, d) => a - (d.commission + d.fee), 0),
      note: hit.comment !== clientOrderId ? 'matched by comment prefix' : null,
      positionTicket: hit.position_id || null
    }
  }

  /** One open position by ticket, or null when it is no longer open. */
  async positionByTicket(ticket: number): Promise<Mt5Position | null> {
    const rows = await this.conn.read((c) => c.positions({ ticket }))
    return rows.find((p) => p.ticket === ticket) ?? null
  }

  /** Closes a whole position by ticket with a market order (sent once). */
  async closeTicket(ticket: number, clientOrderId: string): Promise<OrderResult> {
    const p = await this.positionByTicket(ticket)
    if (!p) throw new ProviderError('invalid_request', `Position ${ticket} is no longer open.`)
    const info = await this.conn.read((c) => c.symbolInfo(p.symbol))
    return this.placeMarket({ productId: 0, symbol: p.symbol, side: p.type === POSITION_TYPE_BUY ? 'sell' : 'buy', size: p.volume, clientOrderId, reduceOnly: true, tickSize: info.trade_tick_size || info.point, positionTicket: ticket })
  }

  /**
   * Changes an open position's stop-loss and take-profit at the broker (null removes a level).
   * Levels are checked against the current price and the broker's minimum stop distance first.
   */
  async modifyStops(ticket: number, sl: number | null, tp: number | null): Promise<void> {
    const p = await this.positionByTicket(ticket)
    if (!p) throw new ProviderError('invalid_request', `Position ${ticket} is no longer open.`)
    const info = await this.conn.read((c) => c.symbolInfo(p.symbol))
    const tick = (await this.conn.read((c) => c.ticks([p.symbol])))[p.symbol]
    if (!tick || !(tick.bid > 0) || !(tick.ask > 0)) throw new ProviderError('invalid_request', `No current price for ${p.symbol}; the market may be closed.`)
    const long = p.type === POSITION_TYPE_BUY
    // a long position closes at the bid, a short one at the ask
    const closeAt = long ? tick.bid : tick.ask
    const minDist = Math.max(0, info.trade_stops_level) * info.point
    const snap = (v: number) => {
      const step = info.trade_tick_size || info.point
      return roundTo(Math.round(v / step) * step, info.digits)
    }
    if (sl !== null) {
      if (!(Number.isFinite(sl) && sl > 0)) throw new ProviderError('invalid_request', 'Enter a positive stop-loss price.')
      if (long ? sl >= closeAt - minDist : sl <= closeAt + minDist) throw new ProviderError('invalid_request', `The stop-loss must be ${long ? 'below' : 'above'} the current price ${closeAt}${minDist ? ` by at least ${minDist.toFixed(info.digits)}` : ''}.`)
    }
    if (tp !== null) {
      if (!(Number.isFinite(tp) && tp > 0)) throw new ProviderError('invalid_request', 'Enter a positive take-profit price.')
      if (long ? tp <= closeAt + minDist : tp >= closeAt - minDist) throw new ProviderError('invalid_request', `The take-profit must be ${long ? 'above' : 'below'} the current price ${closeAt}${minDist ? ` by at least ${minDist.toFixed(info.digits)}` : ''}.`)
    }
    const res = await this.conn.send({ action: 'sltp', symbol: p.symbol, position: ticket, magic: p.magic, sl: sl === null ? 0 : snap(sl), tp: tp === null ? 0 : snap(tp) })
    const rc = describeRetcode(res.retcode, res.comment)
    if (!rc.ok) throw new ProviderError(rc.unknown ? 'network' : 'invalid_request', rc.message)
  }

  /** Only a resting (pending) order can be removed; an executed market order is left alone. */
  async cancel(exchangeOrderId: string): Promise<void> {
    const ticket = Number(exchangeOrderId)
    const pending = await this.conn.read((c) => c.orders({ magic: this.o.magic }))
    if (!pending.some((p) => p.ticket === ticket)) return
    await this.conn.send({ action: 'remove', order: ticket, magic: this.o.magic })
  }

  /**
   * Signed volume on the symbol. Netting accounts hold one position per symbol (including manual
   * trades), so all of it counts; hedging accounts count only TradePilot's positions.
   */
  async position(_productId: number, symbol?: string): Promise<{ size: number; entryPrice: number | null } | null> {
    if (!symbol) throw new ProviderError('invalid_request', 'MT5 positions need a symbol.')
    const hedging = await this.hedging()
    const rows: Mt5Position[] = await this.conn.read((c) => c.positions(hedging ? { symbol, magic: this.o.magic } : { symbol }))
    if (!rows.length) return { size: 0, entryPrice: null }
    const size = rows.reduce((a, p) => a + (p.type === POSITION_TYPE_BUY ? p.volume : -p.volume), 0)
    return { size: Number(size.toFixed(8)), entryPrice: rows[0]!.price_open }
  }

  /** Market orders only: removes TradePilot's pending orders on the symbol (stops/targets live on the position). */
  async cancelAll(_productId: number, _includeProtective: boolean, symbol?: string): Promise<void> {
    const pending = await this.conn.read((c) => c.orders({ symbol, magic: this.o.magic }))
    for (const p of pending) await this.conn.send({ action: 'remove', order: p.ticket, magic: this.o.magic })
  }

  /**
   * Closing deals (stop-loss, take-profit, manual or TradePilot exits) since a time. Swap counts as a
   * cost. With the position ticket, every deal of that position counts, whatever magic number the
   * closing deal carries (a manual close in the terminal has none); otherwise TradePilot's own deals.
   */
  async fillsSince(_productId: number, sinceMs: number, symbol?: string, positionTicket?: number | null): Promise<ExchangeFill[]> {
    const nowSec = Math.floor(this.now() / 1000)
    const deals = positionTicket
      ? await this.conn.read((c) => c.historyDeals({ position: positionTicket }))
      : await this.conn.read((c) => c.historyDeals({ fromServerSec: this.conn.toServer(Math.floor(sinceMs / 1000)), toServerSec: this.conn.toServer(nowSec), magic: this.o.magic }))
    return deals
      .filter((d) => (!symbol || d.symbol === symbol) && d.entry !== DEAL_ENTRY.IN && this.conn.toUtc(d.time_msc / 1000) * 1000 >= sinceMs - 1000)
      .map((d) => ({
        side: d.type === DEAL_TYPE_BUY ? ('buy' as const) : ('sell' as const),
        size: d.volume,
        price: d.price,
        fee: -(d.commission + d.fee + d.swap),
        at: new Date(this.conn.toUtc(d.time_msc / 1000) * 1000).toISOString()
      }))
  }
}
