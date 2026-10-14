import { useEffect, useMemo, useState } from 'react'
import type { BacktestResult } from '@shared/ipc'
import { MAX_BACKTEST_DAYS } from '@shared/strategySpec'
import { CandleChart, LineChart, type ChartMarker } from '../components/charts'
import { PaywallBanner, useAccess } from '../components/paywall'
import { Banner, Button, Empty, Field, Panel, Skeleton } from '../components/ui'
import { call, errorMessage } from '../lib/api'
import { dateTime, money, pct, price, qty, STRATEGY_LABELS } from '../lib/format'
import { useResource } from '../lib/hooks'
import { useApp } from '../lib/state'

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <div className="panel tile">
      <span className="label">{label}</span>
      <span className={`value ${tone ?? ''}`} style={{ fontSize: 19 }}>{value}</span>
    </div>
  )
}

const REASONS: Record<string, string> = { signal: 'Signal', stop_loss: 'Stop loss', take_profit: 'Take profit', end_of_data: 'End of data' }

export function Analytics() {
  const { params, navigate, engine } = useApp()
  const { allowed } = useAccess()
  const strategies = useResource(() => call('strategies:list', {}), [])
  const [strategyId, setStrategyId] = useState(params.strategy ?? '')
  const [days, setDays] = useState(60)
  const [result, setResult] = useState<BacktestResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  useEffect(() => {
    if (!strategyId && strategies.data?.[0]) setStrategyId(strategies.data[0].id)
  }, [strategies.data, strategyId])
  const selected = strategies.data?.find((s) => s.id === strategyId)
  const maxDays = selected ? MAX_BACKTEST_DAYS[selected.timeframe] : 365
  useEffect(() => {
    if (days > maxDays) setDays(maxDays)
  }, [maxDays, days])

  const run = async () => {
    if (!selected || running) return
    setRunning(true)
    setError(null)
    try {
      setResult(await call('strategies:backtest', { id: selected.id, days }))
      void strategies.reload()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setRunning(false)
    }
  }

  const markers = useMemo<ChartMarker[]>(() => {
    if (!result) return []
    const out: ChartMarker[] = []
    for (const t of result.trades) {
      out.push({ time: t.entryTime, price: t.entryPrice, kind: t.side === 'long' ? 'entry-long' : 'entry-short' })
      out.push({ time: t.exitTime, price: t.exitPrice, kind: 'exit' })
    }
    return out
  }, [result])

  const m = result?.metrics
  const shown = result && result.strategyId === strategyId ? result : null

  return (
    <div className="page">
      <PaywallBanner feature="Backtesting" />
      <Panel title="Backtest">
        {!strategies.data ? <Skeleton height={32} /> : strategies.data.length === 0 ? (
          <Empty icon="strategies" title="No strategies to analyse" action={<Button variant="primary" onClick={() => navigate('strategies')}>Create a strategy</Button>} />
        ) : (
          <div className="form-row" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr) auto', alignItems: 'end' }}>
            <Field label="Strategy">
              <select className="select" value={strategyId} onChange={(e) => { setStrategyId(e.target.value); setResult(null); setError(null) }}>
                {strategies.data.map((s) => <option key={s.id} value={s.id}>{s.name} — {s.symbol} {s.timeframe} · {STRATEGY_LABELS[s.type]}</option>)}
              </select>
            </Field>
            <Field label="Lookback (days)" hint={`Up to ${maxDays} days for ${selected?.timeframe ?? 'this'} candles`}>
              <input className="input mono" type="number" min={1} max={maxDays} value={days} onChange={(e) => setDays(Math.max(1, Math.min(maxDays, Number(e.target.value) || 1)))} />
            </Field>
            <div style={{ paddingBottom: 18 }}>
              <Button variant="primary" icon="play" onClick={run} loading={running} disabled={!selected || !allowed}>{running ? 'Running…' : 'Run backtest'}</Button>
            </div>
          </div>
        )}
        {running && <p className="muted" style={{ margin: '4px 0 0' }}>Downloading {selected?.symbol} candles from Delta Exchange and running the Python engine{engine?.state !== 'ready' ? ' (starting engine)' : ''}…</p>}
        {error && <div style={{ marginTop: 12 }}><Banner tone="bad" title="Backtest failed">{error}</Banner></div>}
      </Panel>

      {shown && m && (
        <>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(6, minmax(0, 1fr))' }}>
            <Metric label="Total return" value={pct(m.totalReturnPct)} tone={m.totalReturnPct >= 0 ? 'up' : 'down'} />
            <Metric label="Buy & hold" value={pct(m.buyHoldReturnPct)} tone={m.buyHoldReturnPct >= 0 ? 'up' : 'down'} />
            <Metric label="Max drawdown" value={pct(-m.maxDrawdownPct, 2, false)} tone={m.maxDrawdownPct > 0 ? 'down' : undefined} />
            <Metric label="Trades / win rate" value={`${m.trades} · ${m.winRatePct === null ? '—' : `${m.winRatePct.toFixed(0)}%`}`} />
            <Metric label="Profit factor" value={m.profitFactor === null ? '—' : m.profitFactor.toFixed(2)} />
            <Metric label="Sharpe (ann.)" value={m.sharpe === null ? '—' : m.sharpe.toFixed(2)} />
          </div>
          <div className="grid cols-2">
            <Panel title={`Equity · ${money(m.initialEquity, { digits: 0 })} start`} actions={<span className="faint mono" style={{ fontSize: 11.5 }}>{m.bars} bars · {m.exposurePct.toFixed(0)}% in market</span>}>
              <LineChart points={shown.equityCurve} height={280} baseline={m.initialEquity} format={(v) => money(v, { digits: 0 })} />
            </Panel>
            <Panel title={`${shown.symbol} ${shown.timeframe} · entries ▲▼ exits ○`}>
              <CandleChart candles={shown.candles} height={280} markers={markers} />
            </Panel>
          </div>
          <Panel title={`Trades (${shown.trades.length})`} flush>
            {shown.trades.length === 0 ? <Empty icon="info" title="No trades">The rule never triggered in this window. Try a longer lookback or different parameters.</Empty> : (
              <div className="table-wrap" style={{ maxHeight: 360 }}>
                <table className="data">
                  <thead><tr><th>Side</th><th>Entry</th><th className="r">Entry price</th><th>Exit</th><th className="r">Exit price</th><th className="r">Qty</th><th>Exit reason</th><th className="r">P&amp;L</th><th className="r">Return</th></tr></thead>
                  <tbody>
                    {shown.trades.map((t, i) => (
                      <tr key={i}>
                        <td className={t.side === 'long' ? 'up' : 'down'}>{t.side.toUpperCase()}</td>
                        <td className="nowrap faint">{dateTime(t.entryTime)}</td>
                        <td className="r num">{price(t.entryPrice)}</td>
                        <td className="nowrap faint">{dateTime(t.exitTime)}</td>
                        <td className="r num">{price(t.exitPrice)}</td>
                        <td className="r num">{qty(t.quantity)}</td>
                        <td>{REASONS[t.exitReason] ?? t.exitReason}</td>
                        <td className={`r num ${t.pnl >= 0 ? 'up' : 'down'}`}>{money(t.pnl, { sign: true })}</td>
                        <td className={`r num ${t.returnPct >= 0 ? 'up' : 'down'}`}>{pct(t.returnPct)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
          <p className="faint" style={{ margin: 0, fontSize: 12 }}>
            Signals are evaluated on candle close and filled at the next candle's open; stops are checked intrabar and assumed to fill before targets. Past performance does not predict future results.
          </p>
        </>
      )}

      {!shown && strategies.data && strategies.data.length > 0 && !running && (
        <Panel title="Backtest history" flush>
          {strategies.data.some((s) => s.lastBacktest) ? (
            <table className="data">
              <thead><tr><th>Strategy</th><th>Ran</th><th className="r">Return</th><th className="r">Max DD</th><th className="r">Trades</th><th className="r" /></tr></thead>
              <tbody>
                {strategies.data.filter((s) => s.lastBacktest).map((s) => (
                  <tr key={s.id}>
                    <td>{s.name} <span className="faint mono">{s.symbol} {s.timeframe}</span></td>
                    <td className="faint">{dateTime(s.lastBacktest!.createdAt)}</td>
                    <td className={`r num ${s.lastBacktest!.metrics.totalReturnPct >= 0 ? 'up' : 'down'}`}>{pct(s.lastBacktest!.metrics.totalReturnPct)}</td>
                    <td className="r num down">{pct(-s.lastBacktest!.metrics.maxDrawdownPct, 2, false)}</td>
                    <td className="r num">{s.lastBacktest!.metrics.trades}</td>
                    <td className="r"><Button size="sm" variant="ghost" onClick={() => setStrategyId(s.id)}>Select</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <Empty icon="analytics" title="No backtests yet">Choose a strategy above and run a backtest to see equity, drawdown and every simulated trade.</Empty>}
        </Panel>
      )}
    </div>
  )
}
