import { useEffect, useState } from 'react'
import { BrandMark, Icon, type IconName } from './components/icons'
import { ConfirmDialog, StatusDot } from './components/ui'
import { call } from './lib/api'
import { useEvent, useNow } from './lib/hooks'
import { TransportStatus } from './components/market'
import type { MarketHealth } from '@shared/ipc'
import { useApp, type Page } from './lib/state'
import { Analytics } from './pages/Analytics'
import { Dashboard } from './pages/Dashboard'
import { Gold } from './pages/Gold'
import { Notifications } from './pages/Notifications'
import { Settings } from './pages/Settings'
import { Strategies } from './pages/Strategies'
import { Trading } from './pages/Trading'

const NAV: { page: Page; label: string; icon: IconName }[] = [
  { page: 'gold', label: 'Gold Scalper', icon: 'bolt' },
  { page: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
  { page: 'strategies', label: 'Strategies', icon: 'strategies' },
  { page: 'trading', label: 'Trading', icon: 'trading' },
  { page: 'analytics', label: 'Analytics', icon: 'analytics' },
  { page: 'settings', label: 'Settings', icon: 'settings' }
]
const CRUMBS: Record<Page, string> = {
  gold: 'XAUUSD scalping on MetaTrader 5: price, signal, account and controls',
  dashboard: 'Overview of markets, account and engine',
  strategies: 'Define and manage rule-based strategies',
  trading: 'Account, automation and orders',
  analytics: 'Backtest strategies on historical data',
  notifications: 'Trading alerts and account messages (also sent by email / WhatsApp when enabled)',
  settings: 'Preferences, security and integrations'
}

function Clock() {
  const now = useNow(1000)
  return <span className="mono">{new Date(now).toISOString().slice(11, 19)} UTC</span>
}

export function Shell() {
  const { page, navigate, unread, engine, updates, setAuth } = useApp()
  const [confirmLogout, setConfirmLogout] = useState(false)
  const [marketHealth, setMarketHealth] = useState<MarketHealth | undefined>()
  useEffect(() => {
    void call('market:snapshot').then((s) => setMarketHealth(s.health)).catch(() => undefined)
  }, [])
  useEvent('market:changed', (s) => setMarketHealth(s.health))

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
            <span className="kbd">⌃{i + 1}</span>
          </button>
        ))}
        <div className="rail-foot">
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
          <h1>{NAV.find((n) => n.page === page)?.label ?? (page === 'notifications' ? 'Notifications' : '')}</h1>
          <span className="crumb">{CRUMBS[page]}</span>
          <div className="spacer" />
          <button className="btn ghost sm" style={{ padding: 0, height: 'auto', border: 0 }} onClick={() => navigate('settings', { tab: 'marketdata' })}><TransportStatus health={marketHealth} /></button>
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
          {page === 'gold' && <Gold />}
          {page === 'dashboard' && <Dashboard />}
          {page === 'strategies' && <Strategies />}
          {page === 'trading' && <Trading />}
          {page === 'analytics' && <Analytics />}
          {page === 'notifications' && <Notifications />}
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
