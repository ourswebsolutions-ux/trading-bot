import { useEffect, useState } from 'react'
import type { OrderState, TradingOverview } from '@shared/ipc'
import { Badge, Button, Empty, ErrorState, Panel, Skeleton, Tabs } from '../components/ui'
import { call } from '../lib/api'
import { ago, dateTime, money, price, qty } from '../lib/format'
import { useEvent, useNow, useResource } from '../lib/hooks'
import { useApp } from '../lib/state'
import { AutomationTab, ModePill } from './trading/Automation'
import { ManualPaper } from './trading/ManualPaper'

type Tab = 'automation' | 'orders' | 'account' | 'paper'

const STATE_BADGE: Record<OrderState, { tone?: 'ok' | 'bad' | 'warn' | 'info'; label: string }> = {
  pending: { tone: 'info', label: 'Pending' },
  open: { tone: 'info', label: 'Open' },
  partially_filled: { tone: 'warn', label: 'Partially filled' },
  filled: { tone: 'ok', label: 'Filled' },
  cancelled: { label: 'Cancelled' },
  rejected: { tone: 'bad', label: 'Rejected' },
  unknown: { tone: 'warn', label: 'Checking…' }
}

/** Live account balance from Delta Exchange (refreshed every 10 s). Shows nothing it cannot verify. */
function BalanceStrip({ o }: { o: TradingOverview | undefined }) {
  const { navigate } = useApp()
  const acct = useResource(() => call('account:summary', { refresh: true }), [], { pollMs: 10_000 })
  const now = useNow(5000)
  const a = acct.data
  const main = a?.balances.find((b) => b.asset === 'USD') ?? a?.balances.find((b) => b.balance !== 0) ?? a?.balances[0]
  const upnl = a?.positions.reduce((s, p) => s + (p.unrealizedPnl ?? 0), 0) ?? 0
  if (a && !a.configured) {
    return (
      <div className="panel tile" style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <div style={{ flex: 1 }}>
          <span className="label">Exchange balance</span>
          <div className="sub">Connect a Delta Exchange API key to see your live balance. Paper equity: <span className="num">{money(o?.paperAccount.equity)}</span></div>
        </div>
        <Button size="sm" onClick={() => navigate('settings', { tab: 'delta' })}>Connect Delta Exchange</Button>
      </div>
    )
  }
  return (
    <div className="balance-strip">
      <div className="panel tile">
        <span className="label">Balance {main ? `(${main.asset})` : ''} {o?.live.testnet && <Badge tone="info">Testnet</Badge>}</span>
        <span className="value">{acct.error || a?.error ? '—' : main ? qty(main.balance) : a ? '0' : '…'}</span>
        <span className="sub">{a?.error ? <span className="down">{a.error}</span> : a?.fetchedAt ? `live · updated ${ago(a.fetchedAt, now)}` : 'loading…'}</span>
      </div>
      <div className="panel tile">
        <span className="label">Available funds</span>
        <span className="value">{main?.available === null || main?.available === undefined ? '—' : qty(main.available)}</span>
        <span className="sub">Free for new orders</span>
      </div>
      <div className="panel tile">
        <span className="label">Exchange positions</span>
        <span className="value">{a ? a.positions.length : '—'}</span>
        <span className={`sub ${upnl >= 0 ? 'up' : 'down'}`}>{a?.positions.length ? `unrealized ${qty(upnl)}` : 'none open'}</span>
      </div>
      <div className="panel tile">
        <span className="label">Automation</span>
        <span className="value">{o ? o.sessions.filter((s) => s.status === 'running').length : '—'}</span>
        <span className="sub">{o ? `running · live trading ${o.live.enabled ? 'ON' : 'off'}${o.emergency.active ? ' · EMERGENCY STOP' : ''}` : '…'}</span>
      </div>
    </div>
  )
}

