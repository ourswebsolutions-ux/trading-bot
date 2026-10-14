import { useState } from 'react'
import type { Timeframe } from '@shared/ipc'
import { CandleChart } from '../components/charts'
import { Icon } from '../components/icons'
import { Badge, Button, Empty, ErrorState, Panel, Segmented, Skeleton, StatusDot } from '../components/ui'
import { call } from '../lib/api'
import { ago, compact, date, duration, money, pct, price, STRATEGY_LABELS } from '../lib/format'
import { useNow, useResource } from '../lib/hooks'
import { serverNow, useApp } from '../lib/state'

const TF_DAYS: Record<Timeframe, number> = { '5m': 2, '15m': 5, '1h': 14, '4h': 45, '1d': 240 }

function AccessTile() {
  const { subscription, navigate } = useApp()
  const now = useNow(1000)
  const s = subscription?.status
  let value = '—'
  let sub = subscription?.access.detail ?? 'Checking…'
  if (s?.subscription?.status === 'active') {
    value = s.subscription.planCode === 'lifetime' ? 'Lifetime' : 'Monthly'
    sub = s.subscription.expiresAt ? `Renews/expires ${date(s.subscription.expiresAt)}` : 'No expiry'
  } else if (s?.trial.active) {
    value = duration(Math.max(0, Date.parse(s.trial.endsAt) - serverNow(subscription, now)))
    sub = `Free trial · ends ${date(s.trial.endsAt)}`
  } else if (s) {
    value = 'Inactive'
    sub = 'Paid features paused'
  }
  return (
    <button className="panel tile" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => navigate('subscription')}>
      <span className="label">Access</span>
      <span className="value">{value}</span>
      <span className="sub">{sub}</span>
    </button>
  )
}

