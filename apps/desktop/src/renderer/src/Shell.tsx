import { useEffect, useState } from 'react'
import { TRIAL_DURATION_MS } from '@tradepilot/shared'
import { BrandMark, Icon, type IconName } from './components/icons'
import { ConfirmDialog, StatusDot } from './components/ui'
import { call } from './lib/api'
import { ago, date, duration } from './lib/format'
import { useNow } from './lib/hooks'
import { serverNow, useApp, type Page } from './lib/state'
import { Analytics } from './pages/Analytics'
import { Dashboard } from './pages/Dashboard'
import { Notifications } from './pages/Notifications'
import { Settings } from './pages/Settings'
import { Strategies } from './pages/Strategies'
import { Subscription } from './pages/Subscription'
import { Trading } from './pages/Trading'

const NAV: { page: Page; label: string; icon: IconName }[] = [
  { page: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
  { page: 'strategies', label: 'Strategies', icon: 'strategies' },
  { page: 'trading', label: 'Trading', icon: 'trading' },
  { page: 'analytics', label: 'Analytics', icon: 'analytics' },
  { page: 'notifications', label: 'Notifications', icon: 'bell' },
  { page: 'subscription', label: 'Subscription', icon: 'card' },
  { page: 'settings', label: 'Settings', icon: 'settings' }
]
const CRUMBS: Record<Page, string> = {
  dashboard: 'Overview of markets, account and engine',
  strategies: 'Define and manage rule-based strategies',
  trading: 'Paper trading · live trading disabled',
  analytics: 'Backtest strategies on historical data',
  notifications: 'Alerts and account messages',
  subscription: 'Plans, payments and access',
  settings: 'Preferences, security and integrations'
}

function AccessCard() {
  const { subscription, navigate } = useApp()
  const now = useNow(1000)
  const s = subscription?.status
  let label = 'Access'
  let value = 'Checking…'
  let meter: number | null = null
  if (subscription && !subscription.configured) value = 'Server not configured'
  else if (s?.subscription?.status === 'active') {
    label = `${s.subscription.planCode === 'lifetime' ? 'Lifetime' : 'Monthly'} plan`
    value = s.subscription.expiresAt ? `Until ${date(s.subscription.expiresAt)}` : 'Active'
  } else if (s?.trial.active) {
    const left = Date.parse(s.trial.endsAt) - serverNow(subscription, now)
    label = 'Free trial'
    value = left > 0 ? `${duration(left, false)} left` : 'Ending…'
    meter = Math.max(0, Math.min(100, (left / TRIAL_DURATION_MS) * 100))
  } else if (s) {
    label = s.access.reason === 'subscription_expired' ? 'Subscription expired' : 'Trial ended'
    value = 'Choose a plan'
  } else if (subscription?.syncError) value = 'Offline'
  return (
    <button className="access-card" onClick={() => navigate('subscription')}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {meter !== null && <div className="meter"><i style={{ width: `${meter}%` }} /></div>}
    </button>
  )
}

function Clock() {
  const now = useNow(1000)
  return <span className="mono">{new Date(now).toISOString().slice(11, 19)} UTC</span>
}

export function Shell() {
  const { page, navigate, unread, subscription, engine, updates, setAuth } = useApp()
  const [confirmLogout, setConfirmLogout] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      const n = Number(e.key)
      if (n >= 1 && n <= NAV.length) {
        e.preventDefault()
        navigate(NAV[n - 1]!.page)
      }
      if (e.key.toLowerCase() === 'l' && e.shiftKey) {
        e.preventDefault()
        void call('auth:lock').then(setAuth)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate, setAuth])

  const sync = subscription
  const syncTone = !sync?.configured ? 'warn' : sync.syncError ? 'bad' : sync.lastSyncedAt ? 'ok' : undefined
  const syncLabel = !sync?.configured ? 'Server not configured' : sync.syncError ? 'Server offline' : sync.lastSyncedAt ? `Synced ${ago(sync.lastSyncedAt)}` : 'Connecting…'
  const engineTone = engine?.state === 'ready' ? 'ok' : engine?.state === 'error' ? 'bad' : engine?.state === 'starting' ? 'warn' : undefined
  const updateReady = updates?.phase === 'downloaded'
  const downloading = updates?.phase === 'downloading'

  return (
    <div className="shell">
      <nav className="rail" aria-label="Main">
        <div className="brand">
          <BrandMark />
          <div className="brand-name">TradePilot</div>
        </div>
        {NAV.map((n, i) => (
          <button key={n.page} className={`nav-item ${page === n.page ? 'active' : ''}`} onClick={() => navigate(n.page)} aria-current={page === n.page ? 'page' : undefined}>
            <Icon name={n.icon} />
            <span>{n.label}</span>
            {n.page === 'notifications' && unread > 0 ? <span className="count">{unread > 99 ? '99+' : unread}</span> : <span className="kbd">⌃{i + 1}</span>}
          </button>
        ))}
        <div className="rail-foot">
          <AccessCard />
          <div className="btn-row" style={{ justifyContent: 'space-between' }}>
            <button className="btn ghost sm" onClick={() => void call('auth:lock').then(setAuth)} title="Lock (Ctrl+Shift+L)">
              <Icon name="lock" size={14} /> Lock
            </button>
            <button className="btn ghost sm" onClick={() => setConfirmLogout(true)}>
              <Icon name="logout" size={14} /> Log out
            </button>
          </div>
        </div>
      </nav>
      <div className="main">
        <header className="topbar">
          <h1>{NAV.find((n) => n.page === page)?.label}</h1>
          <span className="crumb">{CRUMBS[page]}</span>
          <div className="spacer" />
          <span className="status-item" title={sync?.syncError ?? sync?.configurationError ?? ''}><StatusDot tone={syncTone} />{syncLabel}</span>
          <span className="status-item" title={engine?.message ?? ''}><StatusDot tone={engineTone} />Engine {engine?.state ?? '…'}</span>
          {(updateReady || downloading) && (
            <button className="status-item btn ghost sm" onClick={() => navigate('settings', { tab: 'updates' })}>
              <Icon name="download" size={14} />
              {updateReady ? `Update ${updates?.availableVersion} ready` : `Downloading ${Math.round(updates?.progress?.percent ?? 0)}%`}
            </button>
          )}
          <span className="status-item"><Icon name="clock" size={14} /><Clock /></span>
          <button className="icon-btn" aria-label={`Notifications (${unread} unread)`} onClick={() => navigate('notifications')}>
            <Icon name="bell" />
            {unread > 0 && <span className="pip" />}
          </button>
        </header>
        <main className="content">
          {page === 'dashboard' && <Dashboard />}
          {page === 'strategies' && <Strategies />}
          {page === 'trading' && <Trading />}
          {page === 'analytics' && <Analytics />}
          {page === 'notifications' && <Notifications />}
          {page === 'subscription' && <Subscription />}
          {page === 'settings' && <Settings />}
        </main>
      </div>
      {confirmLogout && (
        <ConfirmDialog
          title="Log out of TradePilot?"
          confirmLabel="Log out"
          onClose={() => setConfirmLogout(false)}
          onConfirm={async () => {
            setAuth(await call('auth:logout'))
          }}
        >
          You will need your password to sign back in. Your data stays on this computer.
        </ConfirmDialog>
      )}
    </div>
  )
}
