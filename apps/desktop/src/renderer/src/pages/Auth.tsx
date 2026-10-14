import { useEffect, useState, type FormEvent } from 'react'
import { BrandMark } from '../components/icons'
import { Banner, Button, ConfirmDialog, Field, PasswordInput, Skeleton } from '../components/ui'
import { CandleChart } from '../components/charts'
import { QuoteLine } from '../components/market'
import { useLiveSeries, useMarketWatch } from '../lib/market'
import { call, errorMessage, fieldErrors } from '../lib/api'
import { duration } from '../lib/format'
import { useNow } from '../lib/hooks'
import { useApp } from '../lib/state'

/** Live market view on the sign-in screen: real Delta Exchange candles and price, never sample data. */
function LoginMarket() {
  const [symbol, setSymbol] = useState('BTCUSD')
  const snap = useMarketWatch('login', [symbol], { symbol, timeframe: '15m' })
  useEffect(() => {
    // instruments differ by region (Global lists BTCUSDT)
    if (snap?.health.unsupported.includes(symbol) && symbol === 'BTCUSD') setSymbol('BTCUSDT')
  }, [snap?.health.unsupported, symbol])
  const live = useLiveSeries(symbol, '15m', 2, snap?.health.connectionEpoch)
  const quote = snap?.quotes[symbol]
  return (
    <div className="auth-market">
      <div className="auth-market-head">
        <span className="mono" style={{ fontWeight: 600 }}>{symbol}</span>
        <QuoteLine q={quote} health={snap?.health} />
        <span className="faint" style={{ marginLeft: 'auto', fontSize: 11.5 }}>15m · {snap?.health.regionLabel ?? 'Delta Exchange'}</span>
      </div>
      {live.error ? (
        <div className="faint" style={{ height: 300, display: 'grid', placeItems: 'center', textAlign: 'center' }}>Live market data is unavailable right now.<br />{live.error}</div>
      ) : live.series ? (
        <CandleChart candles={live.series.candles} height={300} />
      ) : (
        <Skeleton height={300} />
      )}
    </div>
  )
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth">
      <aside className="auth-art">
        <div className="brand" style={{ position: 'relative', padding: 0 }}>
          <BrandMark size={30} />
          <div className="brand-name">TradePilot</div>
        </div>
        <LoginMarket />
        <div className="tagline">
          <h2>Build, test and automate rule-based strategies.</h2>
          <p>Live prices from Delta Exchange. Automated orders only run after you enable live trading and set your risk limits.</p>
        </div>
      </aside>
      <main className="auth-form">{children}</main>
    </div>
  )
}

