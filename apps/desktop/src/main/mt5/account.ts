import type { Mt5AccountView } from '../../shared/ipc.js'
import type { Mt5Account } from './client.js'
import type { Mt5Connection } from './connection.js'

const TRADE_MODES: Record<number, 'demo' | 'contest' | 'real'> = { 0: 'demo', 1: 'contest', 2: 'real' }
const MARGIN_MODES: Record<number, 'netting' | 'exchange' | 'hedging'> = { 0: 'netting', 1: 'exchange', 2: 'hedging' }

/** Unknown trade modes are treated as real money (never assume a demo account). */
export const tradeModeOf = (a: Pick<Mt5Account, 'trade_mode'>) => TRADE_MODES[a.trade_mode] ?? 'real'
export const marginModeOf = (a: Pick<Mt5Account, 'margin_mode'>) => MARGIN_MODES[a.margin_mode] ?? 'netting'

/** Account balance, equity, margin and open positions from the MT5 terminal (cached briefly). */
export class Mt5AccountService {
  private cache: { at: number; view: Mt5AccountView } | null = null

  constructor(
    private readonly conn: Mt5Connection,
    private readonly configured: () => boolean,
    private readonly now: () => number = () => Date.now()
  ) {}

  invalidate(): void {
    this.cache = null
  }

  async summary(force = false): Promise<Mt5AccountView> {
    if (!force && this.cache && this.now() - this.cache.at < 10_000) return this.cache.view
    const platformSupported = this.conn.client.unavailable() === null
    const empty: Mt5AccountView = { configured: this.configured(), platformSupported, fetchedAt: null, error: null, account: null, positions: [] }
    if (!platformSupported) return { ...empty, error: this.conn.client.unavailable() }
    if (!this.configured()) return empty
    try {
      const [a, t, positions] = await Promise.all([this.conn.account(), this.conn.terminal(), this.conn.read((c) => c.positions({}))])
      const view: Mt5AccountView = {
        configured: true,
        platformSupported: true,
        fetchedAt: new Date(this.now()).toISOString(),
        error: null,
        account: {
          login: a.login,
          server: a.server,
          name: a.name,
          company: a.company,
          currency: a.currency,
          balance: a.balance,
          equity: a.equity,
          margin: a.margin,
          marginFree: a.margin_free,
          leverage: a.leverage,
          tradeMode: tradeModeOf(a),
          marginMode: marginModeOf(a),
          tradeAllowed: Boolean(a.trade_allowed && a.trade_expert),
          terminalTradeAllowed: Boolean(t.trade_allowed)
        },
        positions: positions.map((p) => ({
          ticket: p.ticket,
          symbol: p.symbol,
          side: p.type === 0 ? 'long' : 'short',
          volume: p.volume,
          priceOpen: p.price_open,
          sl: p.sl || null,
          tp: p.tp || null,
          profit: p.profit,
          swap: p.swap,
          magic: p.magic,
          comment: p.comment
        }))
      }
      this.cache = { at: this.now(), view }
      return view
    } catch (err) {
      return { ...empty, error: err instanceof Error ? err.message : String(err) }
    }
  }
}
