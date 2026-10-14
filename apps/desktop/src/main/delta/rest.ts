import { createHmac } from 'node:crypto'
import { z } from 'zod'
import { ProviderError, requestJson } from '../net.js'
import { DELTA_REGIONS, type DeltaRegion } from './regions.js'

export interface DeltaCredentials {
  apiKey: string
  apiSecret: string
}

/** Delta REST signature: hex HMAC-SHA256(secret, method + timestamp + path + query + body). */
export function deltaSignature(secret: string, method: string, timestamp: string, path: string, query = '', body = ''): string {
  return createHmac('sha256', secret).update(method + timestamp + path + query + body).digest('hex')
}

// Numbers arrive as strings or numbers depending on the endpoint.
const num = z.union([z.number(), z.string()]).transform((v, ctx) => {
  const n = typeof v === 'number' ? v : Number.parseFloat(v)
  if (!Number.isFinite(n)) {
    ctx.addIssue({ code: 'custom', message: 'not a number' })
    return z.NEVER
  }
  return n
})
const optNum = num.nullish().catch(null)

export const ProductSchema = z.object({
  id: z.number(),
  symbol: z.string(),
  description: z.string().nullish(),
  contract_type: z.string(),
  state: z.string(),
  trading_status: z.string().nullish(),
  tick_size: num,
  contract_value: optNum,
  underlying_asset: z.object({ symbol: z.string() }).partial().nullish(),
  quoting_asset: z.object({ symbol: z.string() }).partial().nullish(),
  settling_asset: z.object({ symbol: z.string() }).partial().nullish()
})
export type DeltaProduct = z.infer<typeof ProductSchema>

export const TickerSchema = z.object({
  symbol: z.string(),
  description: z.string().nullish(),
  mark_price: optNum,
  close: optNum,
  open: optNum,
  high: optNum,
  low: optNum,
  turnover_usd: optNum,
  funding_rate: optNum,
  spot_price: optNum,
  /** microseconds since epoch */
  timestamp: z.number().nullish(),
  quotes: z.object({ best_bid: optNum, best_ask: optNum }).partial().nullish()
})
export type DeltaTicker = z.infer<typeof TickerSchema>

export const CandleSchema = z.object({ time: z.number(), open: num, high: num, low: num, close: num, volume: optNum })

export const BalanceSchema = z.object({
  asset_symbol: z.string().nullish(),
  asset_id: z.number().nullish(),
  balance: num,
  available_balance: optNum,
  order_margin: optNum,
  position_margin: optNum
})
export type DeltaBalance = z.infer<typeof BalanceSchema>

export const PositionSchema = z.object({
  product_symbol: z.string().nullish(),
  product_id: z.number().nullish(),
  size: num,
  entry_price: optNum,
  margin: optNum,
  liquidation_price: optNum,
  realized_pnl: optNum,
  unrealized_pnl: optNum
})
export type DeltaPosition = z.infer<typeof PositionSchema>

export const OrderSchema = z.object({
  id: z.union([z.number(), z.string()]),
  product_symbol: z.string().nullish(),
  side: z.string(),
  size: num,
  unfilled_size: optNum,
  order_type: z.string().nullish(),
  state: z.string().nullish(),
  limit_price: optNum,
  average_fill_price: optNum,
  paid_commission: optNum,
  created_at: z.string().nullish()
})
export type DeltaOrder = z.infer<typeof OrderSchema>

/** Exchange order as returned by POST/GET /v2/orders. Sizes are integer contracts. */
export const ExchangeOrderSchema = z.object({
  id: z.union([z.number(), z.string()]),
  client_order_id: z.string().nullish(),
  product_id: z.number().nullish(),
  product_symbol: z.string().nullish(),
  side: z.string(),
  size: num,
  unfilled_size: optNum,
  state: z.string(),
  order_type: z.string().nullish(),
  average_fill_price: optNum,
  paid_commission: optNum,
  cancellation_reason: z.string().nullish(),
  created_at: z.string().nullish()
})
export type ExchangeOrderRaw = z.infer<typeof ExchangeOrderSchema>