function ResetLocalData({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  return (
    <ConfirmDialog
      title="Reset TradePilot on this computer?"
      confirmLabel="Erase local data and restart"
      tone="danger"
      confirmDisabled={text !== 'RESET'}
      onClose={onClose}
      onConfirm={async () => {
        try {
          await call('auth:resetApplication', { confirmation: text })
        } catch (err) {
          setError(errorMessage(err))
          throw err
        }
      }}
    >
      <p style={{ margin: 0 }}>
        This deletes your local password, saved strategies, paper trades, notifications and stored API credentials. It cannot be undone.
      </p>
      <p style={{ margin: 0 }}>Your trial and subscription are stored on the server and are restored automatically.</p>
      <Field label="Type RESET to confirm" error={error ?? undefined}>
        <input className="input mono" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" />
      </Field>
    </ConfirmDialog>
  )
}

export function AuthScreen() {
  const { auth, setAuth } = useApp()
  const setup = auth?.state === 'setup_required'
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fields, setFields] = useState<Record<string, string>>({})
  const [lockedUntil, setLockedUntil] = useState<string | null>(auth?.lockedUntil ?? null)
  const [reset, setReset] = useState(false)
  const now = useNow(500)
  const remainingLock = lockedUntil ? Date.parse(lockedUntil) - now : 0

  useEffect(() => {
    if (lockedUntil && remainingLock <= 0) setLockedUntil(null)
  }, [lockedUntil, remainingLock])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || remainingLock > 0) return
    setBusy(true)
    setError(null)
    setFields({})
    try {
      if (setup) {
        setAuth(await call('auth:setup', { password, confirm }))
      } else {
        const r = await call('auth:unlock', { password })
        if (r.unlocked) {
          setAuth(await call('auth:status'))
        } else {
          setPassword('')
          if (r.lockedUntil) {
            setLockedUntil(r.lockedUntil)
            setError('Too many incorrect attempts.')
          } else setError(`Incorrect password. ${r.attemptsRemaining} attempt${r.attemptsRemaining === 1 ? '' : 's'} before a temporary lock.`)
        }
      }
    } catch (err) {
      setError(errorMessage(err))
      setFields(fieldErrors(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Frame>
      <form className="auth-card" onSubmit={submit}>
        <div>
          <h1>{setup ? 'Create your password' : 'Welcome back'}</h1>
          <p className="lead">{setup ? 'This password protects TradePilot on this computer.' : 'Enter your password to unlock TradePilot.'}</p>
        </div>
        {error && !fields.password && !fields.confirm && <Banner tone="bad">{error}</Banner>}
        {remainingLock > 0 && <div className="lockout">Locked — try again in {duration(remainingLock)}</div>}
        <Field label="Password" error={fields.password} hint={setup ? auth?.passwordPolicy : undefined}>
          <PasswordInput
            invalid={Boolean(fields.password)}
            autoFocus
            autoComplete={setup ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={remainingLock > 0}
          />
        </Field>
        {setup && (
          <Field label="Confirm password" error={fields.confirm}>
            <PasswordInput invalid={Boolean(fields.confirm)} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
        )}
        <Button type="submit" variant="primary" size="lg" block loading={busy} disabled={!password || remainingLock > 0}>
          {setup ? 'Create password and continue' : 'Unlock'}
        </Button>
        {!setup && (
          <button type="button" className="btn ghost sm" style={{ justifySelf: 'center' }} onClick={() => setReset(true)}>
            Forgot your password?
          </button>
        )}
        <p className="faint" style={{ margin: 0, fontSize: 12 }}>
          Signing in here only unlocks this app. Your trial and subscription are verified separately by the TradePilot server.
        </p>
      </form>
      {reset && <ResetLocalData onClose={() => setReset(false)} />}
    </Frame>
  )
}

export function ChangePasswordForm({ onDone, submitLabel = 'Change password' }: { onDone?: () => void; submitLabel?: string }) {
  const { setAuth, auth } = useApp()
  const [form, setForm] = useState({ current: '', next: '', confirm: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fields, setFields] = useState<Record<string, string>>({})
  const [done, setDone] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setFields({})
    setDone(false)
    try {
      const status = await call('auth:changePassword', form)
      setForm({ current: '', next: '', confirm: '' })
      setDone(true)
      setAuth(status)
      onDone?.()
    } catch (err) {
      setError(errorMessage(err))
      setFields(fieldErrors(err))
    } finally {
      setBusy(false)
    }
  }
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value })
  return (
    <form className="form" onSubmit={submit} style={{ maxWidth: 420 }}>
      {error && <Banner tone="bad">{error}</Banner>}
      {done && <Banner tone="ok">Password changed.</Banner>}
      <Field label="Current password" error={fields.current}>
        <PasswordInput autoComplete="current-password" value={form.current} onChange={set('current')} />
      </Field>
      <Field label="New password" error={fields.next} hint={auth?.passwordPolicy}>
        <PasswordInput autoComplete="new-password" value={form.next} onChange={set('next')} />
      </Field>
      <Field label="Confirm new password" error={fields.confirm}>
        <PasswordInput autoComplete="new-password" value={form.confirm} onChange={set('confirm')} />
      </Field>
      <div>
        <Button type="submit" variant="primary" loading={busy} disabled={!form.current || !form.next || !form.confirm}>{submitLabel}</Button>
      </div>
    </form>
  )
}

export function ForcedPasswordChange() {
  return (
    <Frame>
      <div className="auth-card">
        <div>
          <h1>Choose a new password</h1>
          <p className="lead">You signed in with the configured initial password. Replace it with your own before continuing.</p>
        </div>
        <ChangePasswordForm submitLabel="Save and continue" />
      </div>
    </Frame>
  )
}
