/**
 * Typed contract between the renderer and the main process. The renderer can only
 * call these channels (the preload whitelists them) and never sees secrets: credential
 * values go in, but only masked hints come back out.
 */
import type { PaymentRequestDto, PlanDto, StatusResponse } from '@tradepilot/shared'

export type Result<T> = { ok: true; data: T } | { ok: false; error: IpcError }
export interface IpcError {
  code: string
  message: string
  fields?: Record<string, string>
}

// ---------- auth ----------
export type AuthState = 'setup_required' | 'locked' | 'unlocked'
export interface AuthStatus {
  state: AuthState
  mustChangePassword: boolean
  lockedUntil: string | null
  passwordPolicy: string
}
export interface UnlockResult {
  unlocked: boolean
  attemptsRemaining?: number
  lockedUntil?: string | null
}

// ---------- subscription ----------
export interface SubscriptionView {
  configured: boolean
  configurationError: string | null
  online: boolean
  lastSyncedAt: string | null
  syncError: string | null
  /** Server status minus the raw entitlement token. */
  status: Omit<StatusResponse, 'entitlementToken'> | null
  /** serverTime - localTime at the last sync, so countdowns ignore local clock changes. */
  serverOffsetMs: number
  access: { allowed: boolean; reason: string; source: 'server' | 'offline_token' | 'none'; detail: string }
}
export interface PlansView {
  plans: PlanDto[]
  paymentInstructions: string | null
  referenceCode: string
}
export interface ScreenshotSelection {
  id: string
  name: string
  sizeBytes: number
  mime: string
  previewDataUrl: string
}
export interface SubmitPaymentInput {
  planCode: string
  transactionId: string
  contactEmail?: string
  note?: string
  screenshotId: string
}

// ---------- settings & integrations ----------
export type IntegrationId = 'delta' | 'openai' | 'anthropic' | 'smtp' | 'whatsapp'
export type ConnectionState = 'not_configured' | 'untested' | 'connected' | 'failed'
export interface IntegrationView {
  id: IntegrationId
  state: ConnectionState
  message: string | null
  checkedAt: string | null
  /** Non-secret configuration values. */
  config: Record<string, string>
  /** Masked hints (e.g. "••••3f9a") for stored secrets; null when not set. */
  secrets: Record<string, string | null>
}
export interface IntegrationSaveInput {
  id: IntegrationId
  config: Record<string, string>
  /** Only secrets the user re-entered; omitted keys keep the stored value, "" clears. */
  secrets: Record<string, string>
}
export interface GeneralPreferences {
  theme: 'dark' | 'light' | 'system'
  autoLockMinutes: number
  desktopNotifications: boolean
  autoInstallUpdates: boolean
  pythonPath: string
  defaultSymbol: string
}
export interface SecretStorageInfo {
  available: boolean
  backend: string
  message: string | null
}

// ---------- strategies, engine, market, paper ----------
export type StrategyType = 'sma_cross' | 'ema_cross' | 'rsi_reversion' | 'breakout'
export type Timeframe = '5m' | '15m' | '1h' | '4h' | '1d'
export interface StrategyRisk {
  positionPct: number
  stopLossPct: number
  takeProfitPct: number
  feeBps: number
}
export interface Strategy {
  id: string
  name: string
  symbol: string
  timeframe: Timeframe
  type: StrategyType
  params: Record<string, number>
  risk: StrategyRisk
  allowShort: boolean
  status: 'draft' | 'paper' | 'archived'
  notes: string
  createdAt: string
  updatedAt: string
  lastBacktest: BacktestSummary | null
}
export type StrategyInput = Omit<Strategy, 'id' | 'createdAt' | 'updatedAt' | 'lastBacktest' | 'status'> & { status?: 'draft' | 'paper' }

export interface BacktestMetrics {
  initialEquity: number
  finalEquity: number
  totalReturnPct: number
  buyHoldReturnPct: number
  maxDrawdownPct: number
  trades: number
  winRatePct: number | null
  profitFactor: number | null
  avgTradePct: number | null
  sharpe: number | null
  exposurePct: number
  bars: number
}
export interface BacktestTrade {
  side: 'long' | 'short'
  entryTime: number
  entryPrice: number
  exitTime: number
  exitPrice: number
  quantity: number
  pnl: number
  returnPct: number
  exitReason: string
}
export interface BacktestResult {
  runId: string
  strategyId: string
  symbol: string
  timeframe: Timeframe
  candles: Candle[]
  metrics: BacktestMetrics
  trades: BacktestTrade[]
  equityCurve: [number, number][]
}
export interface BacktestSummary {
  runId: string
  createdAt: string
  metrics: BacktestMetrics
  rangeStart: number
  rangeEnd: number
}
export interface EngineStatus {
  state: 'stopped' | 'starting' | 'ready' | 'error'
  message: string | null
  engineVersion: string | null
  python: string | null
  liveTradingEnabled: false
}

export interface Candle {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}
export interface Ticker {
  symbol: string
  description: string
  markPrice: number
  lastPrice: number
  change24hPct: number | null
  high24h: number | null
  low24h: number | null
  volume24hUsd: number | null
  fundingRate: number | null
  updatedAt: string
}
export interface PaperOrder {
  id: string
  symbol: string
  side: 'buy' | 'sell'
  quantity: number
  fillPrice: number
  createdAt: string
}
export interface PaperPosition {
  symbol: string
  quantity: number
  avgPrice: number
  markPrice: number | null
  unrealizedPnl: number | null
  realizedPnl: number
}