export const FillSchema = z.object({
  id: z.union([z.number(), z.string()]),
  order_id: z.union([z.number(), z.string()]).nullish(),
  product_id: z.number().nullish(),
  side: z.string(),
  size: num,
  price: num,
  commission: optNum,
  created_at: z.string().nullish()
})
export type FillRaw = z.infer<typeof FillSchema>

export interface PlaceOrderInput {
  productId: number
  side: 'buy' | 'sell'
  size: number
  clientOrderId: string
  reduceOnly: boolean
  /** Exchange-side protection attached to the entry (bracket order). */
  stopLossPrice?: string
  takeProfitPrice?: string
}

const ERROR_HINTS: Record<string, [ProviderError['kind'], string]> = {
  ACCESS_RESTRICTED: ['region_blocked', 'Delta Exchange blocks this region from your current location (Access Restricted: Region Not Supported). Choose the region your account belongs to.'],
  invalid_api_key: ['auth', 'The API key is not valid for this region. India and Global accounts use different endpoints and keys.'],
  InvalidApiKey: ['auth', 'The API key is not valid for this region. India and Global accounts use different endpoints and keys.'],
  Signature_Mismatch: ['auth', 'Signature mismatch: the API secret does not belong to this API key.'],
  SignatureMismatch: ['auth', 'Signature mismatch: the API secret does not belong to this API key.'],
  expired_signature: ['auth', 'The request signature expired. Your computer clock is probably wrong; enable automatic time sync.'],
  ip_not_whitelisted_for_api_key: ['permission', 'Your current IP address is not on this API key’s whitelist. Add it in Delta Exchange → API Keys.'],
  UnauthorizedApiAccess: ['permission', 'This API key does not have permission for this data. Enable "Read Data" on the key.'],
  unauthorized: ['auth', 'Delta Exchange rejected the credentials (unauthorized).'],
  too_many_requests: ['rate_limited', 'Delta Exchange rate limit reached. Requests will resume shortly.'],
  insufficient_margin: ['invalid_request', 'Insufficient margin: the account does not have enough available funds for this order.'],
  order_size_exceed_available: ['invalid_request', 'Order size exceeds what is available on the order book.'],
  immediate_liquidation: ['invalid_request', 'The order would be liquidated immediately at the current leverage.'],
  out_of_bankruptcy: ['invalid_request', 'The order price is outside the bankruptcy limit.'],
  invalid_contract: ['invalid_request', 'This contract is not tradable on the connected account.'],
  contract_expired: ['invalid_request', 'This contract has expired.'],
  ExpiredSignature: ['auth', 'The request signature expired. Your computer clock is probably wrong; enable automatic time sync.'],
  SignatureExpired: ['auth', 'The request signature expired. Your computer clock is probably wrong; enable automatic time sync.']
}

/** Delta returns errors either as {"error":"code"} or {"error":{"code":"…","context":{…}}}. */
export function deltaErrorFrom(status: number, body: unknown): ProviderError {
  const b = body as { error?: unknown; message?: string } | null
  const code = typeof b?.error === 'string' ? b.error : ((b?.error as { code?: string } | undefined)?.code ?? '')
  const hint = ERROR_HINTS[code]
  if (hint) return new ProviderError(hint[0], hint[1], status, undefined, code)
  if (status === 429) return new ProviderError('rate_limited', 'Delta Exchange rate limit reached. Try again in a minute.', status, undefined, code)
  if (status === 401) return new ProviderError('auth', `Delta Exchange rejected the credentials${code ? ` (${code})` : ''}.`, status, undefined, code)
  if (status === 403) return new ProviderError('permission', `Delta Exchange denied access${code ? ` (${code})` : ''}.`, status, undefined, code)
  if (status === 404) return new ProviderError('not_found', 'This endpoint or instrument is not available in the selected region.', status, undefined, code)
  if (status >= 500) return new ProviderError('provider', `Delta Exchange is having problems (HTTP ${status}). Try again later.`, status, undefined, code)
  return new ProviderError('provider', `Delta Exchange error${code ? ` "${code}"` : ''} (HTTP ${status}).`, status, undefined, code)
}

