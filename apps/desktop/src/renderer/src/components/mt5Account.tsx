import { call } from '../lib/api'
import { ago, price, qty } from '../lib/format'
import { useNow, useResource } from '../lib/hooks'
import { useApp } from '../lib/state'
import { Badge, Button, Empty, ErrorState, Panel, Skeleton } from './ui'

const num = (v: number, currency: string) => `${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`

/** MetaTrader 5 account straight from the terminal. Shows nothing it could not read. */
export function Mt5AccountPanel({ title = 'MetaTrader 5 account', showPositions = true }: { title?: string; showPositions?: boolean }) {
  const { navigate } = useApp()
  const acct = useResource(() => call('mt5:account', {}), [], { pollMs: 15_000 })
  const now = useNow(15_000)
  const a = acct.data
  const refresh = () => void call('mt5:account', { refresh: true }).then(() => acct.reload())
  return (
    <Panel title={title} actions={a?.configured && a.platformSupported ? <Button size="sm" variant="ghost" icon="refresh" loading={acct.loading} onClick={refresh}>Refresh</Button> : undefined} flush>
      {!a ? <div className="panel-body"><Skeleton /></div> : !a.platformSupported ? (
        <Empty icon="alert" title="Windows only" action={<Button size="sm" onClick={() => navigate('settings', { tab: 'mt5' })}>MetaTrader 5 settings</Button>}>
          MetaTrader 5 needs Windows with the MT5 terminal installed. No account data is available on this computer.
        </Empty>
      ) : !a.configured ? (
        <Empty icon="key" title="Not connected" action={<Button size="sm" onClick={() => navigate('settings', { tab: 'mt5' })}>Connect MetaTrader 5</Button>}>
          Enter your MT5 login, password and trade server to see your balance and positions here.
        </Empty>
      ) : a.error || !a.account ? (
        <ErrorState message={a.error ?? 'The MetaTrader 5 account could not be read.'} onRetry={refresh} />
      ) : (
        <>
          <dl className="kv" style={{ padding: '10px 14px', gridTemplateColumns: '130px 1fr' }}>
            <dt>Account</dt><dd className="mono">{a.account.login} · {a.account.server}</dd>
            <dt>Type</dt><dd>{a.account.tradeMode === 'real' ? <Badge tone="bad">Real money</Badge> : <Badge tone="ok">{a.account.tradeMode === 'demo' ? 'Demo' : 'Contest'}</Badge>} · 1:{a.account.leverage} · {a.account.marginMode}</dd>
            <dt>Balance</dt><dd className="num">{num(a.account.balance, a.account.currency)}</dd>
            <dt>Equity</dt><dd className="num">{num(a.account.equity, a.account.currency)}</dd>
            <dt>Free margin</dt><dd className="num">{num(a.account.marginFree, a.account.currency)}</dd>
            <dt>Algo Trading</dt><dd>{a.account.tradeAllowed && a.account.terminalTradeAllowed ? <Badge tone="ok">allowed</Badge> : <Badge tone="warn">off in terminal or account</Badge>}</dd>
          </dl>
          {showPositions && a.positions.length > 0 && (
            <table className="data">
              <thead><tr><th>Position</th><th className="r">Lots</th><th className="r">Open</th><th className="r">SL / TP</th><th className="r">Profit</th></tr></thead>
              <tbody>
                {a.positions.map((p) => (
                  <tr key={p.ticket} title={`Ticket ${p.ticket}${p.magic ? ` · magic ${p.magic}` : ''}${p.comment ? ` · ${p.comment}` : ''}`}>
                    <td className="mono">{p.symbol} <span className={p.side === 'long' ? 'up' : 'down'}>{p.side}</span></td>
                    <td className="r num">{qty(p.volume)}</td>
                    <td className="r num">{price(p.priceOpen)}</td>
                    <td className="r num faint">{p.sl === null ? '—' : price(p.sl)} / {p.tp === null ? '—' : price(p.tp)}</td>
                    <td className={`r num ${p.profit + p.swap >= 0 ? 'up' : 'down'}`}>{qty(p.profit + p.swap)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="faint" style={{ padding: '8px 14px', fontSize: 11.5 }}>From the MT5 terminal · fetched {ago(a.fetchedAt, now)}{a.account.company ? ` · ${a.account.company}` : ''}</div>
        </>
      )}
    </Panel>
  )
}