// ---------- notifications ----------
export interface AppNotification {
  id: string
  category: 'subscription' | 'system' | 'update' | 'trading' | 'security'
  severity: 'info' | 'success' | 'warning' | 'error'
  title: string
  body: string
  readAt: string | null
  createdAt: string
}

// ---------- updates ----------
export type UpdatePhase = 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'up_to_date' | 'error' | 'installing'
export interface UpdateState {
  phase: UpdatePhase
  currentVersion: string
  availableVersion: string | null
  progress: { percent: number; transferred: number; total: number; bytesPerSecond: number } | null
  message: string | null
  lastCheckedAt: string | null
  nextRetryAt: string | null
  feedUrl: string | null
}

export interface AppInfo {
  version: string
  platform: string
  packaged: boolean
  dataPath: string
  apiBaseUrl: string | null
  deviceId: string | null
}

/** channel → [request, response] */
export interface IpcContract {
  'app:info': [void, AppInfo]
  'auth:status': [void, AuthStatus]
  'auth:setup': [{ password: string; confirm: string }, AuthStatus]
  'auth:unlock': [{ password: string }, UnlockResult]
  'auth:lock': [void, AuthStatus]
  'auth:logout': [void, AuthStatus]
  'auth:changePassword': [{ current: string; next: string; confirm: string }, AuthStatus]
  'auth:resetApplication': [{ confirmation: string }, AuthStatus]
  'auth:activity': [void, void]

  'subscription:view': [void, SubscriptionView]
  'subscription:refresh': [void, SubscriptionView]
  'subscription:plans': [void, PlansView]
  'subscription:requests': [void, PaymentRequestDto[]]
  'subscription:pickScreenshot': [void, ScreenshotSelection | null]
  'subscription:submit': [SubmitPaymentInput, PaymentRequestDto]

  'settings:getPreferences': [void, GeneralPreferences]
  'settings:savePreferences': [Partial<GeneralPreferences>, GeneralPreferences]
  'settings:secretStorage': [void, SecretStorageInfo]
  'integrations:list': [void, IntegrationView[]]
  'integrations:save': [IntegrationSaveInput, IntegrationView]
  'integrations:test': [{ id: IntegrationId }, IntegrationView]
  'integrations:clear': [{ id: IntegrationId }, IntegrationView]

  'strategies:list': [{ includeArchived?: boolean }, Strategy[]]
  'strategies:save': [{ id?: string; input: StrategyInput }, Strategy]
  'strategies:archive': [{ id: string }, Strategy]
  'strategies:restore': [{ id: string }, Strategy]
  'strategies:delete': [{ id: string }, { id: string }]
  'strategies:duplicate': [{ id: string }, Strategy]
  'strategies:backtest': [{ id: string; days: number }, BacktestResult]

  'engine:status': [void, EngineStatus]
  'engine:restart': [void, EngineStatus]

  'market:tickers': [{ symbols?: string[] }, Ticker[]]
  'market:symbols': [void, string[]]
  'market:candles': [{ symbol: string; timeframe: Timeframe; days: number }, Candle[]]

  'paper:placeOrder': [{ symbol: string; side: 'buy' | 'sell'; quantity: number }, PaperOrder]
  'paper:orders': [void, PaperOrder[]]
  'paper:positions': [void, PaperPosition[]]
  'paper:closePosition': [{ symbol: string }, PaperOrder]
  'paper:reset': [void, void]

  'notifications:list': [void, AppNotification[]]
  'notifications:markRead': [{ ids: string[] | 'all' }, AppNotification[]]
  'notifications:clear': [void, AppNotification[]]

  'updates:state': [void, UpdateState]
  'updates:check': [void, UpdateState]
  'updates:install': [void, UpdateState]

  'shell:openDataFolder': [void, void]
}

export type Channel = keyof IpcContract
export type Req<C extends Channel> = IpcContract[C][0]
export type Res<C extends Channel> = IpcContract[C][1]

/** Push events from main to renderer. */
export interface EventContract {
  'auth:changed': AuthStatus
  'subscription:changed': SubscriptionView
  'updates:changed': UpdateState
  'notifications:changed': { unread: number }
  'engine:changed': EngineStatus
}
export type EventName = keyof EventContract

export const CHANNELS: Channel[] = [
  'app:info', 'auth:status', 'auth:setup', 'auth:unlock', 'auth:lock', 'auth:logout', 'auth:changePassword', 'auth:resetApplication', 'auth:activity',
  'subscription:view', 'subscription:refresh', 'subscription:plans', 'subscription:requests', 'subscription:pickScreenshot', 'subscription:submit',
  'settings:getPreferences', 'settings:savePreferences', 'settings:secretStorage',
  'integrations:list', 'integrations:save', 'integrations:test', 'integrations:clear',
  'strategies:list', 'strategies:save', 'strategies:archive', 'strategies:restore', 'strategies:delete', 'strategies:duplicate', 'strategies:backtest',
  'engine:status', 'engine:restart',
  'market:tickers', 'market:symbols', 'market:candles',
  'paper:placeOrder', 'paper:orders', 'paper:positions', 'paper:closePosition', 'paper:reset',
  'notifications:list', 'notifications:markRead', 'notifications:clear',
  'updates:state', 'updates:check', 'updates:install',
  'shell:openDataFolder'
]
export const EVENTS: EventName[] = ['auth:changed', 'subscription:changed', 'updates:changed', 'notifications:changed', 'engine:changed']

export interface TradePilotBridge {
  invoke<C extends Channel>(channel: C, ...args: Req<C> extends void ? [] : [Req<C>]): Promise<Result<Res<C>>>
  on<E extends EventName>(event: E, listener: (payload: EventContract[E]) => void): () => void
}