export class DeltaRest {
  constructor(
    readonly region: DeltaRegion,
    private readonly creds: DeltaCredentials | null = null,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleep?: (ms: number) => Promise<void>
  ) {}

  get baseUrl(): string {
    return DELTA_REGIONS[this.region].rest
  }

  get authorized(): boolean {
    return Boolean(this.creds?.apiKey && this.creds.apiSecret)
  }

  private async get<T>(path: string, query: Record<string, string | number | undefined>, schema: z.ZodType<T>, signed: boolean): Promise<{ result: T; meta: unknown }> {
    const qs = Object.entries(query).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&')
    const queryString = qs ? `?${qs}` : ''
    if (signed && !this.authorized) throw new ProviderError('auth', 'Delta Exchange API key and secret are not configured.')
    const res = await requestJson<{ success?: boolean; result?: unknown; meta?: unknown }>(this.baseUrl + path + queryString, {
      headers: { Accept: 'application/json', 'User-Agent': 'TradePilot/2' },
      fetchImpl: this.fetchImpl,
      sleep: this.sleep,
      timeoutMs: 15_000,
      // re-sign on every attempt so a retry never reuses an expiring timestamp
      beforeAttempt: signed
        ? (h) => {
            const ts = Math.floor(Date.now() / 1000).toString()
            return { ...h, 'api-key': this.creds!.apiKey, timestamp: ts, signature: deltaSignature(this.creds!.apiSecret, 'GET', ts, path, queryString) }
          }
        : undefined
    })
    if (res.status >= 400 || !res.body || res.body.success === false) throw deltaErrorFrom(res.status, res.body)
    const parsed = schema.safeParse(res.body.result)
    if (!parsed.success) {
      throw new ProviderError('bad_response', `Unexpected response format from Delta Exchange ${path} (${parsed.error.issues[0]?.path.join('.') ?? 'body'}: ${parsed.error.issues[0]?.message ?? 'invalid'}).`)
    }
    return { result: parsed.data, meta: res.body.meta }
  }

  /** Live perpetual futures listed in this region. */
  async products(): Promise<DeltaProduct[]> {
    const { result } = await this.get('/v2/products', { contract_types: 'perpetual_futures', states: 'live', page_size: 500 }, z.array(ProductSchema), false)
    return result
  }

  async tickers(): Promise<DeltaTicker[]> {
    return (await this.get('/v2/tickers', { contract_types: 'perpetual_futures' }, z.array(TickerSchema), false)).result
  }

  async ticker(symbol: string): Promise<DeltaTicker> {
    return (await this.get(`/v2/tickers/${encodeURIComponent(symbol)}`, {}, TickerSchema, false)).result
  }

  async candles(symbol: string, resolution: string, start: number, end: number) {
    return (await this.get('/v2/history/candles', { resolution, symbol, start, end }, z.array(CandleSchema), false)).result
  }

