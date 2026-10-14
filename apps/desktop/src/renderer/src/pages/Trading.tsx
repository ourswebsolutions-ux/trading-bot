import { useState } from 'react'
import type { PaperPosition, Timeframe } from '@shared/ipc'
import { CandleChart } from '../components/charts'
import { PaywallBanner, useAccess } from '../components/paywall'
import { Banner, Button, ConfirmDialog, Empty, ErrorState, Field, Panel, Segmented, Skeleton, useToast } from '../components/ui'
import { call, errorMessage } from '../lib/api'
import { dateTime, money, pct, price, qty } from '../lib/format'
import { useResource } from '../lib/hooks'
import { useApp } from '../lib/state'

const TF_DAYS: Record<Timeframe, number> = { '5m': 2, '15m': 5, '1h': 14, '4h': 45, '1d': 240 }

export function Trading() {
  const { prefs } = useApp()
  const toast = useToast()
  const { allowed } = useAccess()
  const [symbol, setSymbol] = useState(prefs?.defaultSymbol ?? 'BTCUSD')
  const [tf, setTf] = useState<Timeframe>('15m')
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [quantity, setQuantity] = useState('0.01')
  const [confirm, setConfirm] = useState<null | { kind: 'order' } | { kind: 'close'; p: PaperPosition } | { kind: 'reset' }>(null)

  const symbols = useResource(() => call('market:symbols'), [])
  const ticker = useResource(async () => (await call('market:tickers', { symbols: [symbol] }))[0] ?? null, [symbol], { pollMs: 5000 })
  const candles = useResource(() => call('market:candles', { symbol, timeframe: tf, days: TF_DAYS[tf] }), [symbol, tf], { pollMs: 60_000 })
  const positions = useResource(() => call('paper:positions'), [], { pollMs: 10_000 })
  const orders = useResource(() => call('paper:orders'), [])

  const q = Number(quantity)
  const qtyValid = Number.isFinite(q) && q > 0
  const mark = ticker.data?.markPrice
  const notional = qtyValid && mark ? q * mark : null

  const refresh = () => Promise.all([positions.reload(), orders.reload()])

  const placeOrder = async () => {
    try {
      const o = await call('paper:placeOrder', { symbol, side, quantity: q })
      toast({ tone: 'ok', title: `Paper ${o.side} filled`, body: `${qty(o.quantity)} ${o.symbol} @ ${price(o.fillPrice)}` })
      await refresh()
    } catch (err) {
      toast({ tone: 'bad', title: 'Order not placed', body: errorMessage(err) })
      throw err
    }
  }

  const symbolOptions = symbols.data?.includes(symbol) ? symbols.data : [symbol, ...(symbols.data ?? [])]

  return (
    <div className="page">
      <Banner tone="info" icon="shield" title="Live trading is disabled in this release">
        Orders on this page are simulated. They fill at the current Delta Exchange mark price and never reach an exchange.
      </Banner>
      <PaywallBanner feature="Paper trading" />

      <div className="grid split">
        <Panel
          title={
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
              <select className="select mono" style={{ width: 150, height: 28 }} value={symbol} onChange={(e) => setSymbol(e.target.value)} aria-label="Market">
                {symbolOptions.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              {ticker.data && (
                <span className="num" style={{ textTransform: 'none', letterSpacing: 0, color: 'var(--text)', fontSize: 13 }}>
                  {price(ticker.data.markPrice)} <span className={(ticker.data.change24hPct ?? 0) >= 0 ? 'up' : 'down'}>{pct(ticker.data.change24hPct)}</span>
                </span>
              )}
            </span>
          }
          actions={<Segmented value={tf} onChange={setTf} options={(['5m', '15m', '1h', '4h', '1d'] as Timeframe[]).map((v) => ({ value: v, label: v }))} />}
        >
          {candles.error ? <ErrorState message={candles.error} onRetry={candles.reload} /> : !candles.data ? <Skeleton height={340} /> : <CandleChart candles={candles.data} height={340} />}
        </Panel>

        <Panel title="Paper order">
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault()
              if (qtyValid && allowed) setConfirm({ kind: 'order' })
            }}
          >
            <Segmented className="side" value={side} onChange={setSide} options={[{ value: 'buy', label: 'Buy / Long', className: 'buy' }, { value: 'sell', label: 'Sell / Short', className: 'sell' }]} />
            <Field label="Quantity" hint="Contract units of the underlying (e.g. BTC)" error={quantity && !qtyValid ? 'Enter a positive number' : undefined}>
              <input className="input mono" inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
            </Field>
            <dl className="kv" style={{ gridTemplateColumns: '1fr auto' }}>
              <dt>Mark price</dt><dd className="num r" style={{ textAlign: 'right' }}>{ticker.error ? <span className="down">unavailable</span> : price(mark)}</dd>
              <dt>Est. notional</dt><dd className="num" style={{ textAlign: 'right' }}>{money(notional)}</dd>
              <dt>Funding (8h)</dt><dd className="num" style={{ textAlign: 'right' }}>{ticker.data?.fundingRate !== null && ticker.data?.fundingRate !== undefined ? pct(ticker.data.fundingRate, 4) : '—'}</dd>
            </dl>
            <Button type="submit" variant={side} size="lg" block disabled={!qtyValid || !allowed || !mark}>
              {side === 'buy' ? 'Buy' : 'Sell'} {qtyValid ? qty(q) : ''} {symbol}
            </Button>
            <p className="faint" style={{ margin: 0, fontSize: 12 }}>Simulated fill at mark price. No fees, slippage or funding are applied to paper fills.</p>
          </form>
        </Panel>
      </div>

      <Panel
        title="Paper positions"
        actions={<Button size="sm" variant="ghost" icon="trash" onClick={() => setConfirm({ kind: 'reset' })} disabled={!orders.data?.length}>Reset paper account</Button>}
        flush
      >
        {positions.error ? <ErrorState message={positions.error} onRetry={positions.reload} /> : !positions.data ? <div className="panel-body"><Skeleton /></div> : positions.data.length === 0 ? (
          <Empty icon="trading" title="No paper positions">Place a paper order above to start tracking a simulated position.</Empty>
        ) : (
          <table className="data">
            <thead><tr><th>Contract</th><th className="r">Quantity</th><th className="r">Avg price</th><th className="r">Mark</th><th className="r">Unrealized</th><th className="r">Realized</th><th className="r" /></tr></thead>
            <tbody>
              {positions.data.map((p) => (
                <tr key={p.symbol}>
                  <td className="mono">{p.symbol}</td>
                  <td className={`r num ${p.quantity > 0 ? 'up' : p.quantity < 0 ? 'down' : 'faint'}`}>{p.quantity === 0 ? 'flat' : qty(p.quantity)}</td>
                  <td className="r num">{p.quantity ? price(p.avgPrice) : '—'}</td>
                  <td className="r num">{price(p.markPrice)}</td>
                  <td className={`r num ${(p.unrealizedPnl ?? 0) >= 0 ? 'up' : 'down'}`}>{p.unrealizedPnl === null ? <span className="faint" title="Mark price unavailable">—</span> : money(p.unrealizedPnl, { sign: true })}</td>
                  <td className={`r num ${p.realizedPnl >= 0 ? 'up' : 'down'}`}>{money(p.realizedPnl, { sign: true })}</td>
                  <td className="r">{p.quantity !== 0 && <Button size="sm" disabled={!allowed} onClick={() => setConfirm({ kind: 'close', p })}>Close</Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="Order history" flush>
        {!orders.data ? <div className="panel-body"><Skeleton /></div> : orders.data.length === 0 ? <Empty icon="clock" title="No paper orders yet" /> : (
          <div className="table-wrap" style={{ maxHeight: 320 }}>
            <table className="data">
              <thead><tr><th>Time</th><th>Contract</th><th>Side</th><th className="r">Quantity</th><th className="r">Fill price</th><th className="r">Notional</th></tr></thead>
              <tbody>
                {orders.data.map((o) => (
                  <tr key={o.id}>
                    <td className="nowrap faint">{dateTime(o.createdAt)}</td>
                    <td className="mono">{o.symbol}</td>
                    <td className={o.side === 'buy' ? 'up' : 'down'}>{o.side.toUpperCase()}</td>
                    <td className="r num">{qty(o.quantity)}</td>
                    <td className="r num">{price(o.fillPrice)}</td>
                    <td className="r num">{money(o.quantity * o.fillPrice)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {confirm?.kind === 'order' && (
        <ConfirmDialog title={`Confirm paper ${side}`} confirmLabel={`Place paper ${side}`} onClose={() => setConfirm(null)} onConfirm={placeOrder}>
          {side === 'buy' ? 'Buy' : 'Sell'} <b className="mono">{qty(q)} {symbol}</b> at the current mark price (≈ {price(mark)}, notional ≈ {money(notional)}). This is a simulated order.
        </ConfirmDialog>
      )}
      {confirm?.kind === 'close' && (
        <ConfirmDialog
          title={`Close ${confirm.p.symbol} position?`}
          confirmLabel="Close position"
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            try {
              const o = await call('paper:closePosition', { symbol: confirm.p.symbol })
              toast({ tone: 'ok', title: 'Position closed', body: `${o.side.toUpperCase()} ${qty(o.quantity)} @ ${price(o.fillPrice)}` })
              await refresh()
            } catch (err) {
              toast({ tone: 'bad', title: 'Could not close position', body: errorMessage(err) })
              throw err
            }
          }}
        >
          A paper {confirm.p.quantity > 0 ? 'sell' : 'buy'} of {qty(Math.abs(confirm.p.quantity))} {confirm.p.symbol} will be filled at the current mark price.
        </ConfirmDialog>
      )}
      {confirm?.kind === 'reset' && (
        <ConfirmDialog
          title="Reset paper account?"
          tone="danger"
          confirmLabel="Delete all paper orders"
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            try {
              await call('paper:reset')
              toast({ tone: 'ok', title: 'Paper account reset' })
              await refresh()
            } catch (err) {
              toast({ tone: 'bad', title: 'Reset failed', body: errorMessage(err) })
              throw err
            }
          }}
        >
          All paper orders and positions will be deleted. Strategies and backtests are not affected.
        </ConfirmDialog>
      )}
    </div>
  )
}
