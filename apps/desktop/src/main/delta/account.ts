import { describeError, type IntegrationService } from '../integrations.js'
import type { DeltaAccountView, ExchangeOrder } from '../../shared/ipc.js'
import { deltaRegion } from '../integrationSpecs.js'
import { DeltaRest } from './rest.js'

/** Read-only Delta account data, fetched only when credentials are configured. Never fabricated. */
export class DeltaAccountService {
  private cache: { at: number; view: DeltaAccountView } | null = null

  constructor(
    private readonly integrations: IntegrationService,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  private client(): DeltaRest | null {
    if (!this.integrations.isConfigured('delta')) return null
    const cfg = this.integrations.config('delta')
    return new DeltaRest(deltaRegion(cfg), { apiKey: this.integrations.secret('delta', 'apiKey')!, apiSecret: this.integrations.secret('delta', 'apiSecret')! }, this.fetchImpl)
  }

  async summary(force = false): Promise<DeltaAccountView> {
    if (!force && this.cache && Date.now() - this.cache.at < 15_000) return this.cache.view
    const region = deltaRegion(this.integrations.config('delta'))
    const client = this.client()
    if (!client) return { configured: false, region, fetchedAt: null, error: null, balances: [], positions: [] }
    try {
      const [balances, positions] = await Promise.all([client.balances(), client.positions()])
      const view: DeltaAccountView = {
        configured: true,
        region,
        fetchedAt: new Date().toISOString(),
        error: null,
        balances: balances.map((b) => ({ asset: b.asset_symbol ?? `asset ${b.asset_id ?? '?'}`, balance: b.balance, available: b.available_balance ?? null })),
        positions: positions
          .filter((p) => p.size !== 0)
          .map((p) => ({
            symbol: p.product_symbol ?? `product ${p.product_id ?? '?'}`,
            size: p.size,
            entryPrice: p.entry_price ?? null,
            margin: p.margin ?? null,
            liquidationPrice: p.liquidation_price ?? null,
            unrealizedPnl: p.unrealized_pnl ?? null
          }))
      }
      this.cache = { at: Date.now(), view }
      return view
    } catch (err) {
      return { configured: true, region, fetchedAt: null, error: describeError(err), balances: [], positions: [] }
    }
  }

  async orders(): Promise<{ orders: ExchangeOrder[]; error: string | null; fetchedAt: string | null; configured: boolean }> {
    const client = this.client()
    if (!client) return { orders: [], error: null, fetchedAt: null, configured: false }
    try {
      const rows = await client.orderHistory(50)
      return {
        configured: true,
        error: null,
        fetchedAt: new Date().toISOString(),
        orders: rows.map((o) => ({
          id: String(o.id),
          symbol: o.product_symbol ?? '?',
          side: o.side,
          size: o.size,
          unfilled: o.unfilled_size ?? null,
          type: o.order_type ?? null,
          state: o.state ?? null,
          limitPrice: o.limit_price ?? null,
          avgFillPrice: o.average_fill_price ?? null,
          commission: o.paid_commission ?? null,
          createdAt: o.created_at ?? null
        }))
      }
    } catch (err) {
      return { configured: true, orders: [], error: describeError(err), fetchedAt: null }
    }
  }

  invalidate(): void {
    this.cache = null
  }
}
