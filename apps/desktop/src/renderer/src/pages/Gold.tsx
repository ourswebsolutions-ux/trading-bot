import { useEffect, useState } from 'react'
import type { BacktestResult, CandleSeries, GoldPositionView, GoldStatus } from '@shared/ipc'
import { DEFAULT_GOLD_SETTINGS, GOLD_LIMITS, GOLD_TF_LABEL, validateGoldSettings, type GoldSettings } from '@shared/gold'
import { CandleChart } from '../components/charts'
import { Icon } from '../components/icons'
import { PaywallBanner, useAccess } from '../components/paywall'
import { Badge, Banner, Button, ConfirmDialog, Dialog, Empty, ErrorState, Field, Panel, PasswordInput, Segmented, Skeleton, StatusDot, useToast } from '../components/ui'
import { call, errorMessage, fieldErrors } from '../lib/api'
import { ago, dateTime } from '../lib/format'
import { useNow, useResource } from '../lib/hooks'
import { useApp } from '../lib/state'

type ChartTf = '1m' | '5m' | '15m'
const num = (v: number | null | undefined, digits = 2) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }))
const signed = (v: number | null | undefined, ccy = '') => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${num(v)}${ccy ? ` ${ccy}` : ''}`)
const TREND: Record<string, { label: string; tone: 'ok' | 'bad' | undefined; arrow: string }> = { up: { label: 'Uptrend', tone: 'ok', arrow: '▲' }, down: { label: 'Downtrend', tone: 'bad', arrow: '▼' }, sideways: { label: 'Sideways', tone: undefined, arrow: '◆' } }

/** Runs an action, shows its result, and hands back the new status. */
function useGoldAction(onStatus: (s: GoldStatus) => void) {
  const toast = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  const run = async <T,>(key: string, fn: () => Promise<T>, ok?: string, pick: (r: T) => GoldStatus = (r) => r as unknown as GoldStatus): Promise<T> => {
    setBusy(key)
    try {
      const r = await fn()
      onStatus(pick(r))
      if (ok) toast({ tone: 'ok', title: ok })
      return r
    } catch (err) {
      toast({ tone: 'bad', title: 'Not done', body: errorMessage(err) })
      throw err
    } finally {
      setBusy(null)
    }
  }
  return { busy, run }
}

// ---------- header: connection, account, bot ----------
function StatusBar({ s, onStatus }: { s: GoldStatus; onStatus: (s: GoldStatus) => void }) {
  const { navigate } = useApp()
  const { busy, run } = useGoldAction(onStatus)
  const sess = s.bot.session
  const running = sess && sess.status !== 'stopped'
  return (
    <div className="gold-status">
      <div className="gold-status-item">
        <StatusDot tone={s.connected ? 'ok' : s.platformSupported ? 'bad' : 'warn'} />
        <div>
          <div className="gs-label">MetaTrader 5</div>
          <div className="gs-value">{!s.platformSupported ? 'Windows only' : s.connected ? 'Connected' : s.userDisconnected ? 'Disconnected' : s.configured ? 'Not connected' : 'Not set up'}</div>
        </div>
        {s.platformSupported && s.configured && (s.connected
          ? <Button size="sm" variant="ghost" loading={busy === 'disc'} onClick={() => void run('disc', () => call('gold:disconnect'), 'Disconnected from MetaTrader 5').catch(() => undefined)}>Disconnect</Button>
          : <Button size="sm" loading={busy === 'conn'} onClick={() => void run('conn', () => call('gold:connect'), 'Connected to MetaTrader 5').catch(() => undefined)}>Connect</Button>)}
        {s.platformSupported && !s.configured && <Button size="sm" onClick={() => navigate('settings', { tab: 'mt5' })}>Set up</Button>}
      </div>
      <div className="gold-status-item">
        <Icon name="wallet" size={16} />
        <div>
          <div className="gs-label">Account</div>
          <div className="gs-value">{s.account ? <>{s.account.mode === 'real' ? <Badge tone="bad">LIVE · real money</Badge> : <Badge tone="info">{s.account.mode === 'demo' ? 'DEMO' : 'CONTEST'}</Badge>} <span className="mono">{s.account.login}</span></> : '—'}</div>
        </div>
      </div>
      <div className="gold-status-item">
        <Icon name="cpu" size={16} />
        <div>
          <div className="gs-label">Scalper</div>
          <div className="gs-value">{running ? <><span className="live-pulse" /> {sess!.status === 'paused' ? 'Paused' : 'Running'} · {sess!.mode === 'live' ? 'trading the account' : 'paper (simulated)'}</> : 'Stopped'}</div>
        </div>
      </div>
      <div className="gold-status-item">
        <Icon name="bolt" size={16} />
        <div>
          <div className="gs-label">Automatic trading</div>
          <div className="gs-value">{s.liveEnabled ? <Badge tone="warn">ON · orders allowed</Badge> : <Badge>OFF</Badge>}</div>
        </div>
      </div>
      <div className="gold-status-item">
        <Icon name="exchange" size={16} />
        <div>
          <div className="gs-label">Symbol</div>
          <div className="gs-value mono">{s.symbol ?? 'not found'}{s.symbolSource === 'detected' ? <span className="faint"> (detected)</span> : null}</div>
        </div>
      </div>
    </div>
  )
}

// ---------- market tiles ----------
function MarketTiles({ s }: { s: GoldStatus }) {
  const q = s.quote
  const a = s.analysis
  const t = s.trendAnalysis
  const spreadOk = q ? q.spread <= s.settings.maxSpread : null
  const entryTf = GOLD_TF_LABEL[s.settings.timeframe]
  const trendTf = GOLD_TF_LABEL[s.settings.trendTimeframe]
  return (
    <div className="grid cols-4">
      <div className="panel tile gold-price">
        <span className="label">{s.symbol ?? 'XAUUSD'} · {q?.state === 'closed' ? 'market closed' : q?.state ?? 'no price'}</span>
        <span className="value">{q ? num((q.bid + q.ask) / 2) : '—'}</span>
        <span className="sub mono">bid {num(q?.bid)} · ask {num(q?.ask)}</span>
        <span className={`sub ${spreadOk === false ? 'down' : ''}`}>spread {q ? num(q.spread) : '—'} {spreadOk === false ? `(above your max ${s.settings.maxSpread})` : spreadOk ? '· OK' : ''}</span>
      </div>
      <div className="panel tile">
        <span className="label">Market direction</span>
        <div className="trend-row">
          {([[trendTf, t], [entryTf, a]] as const).map(([label, x]) => (
            <div key={label} className={`trend-chip ${x?.trend ?? ''}`}>
              <span className="faint">{label}</span>
              <b>{x ? `${TREND[x.trend]!.arrow} ${TREND[x.trend]!.label}` : '—'}</b>
            </div>
          ))}
        </div>
        <span className="sub">{a ? `RSI ${num(a.rsi, 1)} · MACD ${a.momentum ?? '—'} · ${a.pattern.replace(/_/g, ' ')} candle` : s.analysisError ?? 'waiting for market data'}</span>
        {a && <span className="sub mono">S {num(a.support)} · R {num(a.resistance)}{a.vwap !== null ? ` · VWAP ${num(a.vwap)}` : ''}</span>}
      </div>
      <SignalCard s={s} />
      <div className="panel tile">
        <span className="label">Volatility ({entryTf})</span>
        <span className="value">{a ? num(a.atr) : '—'}</span>
        <span className="sub">ATR(14){a?.atrAverage ? ` · average ${num(a.atrAverage)}` : ''}</span>
        <span className={`sub ${a?.volatility === 'extreme' || a?.volatility === 'high' ? 'down' : ''}`}>{a?.volatility ? `${a.volatility} volatility` : '—'}{a?.lastRangeAtr ? ` · last candle ${a.lastRangeAtr}× ATR` : ''}</span>
      </div>
    </div>
  )
}

function SignalCard({ s }: { s: GoldStatus }) {
  const sig = s.signal
  const blocked = Boolean(sig?.blockedBy.length)
  const cls = !sig || sig.action === 'wait' ? 'wait' : blocked ? 'blocked' : sig.action
  return (
    <div className={`panel tile signal-card ${cls}`}>
      <span className="label">Signal · {GOLD_TF_LABEL[s.settings.timeframe]} closed candle</span>
      <span className="value">{!sig ? '—' : sig.action === 'wait' ? 'WAIT' : `${sig.action.toUpperCase()}${blocked ? ' · blocked' : ''}`}</span>
      {sig && sig.entry !== null ? (
        <span className="sub mono">entry {num(sig.entry)} · SL {num(sig.stopLoss)} · TP {num(sig.takeProfit)} · {sig.lots} lots</span>
      ) : <span className="sub">{sig?.reason ?? s.signalError ?? 'waiting for market data'}</span>}
      {blocked && <span className="sub down" title={sig!.blockedBy.join('\n')}>{sig!.blockedBy[0]}{sig!.blockedBy.length > 1 ? ` (+${sig!.blockedBy.length - 1})` : ''}</span>}
    </div>
  )
}

// ---------- controls ----------
function AutoTradingDialog({ s, onClose, onStatus }: { s: GoldStatus; onClose: () => void; onStatus: (s: GoldStatus) => void }) {
  const toast = useToast()
  const [password, setPassword] = useState('')
  const [phrase, setPhrase] = useState('')
  const [accountNo, setAccountNo] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const real = s.account && s.account.mode !== 'demo'
  return (
    <Dialog title="Turn on automatic trading" onClose={() => !busy && onClose()} footer={
      <>
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="danger" loading={busy} disabled={phrase !== 'ENABLE LIVE TRADING' || !password || Boolean(real && accountNo.trim() !== String(s.account!.login))} onClick={async () => {
          setBusy(true)
          setErrors({})
          try {
            await call('trading:enableLive', { password, confirmation: phrase, accountConfirmation: accountNo.trim(), broker: 'mt5' })
            onStatus(await call('gold:status'))
            toast({ tone: 'ok', title: 'Automatic trading is on', body: 'TradePilot may now place orders on your MetaTrader 5 account.' })
            onClose()
          } catch (err) {
            setErrors(fieldErrors(err))
            toast({ tone: 'bad', title: 'Not turned on', body: errorMessage(err) })
          } finally {
            setBusy(false)
            setPassword('')
          }
        }}>Allow orders</Button>
      </>
    }>
      <p style={{ margin: 0 }}>TradePilot will be allowed to send orders to <b>{s.account ? `${s.account.server}, account ${s.account.login}` : 'your MetaTrader 5 account'}</b>: the scalper (when started) and your manual BUY/SELL. Every order is checked against your risk settings first. Losses are possible; scalping in fast markets can lose quickly.</p>
      {real && <Banner tone="bad" title="This is a REAL-MONEY account">Test on a demo account first. Type the account number to confirm.</Banner>}
      <Field label="Type ENABLE LIVE TRADING" error={errors.confirmation}><input className="input mono" value={phrase} onChange={(e) => setPhrase(e.target.value)} autoComplete="off" /></Field>
      {real && <Field label={`Type the account number (${s.account!.login})`} error={errors.accountConfirmation}><input className="input mono" value={accountNo} onChange={(e) => setAccountNo(e.target.value)} inputMode="numeric" autoComplete="off" /></Field>}
      <Field label="Your TradePilot password" error={errors.password}><PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></Field>
    </Dialog>
  )
}

function Controls({ s, onStatus }: { s: GoldStatus; onStatus: (s: GoldStatus) => void }) {
  const { allowed } = useAccess()
  const toast = useToast()
  const { busy, run } = useGoldAction(onStatus)
  const [autoDialog, setAutoDialog] = useState(false)
  const [manual, setManual] = useState<null | { side: 'buy' | 'sell'; requestId: string }>(null)
  const [stopDialog, setStopDialog] = useState(false)
  const [closeAll, setCloseAll] = useState(false)
  const [estop, setEstop] = useState(false)
  const sess = s.bot.session
  const running = Boolean(sess && sess.status !== 'stopped')
  const ours = s.positions.filter((p) => p.source !== 'other')
  const accountReady = s.connected && !s.accountModeProblem && !s.emergency
  const manualWhy = !s.connected ? 'Connect MetaTrader 5 first' : !s.liveEnabled ? 'Turn on automatic trading to allow orders on your account' : s.accountModeProblem ?? (s.emergency ? 'Emergency stop is active' : undefined)
  return (
    <Panel title="Controls">
      <div className="gold-controls">
        <div className="gc-group">
          {!running ? (
            <Button variant="primary" icon="play" loading={busy === 'start'} disabled={!allowed || s.emergency || !s.symbol} title={!s.symbol ? 'No gold symbol yet' : undefined} onClick={() => void run('start', () => call('gold:start'), s.liveEnabled ? 'Scalper started on your account' : 'Scalper started (paper)').catch(() => undefined)}>Start Scalping</Button>
          ) : <Button icon="stop" onClick={() => setStopDialog(true)}>Stop Scalping</Button>}
          <span className="gc-note">{running ? (sess!.mode === 'live' ? 'Trading your account' : 'Simulating (paper): no real orders') : s.liveEnabled ? `Start trades your ${s.account?.mode === 'real' ? 'REAL-MONEY' : 'demo'} account` : 'Start simulates (paper) until automatic trading is on'}</span>
        </div>
        <div className="gc-group">
          <label className="switch" title="Allow TradePilot to place orders on your MT5 account">
            <input type="checkbox" checked={s.liveEnabled} disabled={busy === 'auto' || (!s.liveEnabled && (!s.connected || !allowed))} onChange={(e) => {
              if (e.target.checked) setAutoDialog(true)
              else void run('auto', async () => { await call('trading:disableLive', { broker: 'mt5' }); return call('gold:status') }, 'Automatic trading is off').catch(() => undefined)
            }} />
            <span className="track"><span className="thumb" /></span>
            <span>Auto Trading {s.liveEnabled ? 'ON' : 'OFF'}</span>
          </label>
        </div>
        <div className="gc-group">
          <Button className="buy-btn" disabled={!allowed || !accountReady || !s.liveEnabled} title={manualWhy} onClick={() => setManual({ side: 'buy', requestId: crypto.randomUUID() })}>Manual BUY</Button>
          <Button className="sell-btn" disabled={!allowed || !accountReady || !s.liveEnabled} title={manualWhy} onClick={() => setManual({ side: 'sell', requestId: crypto.randomUUID() })}>Manual SELL</Button>
          <Button icon="x" disabled={!ours.length} onClick={() => setCloseAll(true)}>Close All Trades</Button>
        </div>
        <div className="gc-group">
          {s.emergency ? (
            <Button loading={busy === 'clear'} onClick={() => void run('clear', async () => { await call('trading:clearEmergency'); return call('gold:status') }, 'Emergency stop cleared').catch(() => undefined)}>Clear emergency stop</Button>
          ) : <Button variant="danger" icon="stop" onClick={() => setEstop(true)}>Emergency Stop</Button>}
        </div>
      </div>
      {autoDialog && <AutoTradingDialog s={s} onStatus={onStatus} onClose={() => setAutoDialog(false)} />}
      {manual && (
        <ConfirmDialog title={`Manual ${manual.side.toUpperCase()} ${s.symbol ?? ''}`} tone={s.account?.mode === 'real' ? 'danger' : 'primary'} confirmLabel={`Send ${manual.side.toUpperCase()} order`} onClose={() => setManual(null)} onConfirm={async () => {
          const r = await run('order', () => call('gold:order', manual), undefined, (x) => x.status)
          const o = r.order
          toast(o.state === 'filled' || o.state === 'partially_filled'
            ? { tone: 'ok', title: `${o.side.toUpperCase()} ${o.volume} lots filled at ${num(o.avgPrice)}`, body: [`SL ${num(o.stopLoss)} · TP ${num(o.takeProfit)}`, o.note].filter(Boolean).join(' · ') }
            : { tone: o.state === 'rejected' ? 'bad' : 'info', title: `Order ${o.state}`, body: o.error ?? 'Checking the result with MetaTrader 5.' })
        }}>
          <p style={{ margin: 0 }}>A market {manual.side.toUpperCase()} order goes to your <b>{s.account?.mode === 'real' ? 'REAL-MONEY' : s.account?.mode ?? ''} account {s.account?.login}</b>. The size follows your risk settings ({s.settings.lotMode === 'risk' ? `${s.settings.riskPercent}% risk` : `${s.settings.fixedLots} lots`}), with a stop-loss of {s.settings.stopAtr} × ATR and a take-profit at {s.settings.takeProfitR}R, placed at the broker. It is refused if the spread, a risk limit or the broker’s rules do not allow it.</p>
          {s.quote && <p className="mono faint" style={{ margin: 0 }}>Now: bid {num(s.quote.bid)} · ask {num(s.quote.ask)} · spread {num(s.quote.spread)}</p>}
        </ConfirmDialog>
      )}
      {stopDialog && sess && (
        <Dialog title="Stop the scalper?" onClose={() => busy === null && setStopDialog(false)} footer={
          <>
            <Button variant="ghost" onClick={() => setStopDialog(false)}>Cancel</Button>
            {sess.position && <Button loading={busy === 'stop-keep'} onClick={() => void run('stop-keep', () => call('gold:stop', { closePosition: false }), 'Scalper stopped').then(() => setStopDialog(false)).catch(() => undefined)}>Stop, keep position</Button>}
            <Button variant="danger" loading={busy === 'stop-close'} onClick={() => void run('stop-close', () => call('gold:stop', { closePosition: Boolean(sess.position) }), 'Scalper stopped').then(() => setStopDialog(false)).catch(() => undefined)}>{sess.position ? 'Stop and close position' : 'Stop'}</Button>
          </>
        }>
          {sess.position ? 'The scalper holds a position. Close it at market now, or keep it with its stop-loss and take-profit.' : 'No new trades will be opened.'}
        </Dialog>
      )}
      {closeAll && (
        <ConfirmDialog title="Close all trades?" tone="danger" confirmLabel="Close all" onClose={() => setCloseAll(false)} onConfirm={async () => {
          const r = await run('closeAll', () => call('gold:closeAll'), undefined, (x) => x.status)
          toast(r.failed.length ? { tone: 'bad', title: `${r.closed} closed, ${r.failed.length} not closed`, body: r.failed.join('; ') } : { tone: 'ok', title: `${r.closed} position${r.closed === 1 ? '' : 's'} closed` })
        }}>
          {ours.length} TradePilot position{ours.length === 1 ? '' : 's'} on {s.symbol} will be closed at market. Positions opened outside TradePilot are not touched.
        </ConfirmDialog>
      )}
      {estop && (
        <ConfirmDialog title="Activate the emergency stop?" tone="danger" confirmLabel="Stop everything now" onClose={() => setEstop(false)} onConfirm={async () => {
          try {
            await call('trading:emergencyStop')
          } catch (err) {
            toast({ tone: 'bad', title: 'Emergency stop needs attention', body: errorMessage(err) })
          }
          onStatus(await call('gold:status'))
        }}>
          All automations stop immediately and no new orders are sent (manual ones included). Open positions are {s.risk.emergencyAction === 'close_positions' ? 'closed at market' : 'kept with their stop-loss and take-profit at the broker'} — change this in Trading → Account risk settings.
        </ConfirmDialog>
      )}
    </Panel>
  )
}

// ---------- statistics ----------
function Stats({ s }: { s: GoldStatus }) {
  const st = s.stats
  const ccy = st.source === 'account' ? st.currency : ''
  const streak = st.currentStreak > 0 ? `${st.currentStreak} win${st.currentStreak === 1 ? '' : 's'}` : st.currentStreak < 0 ? `${-st.currentStreak} loss${st.currentStreak === -1 ? '' : 'es'}` : '—'
  return (
    <div className="balance-strip gold-stats">
      <div className="panel tile"><span className="label">Balance</span><span className="value">{s.account ? num(s.account.balance) : '—'}</span><span className="sub">{s.account?.currency ?? 'MT5 account'}</span></div>
      <div className="panel tile"><span className="label">Equity</span><span className="value">{s.account ? num(s.account.equity) : '—'}</span><span className="sub">free margin {s.account ? num(s.account.marginFree) : '—'}</span></div>
      <div className="panel tile"><span className="label">Today’s P&amp;L</span><span className={`value ${st.todayPnl > 0 ? 'up' : st.todayPnl < 0 ? 'down' : ''}`}>{signed(st.todayPnl)}</span><span className="sub">{st.todayTrades} trade{st.todayTrades === 1 ? '' : 's'} today · {st.source === 'account' ? `${ccy}, from MT5 history` : 'paper (simulated)'}</span></div>
      <div className="panel tile"><span className="label">Win rate</span><span className="value">{st.winRatePct === null ? '—' : `${st.winRatePct}%`}</span><span className="sub">{st.totalTrades} closed trade{st.totalTrades === 1 ? '' : 's'}{st.days ? ` · last ${st.days} days` : ''} · net {signed(st.netPnl)}</span></div>
      <div className="panel tile"><span className="label">Streak</span><span className={`value ${st.currentStreak > 0 ? 'up' : st.currentStreak < 0 ? 'down' : ''}`}>{streak}</span><span className="sub">best run {st.maxWinStreak} wins · worst {st.maxLossStreak} losses</span></div>
    </div>
  )
}

// ---------- chart ----------
function ChartPanel({ s }: { s: GoldStatus }) {
  const [tf, setTf] = useState<ChartTf>(s.settings.timeframe)
  const series = useResource<CandleSeries>(() => call('gold:candles', { timeframe: tf }), [tf, s.symbol, s.connected], { pollMs: tf === '1m' ? 10_000 : 20_000, enabled: s.connected && Boolean(s.symbol) })
  const now = useNow(5000)
  return (
    <Panel title={`${s.symbol ?? 'XAUUSD'} chart`} actions={<Segmented value={tf} onChange={setTf} options={(['1m', '5m', '15m'] as ChartTf[]).map((v) => ({ value: v, label: GOLD_TF_LABEL[v] }))} />}>
      {!s.connected ? <Empty icon="trading" title="No chart">Connect MetaTrader 5 to see live XAUUSD candles.</Empty>
        : series.error ? <ErrorState message={series.error} onRetry={series.reload} />
        : !series.data ? <Skeleton height={340} />
        : series.data.candles.length === 0 ? <Empty icon="trading" title="No candles">MetaTrader 5 returned no data.</Empty>
        : (
          <>
            <CandleChart candles={series.data.candles.slice(-240)} height={340} />
            <div className="faint" style={{ fontSize: 11.5, marginTop: 6 }}>Closed {GOLD_TF_LABEL[tf]} candles from your MT5 terminal (UTC) · updated {ago(series.data.fetchedAt, now)}</div>
          </>
        )}
    </Panel>
  )
}

// ---------- positions ----------
function Positions({ s, onStatus }: { s: GoldStatus; onStatus: (s: GoldStatus) => void }) {
  const { busy, run } = useGoldAction(onStatus)
  const [closing, setClosing] = useState<GoldPositionView | null>(null)
  const [editing, setEditing] = useState<GoldPositionView | null>(null)
  const [sl, setSl] = useState('')
  const [tp, setTp] = useState('')
  const ccy = s.account?.currency ?? ''
  return (
    <Panel title="Open trades" flush>
      {s.positions.length === 0 ? <Empty icon="trading" title="No open trades">Positions on {s.symbol ?? 'XAUUSD'} appear here.</Empty> : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Trade</th><th>Opened by</th><th className="r">Lots</th><th className="r">Open</th><th className="r">Stop-loss</th><th className="r">Take-profit</th><th className="r">P&amp;L</th><th className="r" /></tr></thead>
            <tbody>
              {s.positions.map((p) => (
                <tr key={p.id}>
                  <td><span className={p.side === 'long' ? 'up' : 'down'}>{p.side === 'long' ? 'BUY' : 'SELL'}</span> <span className="faint mono">{p.ticket ?? 'paper'}</span></td>
                  <td>{p.source === 'bot' ? <Badge tone="accent">Scalper{p.paper ? ' · paper' : ''}</Badge> : p.source === 'manual' ? <Badge tone="info">Manual</Badge> : <Badge>Not TradePilot</Badge>}</td>
                  <td className="r num">{p.volume}</td>
                  <td className="r num">{num(p.openPrice)}</td>
                  <td className="r num">{num(p.stopLoss)}</td>
                  <td className="r num">{num(p.takeProfit)}</td>
                  <td className={`r num ${(p.profit ?? 0) >= 0 ? 'up' : 'down'}`}>{signed(p.profit, p.paper ? '' : ccy)}</td>
                  <td className="r">
                    <div className="btn-row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                      {p.source !== 'other' && <Button size="sm" variant="ghost" icon="edit" onClick={() => { setEditing(p); setSl(p.stopLoss?.toString() ?? ''); setTp(p.takeProfit?.toString() ?? '') }}>SL/TP</Button>}
                      <Button size="sm" onClick={() => setClosing(p)}>Close</Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {closing && (
        <ConfirmDialog title={`Close ${closing.side === 'long' ? 'BUY' : 'SELL'} ${closing.volume} lots?`} tone="danger" confirmLabel="Close at market" onClose={() => setClosing(null)} onConfirm={() => run('close', () => call('gold:closePosition', { id: closing.id, confirmForeign: closing.source === 'other' }), 'Position closed')}>
          {closing.source === 'other' ? 'This position was NOT opened by TradePilot (another EA or a manual trade in the terminal). It will be closed at market.' : closing.paper ? 'The simulated position is closed at the current price.' : 'The position is closed at market by its ticket.'}
        </ConfirmDialog>
      )}
      {editing && (
        <Dialog title="Change stop-loss / take-profit" onClose={() => busy === null && setEditing(null)} footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            <Button variant="primary" loading={busy === 'modify'} onClick={() => void run('modify', () => call('gold:modifyPosition', { id: editing.id, stopLoss: sl.trim() === '' ? null : Number(sl), takeProfit: tp.trim() === '' ? null : Number(tp) }), 'Stop-loss / take-profit changed').then(() => setEditing(null)).catch(() => undefined)}>Save</Button>
          </>
        }>
          <p className="muted" style={{ margin: 0 }}>{editing.side === 'long' ? 'BUY: the stop-loss must be below and the take-profit above the current bid' : 'SELL: the stop-loss must be above and the take-profit below the current ask'}, at least the broker’s minimum distance away{s.spec?.minStopDistance ? ` (${s.spec.minStopDistance})` : ''}.</p>
          <div className="form-row">
            <Field label="Stop-loss" hint={editing.source === 'bot' ? 'Required for scalper trades' : 'Empty removes it'}><input className="input mono" inputMode="decimal" value={sl} onChange={(e) => setSl(e.target.value)} /></Field>
            <Field label="Take-profit" hint="Empty removes it"><input className="input mono" inputMode="decimal" value={tp} onChange={(e) => setTp(e.target.value)} /></Field>
          </div>
        </Dialog>
      )}
    </Panel>
  )
}

// ---------- settings ----------
const NUMBER_FIELDS: { key: keyof typeof GOLD_LIMITS; label: string; hint: string; step?: string }[] = [
  { key: 'riskPercent', label: 'Risk per trade (%)', hint: 'Equity lost if the stop-loss is hit' },
  { key: 'fixedLots', label: 'Fixed lot size', hint: 'Used when "Fixed lots" is chosen', step: '0.01' },
  { key: 'stopAtr', label: 'Stop-loss (× ATR)', hint: 'Distance from volatility, ATR(14)' },
  { key: 'takeProfitR', label: 'Take-profit (× risk)', hint: 'Reward : risk, e.g. 1.5' },
  { key: 'minRiskReward', label: 'Minimum reward : risk', hint: 'Take-profit may not be lower' },
  { key: 'maxSpread', label: 'Maximum spread ($)', hint: 'No new trade above this' },
  { key: 'maxTradesPerDay', label: 'Maximum trades per day', hint: 'Scalper and manual trades' },
  { key: 'maxDailyLossPct', label: 'Maximum daily loss (%)', hint: 'No new trades after this' },
  { key: 'maxConsecutiveLosses', label: 'Maximum losses in a row', hint: 'Then no new trades today' },
  { key: 'cooldownMinutes', label: 'Cooldown after a trade (min)', hint: 'Wait before the next entry' },
  { key: 'maxTradeMinutes', label: 'Maximum trade duration (min)', hint: 'Then closed at market' },
  { key: 'maxExtensionAtr', label: 'Extended-move filter (× ATR)', hint: 'No chasing far from EMA 20' },
  { key: 'abnormalRangeAtr', label: 'Spike filter (× ATR)', hint: 'No entry after a huge candle' },
  { key: 'commissionPerLot', label: 'Commission per lot ($)', hint: 'Per side, for backtests' }
]

function SettingsPanel({ s, onStatus }: { s: GoldStatus; onStatus: (s: GoldStatus) => void }) {
  const toast = useToast()
  const [draft, setDraft] = useState<GoldSettings>(s.settings)
  const [text, setText] = useState<Record<string, string>>(() => Object.fromEntries(NUMBER_FIELDS.map((f) => [f.key, String(s.settings[f.key])])))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [confirmLive, setConfirmLive] = useState(false)
  const [open, setOpen] = useState(false)
  const [ev, setEv] = useState({ label: '', start: '', end: '' })
  useEffect(() => {
    setDraft(s.settings)
    setText(Object.fromEntries(NUMBER_FIELDS.map((f) => [f.key, String(s.settings[f.key])])))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(s.settings)])
  const set = <K extends keyof GoldSettings>(k: K, v: GoldSettings[K]) => setDraft((d) => ({ ...d, [k]: v }))
  const local = validateGoldSettings(draft)
  const save = async (confirm = false) => {
    if (draft.accountMode === 'live' && s.settings.accountMode !== 'live' && !confirm) return setConfirmLive(true)
    setSaving(true)
    setErrors({})
    try {
      onStatus(await call('gold:saveSettings', { settings: draft, confirmLive: confirm }))
      toast({ tone: 'ok', title: 'Scalping settings saved', body: 'A running scalper switches to them when it has no open trade.' })
    } catch (err) {
      setErrors(fieldErrors(err))
      toast({ tone: 'bad', title: 'Not saved', body: errorMessage(err) })
    } finally {
      setSaving(false)
    }
  }
  const err = (k: string) => errors[k] ?? local[k]
  const toUtc = (local: string) => (local ? new Date(`${local}:00Z`).toISOString() : '')
  return (
    <Panel title="Scalping settings" actions={<Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)}>{open ? 'Hide' : 'Show all'}</Button>}>
      <div className="form">
        <div className="form-row">
          <Field label="Account mode" hint={draft.accountMode === 'demo' ? 'Orders only on a demo account' : 'Orders only on a real-money account'} error={err('accountMode')}>
            <Segmented value={draft.accountMode} onChange={(v) => set('accountMode', v)} options={[{ value: 'demo', label: 'Demo' }, { value: 'live', label: 'Live' }]} />
          </Field>
          <Field label="Entry timeframe" hint={`Trend from ${GOLD_TF_LABEL[draft.trendTimeframe]}`} error={err('timeframe')}>
            <Segmented value={draft.timeframe} onChange={(v) => set('timeframe', v)} options={[{ value: '1m', label: 'M1' }, { value: '5m', label: 'M5' }]} />
          </Field>
          <Field label="Direction" error={err('direction')}>
            <Segmented value={draft.direction} onChange={(v) => set('direction', v)} options={[{ value: 'both', label: 'Both' }, { value: 'long', label: 'BUY only' }, { value: 'short', label: 'SELL only' }]} />
          </Field>
          <Field label="Lot size" error={err('lotMode')}>
            <Segmented value={draft.lotMode} onChange={(v) => set('lotMode', v)} options={[{ value: 'risk', label: 'From risk %' }, { value: 'fixed', label: 'Fixed lots' }]} />
          </Field>
        </div>
        <div className="form-row">
          {NUMBER_FIELDS.slice(0, open ? NUMBER_FIELDS.length : 8).map((f) => (
            <Field key={f.key} label={f.label} hint={f.hint} error={err(f.key)}>
              <input className={`input mono ${err(f.key) ? 'invalid' : ''}`} inputMode="decimal" value={text[f.key] ?? ''} onChange={(e) => {
                setText({ ...text, [f.key]: e.target.value })
                set(f.key, (e.target.value.trim() === '' ? Number.NaN : Number(e.target.value)) as never)
              }} />
            </Field>
          ))}
        </div>
        {open && (
          <>
            <div className="form-row">
              <Field label="Entry style" hint="How the entry is timed" error={err('entryStyle')}>
                <select className="select" value={draft.entryStyle} onChange={(e) => set('entryStyle', e.target.value as GoldSettings['entryStyle'])}>
                  <option value="pullback">Pullback to EMA 20, close back above EMA 9</option>
                  <option value="breakout">Breakout of the last 10 candles</option>
                  <option value="momentum">MACD momentum cross</option>
                </select>
              </Field>
              <Field label="Trend timeframe" error={err('trendTimeframe')}>
                <select className="select" value={draft.trendTimeframe} onChange={(e) => set('trendTimeframe', e.target.value as GoldSettings['trendTimeframe'])}>
                  <option value="15m">M15</option><option value="30m">M30</option><option value="1h">H1</option>
                </select>
              </Field>
              <Field label="Trading session (UTC)" hint="Empty = whenever the market is open" error={err('session')}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input className="input mono" placeholder="07:00" value={draft.session?.start ?? ''} onChange={(e) => set('session', e.target.value || draft.session?.end ? { start: e.target.value, end: draft.session?.end ?? '' } : null)} />
                  <input className="input mono" placeholder="20:00" value={draft.session?.end ?? ''} onChange={(e) => set('session', e.target.value || draft.session?.start ? { start: draft.session?.start ?? '', end: e.target.value } : null)} />
                </div>
              </Field>
              <Field label="Gold symbol" hint={s.candidates.length ? `Detected: ${s.candidates.map((c) => c.symbol).join(', ')}` : 'Detected when MT5 is connected'} error={err('symbol')}>
                <select className="select mono" value={draft.symbol ?? ''} onChange={(e) => set('symbol', e.target.value || null)}>
                  <option value="">Automatic{s.candidates[0] ? ` (${s.candidates[0].symbol})` : ''}</option>
                  {s.candidates.map((c) => <option key={c.symbol} value={c.symbol}>{c.symbol}</option>)}
                  {draft.symbol && !s.candidates.some((c) => c.symbol === draft.symbol) && <option value={draft.symbol}>{draft.symbol}</option>}
                </select>
              </Field>
            </div>
            <div className="check-list">
              {([['useTrendFilter', `Trend filter: EMA 20 above EMA 50 on ${GOLD_TF_LABEL[draft.trendTimeframe]}`], ['useRsi', 'RSI(14) confirmation (50–70 for buys, 30–50 for sells)'], ['useMacd', 'MACD confirmation'], ['useCandleConfirmation', 'Candle confirmation: the signal candle closes in the trade’s direction'], ['useVwap', 'VWAP filter (MT5 tick volume, an approximation)']] as const).map(([k, label]) => (
                <label key={k} className="check"><input type="checkbox" checked={draft[k]} onChange={(e) => set(k, e.target.checked)} /><span>{label}</span></label>
              ))}
            </div>
            <div style={{ display: 'grid', gap: 8 }}>
              <div className="panel-title">High-risk events (no new trades)</div>
              <p className="faint" style={{ margin: 0, fontSize: 12 }}>TradePilot has no economic-news feed. Enter scheduled releases yourself (for example US jobs or CPI data), in UTC.</p>
              {draft.events.map((e, i) => (
                <div key={i} className="chip-row">
                  <span style={{ flex: 1 }}>{e.label}</span>
                  <span className="faint mono" style={{ fontSize: 12 }}>{dateTime(e.start)} → {dateTime(e.end)}</span>
                  <Button size="sm" variant="ghost" onClick={() => set('events', draft.events.filter((_, j) => j !== i))}>Remove</Button>
                </div>
              ))}
              <div className="form-row" style={{ alignItems: 'end' }}>
                <Field label="Event"><input className="input" value={ev.label} maxLength={80} placeholder="US jobs report" onChange={(e) => setEv({ ...ev, label: e.target.value })} /></Field>
                <Field label="From (UTC)"><input className="input mono" type="datetime-local" value={ev.start} onChange={(e) => setEv({ ...ev, start: e.target.value })} /></Field>
                <Field label="To (UTC)"><input className="input mono" type="datetime-local" value={ev.end} onChange={(e) => setEv({ ...ev, end: e.target.value })} /></Field>
                <div style={{ paddingBottom: 18 }}><Button size="sm" icon="plus" disabled={!ev.label.trim() || !ev.start || !ev.end} onClick={() => { set('events', [...draft.events, { label: ev.label.trim(), start: toUtc(ev.start), end: toUtc(ev.end) }]); setEv({ label: '', start: '', end: '' }) }}>Add</Button></div>
              </div>
              {err('events') && <span className="down" style={{ fontSize: 12 }}>{err('events')}</span>}
            </div>
          </>
        )}
        <div className="btn-row">
          <Button variant="primary" loading={saving} disabled={Object.keys(local).length > 0 || JSON.stringify(draft) === JSON.stringify(s.settings)} onClick={() => void save()}>Save settings</Button>
          <Button variant="ghost" onClick={() => { setDraft({ ...DEFAULT_GOLD_SETTINGS, symbol: draft.symbol, accountMode: draft.accountMode }); setText(Object.fromEntries(NUMBER_FIELDS.map((f) => [f.key, String(DEFAULT_GOLD_SETTINGS[f.key])]))) }}>Conservative defaults</Button>
          <span className="faint" style={{ fontSize: 12 }}>Max open positions, max order size and exposure: Trading → Account risk settings ({s.risk.maxOpenPositions} positions · {s.risk.maxOrderNotionalUsd.toLocaleString()} max order · {s.risk.maxExposurePct}% exposure).</span>
        </div>
      </div>
      {confirmLive && (
        <ConfirmDialog title="Switch to LIVE mode?" tone="danger" confirmLabel="Switch to live" onClose={() => setConfirmLive(false)} onConfirm={() => save(true)}>
          In live mode TradePilot only trades a real-money account (never a demo one). You still have to turn on automatic trading, with your password and the account number. Test thoroughly on a demo account first.
        </ConfirmDialog>
      )}
    </Panel>
  )
}

// ---------- backtest ----------
function BacktestPanel({ s }: { s: GoldStatus }) {
  const toast = useToast()
  const { allowed } = useAccess()
  const max = s.settings.timeframe === '1m' ? 5 : 14
  const [days, setDays] = useState(Math.min(5, max))
  const [slip, setSlip] = useState(1)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<BacktestResult | null>(null)
  const m = result?.metrics
  const mins = (sec: number | null | undefined) => (sec === null || sec === undefined ? '—' : `${Math.round(sec / 60)} min`)
  return (
    <Panel title="Backtest the scalper">
      <div className="form">
        <div className="form-row" style={{ alignItems: 'end' }}>
          <Field label="Days of history" hint={`Up to ${max} days of ${GOLD_TF_LABEL[s.settings.timeframe]} candles`}><input className="input mono" type="number" min={1} max={max} value={days} onChange={(e) => setDays(Math.max(1, Math.min(max, Number(e.target.value) || 1)))} /></Field>
          <Field label="Slippage (bps per fill)" hint="Fast moves and requotes"><input className="input mono" type="number" min={0} max={50} step={0.5} value={slip} onChange={(e) => setSlip(Math.max(0, Math.min(50, Number(e.target.value) || 0)))} /></Field>
          <div style={{ paddingBottom: 18 }}>
            <Button variant="primary" icon="play" loading={running} disabled={!allowed || !s.connected || !s.symbol} onClick={async () => {
              setRunning(true)
              try {
                setResult(await call('gold:backtest', { days, slippageBps: slip }))
              } catch (err) {
                toast({ tone: 'bad', title: 'Backtest failed', body: errorMessage(err) })
              } finally {
                setRunning(false)
              }
            }}>Run backtest</Button>
          </div>
        </div>
        <p className="faint" style={{ margin: 0, fontSize: 12 }}>Uses your broker’s {GOLD_TF_LABEL[s.settings.timeframe]} candles with their real spread, your commission per lot ({s.settings.commissionPerLot}), the slippage above and the broker’s lot rules. Signals on a candle’s close fill at the next candle’s open; stops and targets are checked against each candle’s high and low (the stop first if both are touched). Past results do not predict future results.</p>
        {m && (
          <div className="grid cols-4">
            {([
              ['Net profit', signed(m.netPnl ?? null)],
              ['Win rate', m.winRatePct === null ? '—' : `${m.winRatePct}%`],
              ['Profit factor', m.profitFactor === null ? '—' : String(m.profitFactor)],
              ['Max drawdown', `${m.maxDrawdownPct}%`],
              ['Trades', String(m.trades)],
              ['Avg trade duration', mins(m.avgTradeDurationSec)],
              ['Avg winning trade', signed(m.avgWin ?? null)],
              ['Avg losing trade', signed(m.avgLoss ?? null)]
            ] as const).map(([label, value]) => (
              <div key={label} className="panel tile"><span className="label">{label}</span><span className="value">{value}</span></div>
            ))}
          </div>
        )}
        {m && <p className="faint" style={{ margin: 0, fontSize: 12 }}>Fees {num(m.totalFees ?? 0)} · best run {m.maxConsecutiveWins ?? 0} wins · worst {m.maxConsecutiveLosses ?? 0} losses · {m.timeExits ?? 0} time exits · skipped: spread {m.signalsSkippedSpread ?? 0}, session {m.signalsSkippedSession ?? 0}, extended/spike {m.signalsSkippedMarket ?? 0}, cooldown {m.signalsSkippedCooldown ?? 0}, events {m.signalsSkippedEvent ?? 0}, below minimum lot {m.signalsSkippedBelowMinVolume ?? 0}.</p>}
      </div>
    </Panel>
  )
}

// ---------- activity ----------
function Activity({ s }: { s: GoldStatus }) {
  const now = useNow(15_000)
  const items = [
    ...s.events.map((e) => ({ at: e.createdAt, level: e.level, text: e.message })),
    ...s.manualOrders.map((o) => ({ at: o.createdAt, level: o.state === 'rejected' ? ('warning' as const) : ('info' as const), text: `Manual ${o.side.toUpperCase()} ${o.volume} lots on ${o.accountMode} account ${o.accountLogin}: ${o.state}${o.avgPrice ? ` at ${num(o.avgPrice)}` : ''}${o.error ? ` — ${o.error}` : ''}${o.note ? ` (${o.note})` : ''}` }))
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 40)
  return (
    <Panel title="Activity" flush>
      {items.length === 0 ? <Empty icon="clock" title="No activity yet" /> : (
        <div style={{ maxHeight: 300, overflow: 'auto' }}>
          {items.map((e, i) => (
            <div key={i} className="event-row">
              <span className="faint mono" style={{ fontSize: 11.5 }} title={dateTime(e.at)}>{ago(e.at, now)}</span>
              <Icon name={e.level === 'info' ? 'info' : 'alert'} size={13} style={{ color: e.level === 'error' ? 'var(--down)' : e.level === 'warning' ? 'var(--warn)' : 'var(--text-3)', marginTop: 2 }} />
              <span>{e.text}</span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  )
}

export function Gold() {
  const status = useResource(() => call('gold:status'), [], { pollMs: 2000 })
  const [s, setS] = useState<GoldStatus | null>(null)
  useEffect(() => {
    if (status.data) setS(status.data)
  }, [status.data])
  if (!s) return <div className="page">{status.error ? <ErrorState message={status.error} onRetry={status.reload} /> : <Skeleton height={300} />}</div>
  return (
    <div className="page">
      <PaywallBanner feature="Gold scalping" />
      {!s.platformSupported && <Banner tone="warn" title="MetaTrader 5 needs Windows">The XAUUSD scalper trades through the MetaTrader 5 terminal, which only runs on Windows. Prices, the account and trading are unavailable on this computer.</Banner>}
      {s.emergency && <Banner tone="bad" icon="stop" title="Emergency stop is active">No new orders are sent. Clear it in the controls when you are ready.</Banner>}
      {s.accountModeProblem && <Banner tone="bad" title="Account and mode do not match">{s.accountModeProblem}</Banner>}
      {s.connected && s.liveEnabled && s.account?.mode === 'real' && <Banner tone="bad" title="LIVE: real-money account">Orders use real money. Scalping in fast markets can lose quickly; your risk limits apply to every order.</Banner>}
      {s.connected && !s.symbol && <Banner tone="warn" title="No gold symbol found">Your broker lists no recognisable spot gold symbol in US dollars. Choose it in the scalping settings.</Banner>}
      {s.bot.strategyProblem && s.symbol && <Banner tone="warn" title="The scalper cannot start yet">{s.bot.strategyProblem}</Banner>}
      {s.connectionError && s.platformSupported && !s.userDisconnected && <Banner tone="bad" title="MetaTrader 5">{s.connectionError}</Banner>}
      <StatusBar s={s} onStatus={setS} />
      <MarketTiles s={s} />
      <Controls s={s} onStatus={setS} />
      <Stats s={s} />
      <ChartPanel s={s} />
      <Positions s={s} onStatus={setS} />
      <SettingsPanel s={s} onStatus={setS} />
      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <BacktestPanel s={s} />
        <Activity s={s} />
      </div>
      <p className="faint" style={{ margin: 0, fontSize: 11.5 }}>Signals come from the scalper’s rules on closed candles of real MT5 data; they are not predictions, and no strategy guarantees profits. Orders are only reported as executed when MetaTrader 5 confirms them.</p>
    </div>
  )
}
