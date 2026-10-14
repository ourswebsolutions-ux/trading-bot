import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { AppInfo, AuthStatus, EngineStatus, GeneralPreferences, SubscriptionView, UpdateState } from '@shared/ipc'
import { call } from './api'
import { useEvent } from './hooks'

export type Page = 'dashboard' | 'strategies' | 'trading' | 'analytics' | 'notifications' | 'subscription' | 'settings'

interface AppState {
  auth: AuthStatus | null
  setAuth: (s: AuthStatus) => void
  info: AppInfo | null
  subscription: SubscriptionView | null
  setSubscription: (v: SubscriptionView) => void
  refreshSubscription: () => Promise<SubscriptionView | undefined>
  updates: UpdateState | null
  setUpdates: (s: UpdateState) => void
  engine: EngineStatus | null
  unread: number
  setUnread: (n: number) => void
  prefs: GeneralPreferences | null
  setPrefs: (p: GeneralPreferences) => void
  page: Page
  navigate: (p: Page, params?: Record<string, string>) => void
  params: Record<string, string>
}

const Ctx = createContext<AppState | null>(null)
export const useApp = () => {
  const v = useContext(Ctx)
  if (!v) throw new Error('useApp outside provider')
  return v
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<AuthStatus | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [subscription, setSubscription] = useState<SubscriptionView | null>(null)
  const [updates, setUpdates] = useState<UpdateState | null>(null)
  const [engine, setEngine] = useState<EngineStatus | null>(null)
  const [unread, setUnread] = useState(0)
  const [prefs, setPrefs] = useState<GeneralPreferences | null>(null)
  const [page, setPage] = useState<Page>('dashboard')
  const [params, setParams] = useState<Record<string, string>>({})

  useEffect(() => {
    void call('auth:status').then(setAuth)
    void call('app:info').then(setInfo)
    void call('updates:state').then(setUpdates)
  }, [])

  const unlocked = auth?.state === 'unlocked'
  useEffect(() => {
    if (!unlocked) return
    void call('subscription:view').then(setSubscription).catch(() => undefined)
    void call('settings:getPreferences').then(setPrefs).catch(() => undefined)
    void call('engine:status').then(setEngine).catch(() => undefined)
    void call('notifications:list').then((l) => setUnread(l.filter((n) => !n.readAt).length)).catch(() => undefined)
    void call('app:info').then(setInfo)
  }, [unlocked])

  useEvent('auth:changed', setAuth)
  useEvent('subscription:changed', setSubscription)
  useEvent('updates:changed', setUpdates)
  useEvent('engine:changed', setEngine)
  useEvent('notifications:changed', (p) => setUnread(p.unread))

  // theme
  useEffect(() => {
    const apply = () => {
      const pref = prefs?.theme ?? 'dark'
      const theme = pref === 'system' ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : pref
      document.documentElement.dataset.theme = theme
    }
    apply()
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [prefs?.theme])

  // report activity (throttled) so the main process can auto-lock on idle
  useEffect(() => {
    if (!unlocked) return
    let last = 0
    const ping = () => {
      const now = Date.now()
      if (now - last > 20_000) {
        last = now
        void call('auth:activity').catch(() => undefined)
      }
    }
    const events = ['mousemove', 'keydown', 'mousedown', 'wheel'] as const
    events.forEach((e) => window.addEventListener(e, ping, { passive: true }))
    return () => events.forEach((e) => window.removeEventListener(e, ping))
  }, [unlocked])

  const refreshSubscription = useCallback(async () => {
    const v = await call('subscription:refresh')
    setSubscription(v)
    return v
  }, [])

  const navigate = useCallback((p: Page, prm: Record<string, string> = {}) => {
    setPage(p)
    setParams(prm)
  }, [])

  const value = useMemo<AppState>(
    () => ({ auth, setAuth, info, subscription, setSubscription, refreshSubscription, updates, setUpdates, engine, unread, setUnread, prefs, setPrefs, page, navigate, params }),
    [auth, info, subscription, refreshSubscription, updates, engine, unread, prefs, page, navigate, params]
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

/** Remaining trial/subscription time computed on the server clock (offset-adjusted), not the local clock. */
export function serverNow(view: SubscriptionView | null, localNow = Date.now()): number {
  return localNow + (view?.serverOffsetMs ?? 0)
}