  /** Signed request with a JSON body. Never retried: a retry could duplicate an order. */
  private async send<T>(method: 'POST' | 'DELETE', path: string, body: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    if (!this.authorized) throw new ProviderError('auth', 'Delta Exchange API key and secret are not configured.')
    const json = JSON.stringify(body)
    const ts = Math.floor(Date.now() / 1000).toString()
    const res = await requestJson<{ success?: boolean; result?: unknown }>(this.baseUrl + path, {
      method,
      attempts: 1,
      body: json,
      timeoutMs: 15_000,
      fetchImpl: this.fetchImpl,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'TradePilot/2',
        'api-key': this.creds!.apiKey,
        timestamp: ts,
        signature: deltaSignature(this.creds!.apiSecret, method, ts, path, '', json)
      }
    })
    if (res.status >= 400 || !res.body || res.body.success === false) throw deltaErrorFrom(res.status, res.body)
    const parsed = schema.safeParse(res.body.result)
    if (!parsed.success) throw new ProviderError('bad_response', `Unexpected response format from Delta Exchange ${path}.`)
    return parsed.data
  }

  /** Market order; optional bracket stop-loss / take-profit is attached on the exchange. */
  async placeMarketOrder(o: PlaceOrderInput): Promise<ExchangeOrderRaw> {
    if (!Number.isInteger(o.size) || o.size < 1) throw new ProviderError('invalid_request', 'Order size must be a whole number of contracts.')
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(o.clientOrderId)) throw new ProviderError('invalid_request', 'Invalid client order id.')
    return this.send('POST', '/v2/orders', {
      product_id: o.productId,
      size: o.size,
      side: o.side,
      order_type: 'market_order',
      reduce_only: o.reduceOnly,
      client_order_id: o.clientOrderId,
      ...(o.stopLossPrice ? { bracket_stop_loss_price: o.stopLossPrice, bracket_stop_trigger_method: 'mark_price' } : {}),
      ...(o.takeProfitPrice ? { bracket_take_profit_price: o.takeProfitPrice } : {})
    }, ExchangeOrderSchema)
  }

  /** Looks an order up by our client order id; null if the exchange never received it. */
  async orderByClientId(clientOrderId: string): Promise<ExchangeOrderRaw | null> {
    try {
      return (await this.get(`/v2/orders/client_order_id/${encodeURIComponent(clientOrderId)}`, {}, ExchangeOrderSchema, true)).result
    } catch (err) {
      if (err instanceof ProviderError && err.status === 404) return null
      throw err
    }
  }

  async cancelOrder(orderId: string | number, productId: number): Promise<ExchangeOrderRaw> {
    return this.send('DELETE', '/v2/orders', { id: Number(orderId), product_id: productId }, ExchangeOrderSchema)
  }

  /** Cancels working orders for a product; stop orders (exchange-side protection) only when asked. */
  async cancelAllOrders(productId: number, includeStopOrders: boolean): Promise<void> {
    await this.send('DELETE', '/v2/orders/all', { product_id: productId, cancel_limit_orders: true, cancel_stop_orders: includeStopOrders, cancel_reduce_only_orders: includeStopOrders }, z.unknown())
  }

  /** Real-time position for one product (signed size in contracts). */
  async position(productId: number): Promise<{ size: number; entryPrice: number | null }> {
    const r = (await this.get('/v2/positions', { product_id: productId }, z.object({ size: num, entry_price: optNum }).nullable(), true)).result
    return { size: r?.size ?? 0, entryPrice: r?.entry_price ?? null }
  }

  async openOrders(productId: number): Promise<ExchangeOrderRaw[]> {
    return (await this.get('/v2/orders', { product_ids: productId, states: 'open,pending' }, z.array(ExchangeOrderSchema), true)).result
  }

  /** Fills since a time (ms), newest first. */
  async fills(productId: number, sinceMs: number): Promise<FillRaw[]> {
    return (await this.get('/v2/fills', { product_ids: productId, start_time: Math.floor(sinceMs * 1000), page_size: 50 }, z.array(FillSchema), true)).result
  }

  // ----- authorized (read-only) -----
  async balances(): Promise<DeltaBalance[]> {
    return (await this.get('/v2/wallet/balances', {}, z.array(BalanceSchema), true)).result
  }

  async positions(): Promise<DeltaPosition[]> {
    return (await this.get('/v2/positions/margined', {}, z.array(PositionSchema), true)).result
  }

  async orderHistory(pageSize = 50): Promise<DeltaOrder[]> {
    return (await this.get('/v2/orders/history', { page_size: Math.min(100, Math.max(1, pageSize)) }, z.array(OrderSchema), true)).result
  }
}