export function Dashboard() {
  const { prefs, engine, navigate, updates } = useApp()
  const [symbol, setSymbol] = useState(prefs?.defaultSymbol ?? 'BTCUSD')
  const [tf, setTf] = useState<Timeframe>('1h')
  const candles = useResource(() => call('market:candles', { symbol, timeframe: tf, days: TF_DAYS[tf] }), [symbol, tf], { pollMs: 60_000 })
  const tickers = useResource(() => call('market:tickers', {}), [], { pollMs: 10_000 })
  const strategies = useResource(() => call('strategies:list', {}), [])
  const positions = useResource(() => call('paper:positions'), [], { pollMs: 15_000 })
  const notes = useResource(() => call('notifications:list'), [])

  const totalPnl = positions.data?.reduce((a, p) => a + (p.unrealizedPnl ?? 0) + p.realizedPnl, 0)
  const open = positions.data?.filter((p) => p.quantity !== 0).length ?? 0
  const active = strategies.data?.filter((s) => s.status !== 'archived') ?? []
  const lastTicker = tickers.data?.find((t) => t.symbol === symbol)

  return (
    <div className="page">
      <div className="grid cols-4">
        <AccessTile />
        <div className="panel tile">
          <span className="label">Strategies</span>
          <span className="value">{strategies.data ? active.length : '—'}</span>
          <span className="sub">{strategies.data ? `${active.filter((s) => s.status === 'paper').length} marked for paper · ${active.filter((s) => s.status === 'draft').length} draft` : 'Loading…'}</span>
        </div>
        <div className="panel tile">
          <span className="label">Paper P&amp;L</span>
          <span className={`value ${totalPnl === undefined ? '' : totalPnl >= 0 ? 'up' : 'down'}`}>{totalPnl === undefined ? '—' : money(totalPnl, { sign: true })}</span>
          <span className="sub">{open} open position{open === 1 ? '' : 's'} · simulated</span>
        </div>
        <div className="panel tile">
          <span className="label">Engine</span>
          <span className="value" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <StatusDot tone={engine?.state === 'ready' ? 'ok' : engine?.state === 'error' ? 'bad' : undefined} />
            {engine?.state ?? '—'}
          </span>
          <span className="sub" title={engine?.message ?? ''}>{engine?.state === 'ready' ? `Python ${engine.python} · live trading off` : engine?.message ?? 'Starts on first backtest'}</span>
        </div>
      </div>

      <div className="grid split">
        <Panel
          title={
            <span style={{ display: 'inline-flex', gap: 10, alignItems: 'baseline' }}>
              {symbol}
              {lastTicker && <span className="num" style={{ textTransform: 'none', letterSpacing: 0, color: 'var(--text)', fontSize: 13 }}>{price(lastTicker.markPrice)} <span className={(lastTicker.change24hPct ?? 0) >= 0 ? 'up' : 'down'}>{pct(lastTicker.change24hPct)}</span></span>}
            </span>
          }
          actions={<Segmented value={tf} onChange={setTf} options={(['5m', '15m', '1h', '4h', '1d'] as Timeframe[]).map((v) => ({ value: v, label: v }))} />}
        >
          {candles.error ? <ErrorState message={candles.error} onRetry={candles.reload} /> : !candles.data ? <Skeleton height={320} /> : candles.data.length === 0 ? <Empty title="No candles" icon="trading">Delta Exchange returned no data for {symbol}.</Empty> : <CandleChart candles={candles.data} height={320} />}
        </Panel>
        <Panel title="Markets" actions={<span className="faint" style={{ fontSize: 11.5 }}>Delta perpetuals · by volume</span>} flush>
          {tickers.error ? <ErrorState message={tickers.error} onRetry={tickers.reload} /> : !tickers.data ? <div className="panel-body" style={{ display: 'grid', gap: 10 }}>{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} />)}</div> : (
            <table className="data">
              <thead><tr><th>Contract</th><th className="r">Mark</th><th className="r">24h</th><th className="r">Vol</th></tr></thead>
              <tbody>
                {tickers.data.map((t) => (
                  <tr key={t.symbol} className="clickable" onClick={() => setSymbol(t.symbol)} style={t.symbol === symbol ? { boxShadow: 'inset 2px 0 0 var(--accent)' } : undefined}>
                    <td className="mono">{t.symbol}</td>
                    <td className="r num">{price(t.markPrice)}</td>
                    <td className={`r num ${(t.change24hPct ?? 0) >= 0 ? 'up' : 'down'}`}>{pct(t.change24hPct)}</td>
                    <td className="r num faint">{compact(t.volume24hUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>

      <div className="grid cols-3">
        <Panel title="Recent backtests" actions={<Button size="sm" variant="ghost" onClick={() => navigate('analytics')}>Open analytics</Button>} flush>
          {(() => {
            const runs = active.filter((s) => s.lastBacktest).sort((a, b) => b.lastBacktest!.createdAt.localeCompare(a.lastBacktest!.createdAt)).slice(0, 5)
            if (!strategies.data) return <div className="panel-body"><Skeleton /></div>
            if (!runs.length) return <Empty icon="analytics" title="No backtests yet" action={<Button size="sm" onClick={() => navigate(active.length ? 'analytics' : 'strategies')}>{active.length ? 'Run a backtest' : 'Create a strategy'}</Button>}>Backtest a strategy to see its performance here.</Empty>
            return (
              <table className="data">
                <tbody>
                  {runs.map((s) => (
                    <tr key={s.id} className="clickable" onClick={() => navigate('analytics', { strategy: s.id })}>
                      <td><div>{s.name}</div><div className="faint" style={{ fontSize: 11.5 }}>{STRATEGY_LABELS[s.type]} · {s.symbol} {s.timeframe}</div></td>
                      <td className={`r num ${s.lastBacktest!.metrics.totalReturnPct >= 0 ? 'up' : 'down'}`}>{pct(s.lastBacktest!.metrics.totalReturnPct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          })()}
        </Panel>
        <Panel title="Notifications" actions={<Button size="sm" variant="ghost" onClick={() => navigate('notifications')}>View all</Button>} flush>
          {!notes.data ? <div className="panel-body"><Skeleton /></div> : notes.data.length === 0 ? <Empty icon="bell" title="You're all caught up" /> : (
            notes.data.slice(0, 5).map((n) => (
              <div key={n.id} className={`notif ${n.readAt ? '' : 'unread'}`} style={{ gridTemplateColumns: '1fr auto' }}>
                <div><div className="n-title">{n.title}</div><div className="n-body">{n.body}</div></div>
                <div className="n-time">{ago(n.createdAt)}</div>
              </div>
            ))
          )}
        </Panel>
        <Panel title="Application">
          <dl className="kv">
            <dt>Version</dt><dd className="mono">{updates?.currentVersion ?? '—'}</dd>
            <dt>Updates</dt>
            <dd>
              {updates?.phase === 'up_to_date' && <Badge tone="ok">Up to date</Badge>}
              {updates?.phase === 'downloaded' && <Badge tone="accent">Ready to install</Badge>}
              {updates?.phase === 'downloading' && <Badge tone="info">Downloading</Badge>}
              {updates?.phase === 'error' && <Badge tone="bad">Error</Badge>}
              {updates?.phase === 'disabled' && <Badge>Not configured</Badge>}
              {(updates?.phase === 'checking' || updates?.phase === 'idle' || updates?.phase === 'available') && <Badge tone="info">Checking</Badge>}
            </dd>
            <dt>Live trading</dt><dd><Badge tone="warn"><Icon name="lock" size={11} /> Disabled in Phase 1</Badge></dd>
            <dt>Last update check</dt><dd>{ago(updates?.lastCheckedAt)}</dd>
          </dl>
        </Panel>
      </div>
    </div>
  )
}