function OrdersTab({ o }: { o: TradingOverview }) {
  const totals = o.trades.reduce((t, x) => ({ net: t.net + x.netPnl, fees: t.fees + x.fees }), { net: 0, fees: 0 })
  return (
    <div className="grid" style={{ gap: 16 }}>
      <Panel title="Automated orders" flush>
        {o.orders.length === 0 ? <Empty icon="clock" title="No automated orders yet" /> : (
          <div className="table-wrap" style={{ maxHeight: 380 }}>
            <table className="data">
              <thead><tr><th>Time</th><th>Mode</th><th>Contract</th><th>Side</th><th>Purpose</th><th className="r">Size</th><th className="r">Filled</th><th className="r">Avg price</th><th className="r">Fee</th><th>Status</th><th>Details</th></tr></thead>
              <tbody>
                {o.orders.map((x) => (
                  <tr key={x.id}>
                    <td className="nowrap faint">{dateTime(x.createdAt)}</td>
                    <td><ModePill mode={x.mode} /></td>
                    <td className="mono">{x.symbol}</td>
                    <td className={x.side === 'buy' ? 'up' : 'down'}>{x.side.toUpperCase()}</td>
                    <td>{x.purpose}</td>
                    <td className="r num">{qty(x.size)}</td>
                    <td className="r num">{qty(x.filledSize)}</td>
                    <td className="r num">{price(x.avgFillPrice)}</td>
                    <td className="r num">{x.fee ? x.fee.toFixed(4) : '—'}</td>
                    <td><Badge tone={STATE_BADGE[x.state].tone}>{STATE_BADGE[x.state].label}</Badge></td>
                    <td className="faint" style={{ fontSize: 12, maxWidth: 260 }} title={x.clientOrderId}>{x.error ?? (x.stopPrice ? `SL ${price(x.stopPrice)}${x.takePrice ? ` · TP ${price(x.takePrice)}` : ''}` : '')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <Panel title="Closed trades" actions={<span className="faint" style={{ fontSize: 11.5 }}>net <span className={totals.net >= 0 ? 'up' : 'down'}>{money(totals.net, { sign: true })}</span> after {money(totals.fees)} fees</span>} flush>
        {o.trades.length === 0 ? <Empty icon="trading" title="No closed trades yet" /> : (
          <div className="table-wrap" style={{ maxHeight: 380 }}>
            <table className="data">
              <thead><tr><th>Closed</th><th>Mode</th><th>Contract</th><th>Side</th><th className="r">Contracts</th><th className="r">Entry</th><th className="r">Exit</th><th className="r">Fees</th><th className="r">Net P&amp;L</th><th>Reason</th></tr></thead>
              <tbody>
                {o.trades.map((t) => (
                  <tr key={t.id}>
                    <td className="nowrap faint">{dateTime(t.exitTime)}</td>
                    <td><ModePill mode={t.mode} /></td>
                    <td className="mono">{t.symbol}</td>
                    <td className={t.side === 'long' ? 'up' : 'down'}>{t.side.toUpperCase()}</td>
                    <td className="r num">{qty(t.contracts)}</td>
                    <td className="r num">{price(t.entryPrice)}</td>
                    <td className="r num">{price(t.exitPrice)}</td>
                    <td className="r num">{t.fees.toFixed(4)}</td>
                    <td className={`r num ${t.netPnl >= 0 ? 'up' : 'down'}`}>{money(t.netPnl, { sign: true })}</td>
                    <td>{t.exitReason.replace(/_/g, ' ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  )
}

function AccountTab() {
  const { navigate } = useApp()
  const acct = useResource(() => call('account:summary', { refresh: true }), [], { pollMs: 15_000 })
  const orders = useResource(() => call('account:orders'), [], { pollMs: 30_000 })
  const now = useNow(5000)
  const a = acct.data
  if (a && !a.configured) return <Panel><Empty icon="key" title="Delta Exchange not connected" action={<Button size="sm" onClick={() => navigate('settings', { tab: 'delta' })}>Connect</Button>}>Add an API key to see balances, positions and order history from your exchange account.</Empty></Panel>
  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <Panel title="Balances" actions={<span className="faint" style={{ fontSize: 11.5 }}>{a?.fetchedAt ? `updated ${ago(a.fetchedAt, now)}` : ''}</span>} flush>
          {!a ? <div className="panel-body"><Skeleton /></div> : a.error ? <ErrorState message={a.error} onRetry={acct.reload} /> : (
            <table className="data"><thead><tr><th>Asset</th><th className="r">Balance</th><th className="r">Available</th></tr></thead>
              <tbody>{a.balances.length === 0 ? <tr><td colSpan={3} className="faint">No balances.</td></tr> : a.balances.map((b) => <tr key={b.asset}><td className="mono">{b.asset}</td><td className="r num">{qty(b.balance)}</td><td className="r num">{b.available === null ? '—' : qty(b.available)}</td></tr>)}</tbody>
            </table>
          )}
        </Panel>
        <Panel title="Open positions on the exchange" flush>
          {!a ? <div className="panel-body"><Skeleton /></div> : a.positions.length === 0 ? <Empty icon="trading" title="No open positions" /> : (
            <table className="data"><thead><tr><th>Contract</th><th className="r">Size</th><th className="r">Entry</th><th className="r">Liq. price</th><th className="r">Unrealized</th></tr></thead>
              <tbody>{a.positions.map((p) => <tr key={p.symbol}><td className="mono">{p.symbol}</td><td className={`r num ${p.size > 0 ? 'up' : 'down'}`}>{qty(p.size)}</td><td className="r num">{price(p.entryPrice)}</td><td className="r num">{price(p.liquidationPrice)}</td><td className={`r num ${(p.unrealizedPnl ?? 0) >= 0 ? 'up' : 'down'}`}>{p.unrealizedPnl === null ? '—' : qty(p.unrealizedPnl)}</td></tr>)}</tbody>
            </table>
          )}
        </Panel>
      </div>
      <Panel title="Exchange order history" flush>
        {!orders.data ? <div className="panel-body"><Skeleton /></div> : orders.data.error ? <ErrorState message={orders.data.error} onRetry={orders.reload} /> : orders.data.orders.length === 0 ? <Empty icon="clock" title="No orders on this account" /> : (
          <div className="table-wrap" style={{ maxHeight: 360 }}>
            <table className="data">
              <thead><tr><th>Created</th><th>Contract</th><th>Side</th><th>Type</th><th className="r">Size</th><th className="r">Unfilled</th><th className="r">Avg fill</th><th className="r">Fee</th><th>State</th></tr></thead>
              <tbody>
                {orders.data.orders.map((x) => (
                  <tr key={x.id}>
                    <td className="nowrap faint">{x.createdAt ? dateTime(x.createdAt) : '—'}</td>
                    <td className="mono">{x.symbol}</td>
                    <td className={x.side === 'buy' ? 'up' : 'down'}>{x.side.toUpperCase()}</td>
                    <td>{x.type?.replace('_', ' ') ?? '—'}</td>
                    <td className="r num">{qty(x.size)}</td>
                    <td className="r num">{x.unfilled === null ? '—' : qty(x.unfilled)}</td>
                    <td className="r num">{price(x.avgFillPrice)}</td>
                    <td className="r num">{x.commission === null ? '—' : x.commission.toFixed(4)}</td>
                    <td>{x.state === 'closed' ? (x.unfilled ? 'partially filled' : 'filled') : x.state ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  )
}

export function Trading() {
  const [tab, setTab] = useState<Tab>('automation')
  const overview = useResource(() => call('trading:overview'), [], { pollMs: 15_000 })
  const strategies = useResource(() => call('strategies:list'), [])
  // latest overview from polling, pushed events or the result of an action
  const [o, setO] = useState<TradingOverview | null>(null)
  useEffect(() => {
    if (overview.data) setO(overview.data)
  }, [overview.data])
  useEvent('trading:changed', setO)
  return (
    <div className="page">
      <BalanceStrip o={o ?? undefined} />
      <div className="panel" style={{ padding: 0 }}>
        <Tabs value={tab} onChange={setTab} tabs={[{ value: 'automation', label: 'Automation' }, { value: 'orders', label: 'Orders & trades' }, { value: 'account', label: 'Exchange account' }, { value: 'paper', label: 'Manual paper trading' }]} />
      </div>
      {tab === 'paper' ? <ManualPaper /> : tab === 'account' ? <AccountTab /> : overview.error ? <ErrorState message={overview.error} onRetry={overview.reload} /> : !o || !strategies.data ? <Skeleton height={300} /> : tab === 'automation' ? <AutomationTab o={o} strategies={strategies.data} onChange={setO} /> : <OrdersTab o={o} />}
    </div>
  )
}
