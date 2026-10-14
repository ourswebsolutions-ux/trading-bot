/**
 * Typed contract between the renderer and the main process. The renderer can only
 * call these channels (the preload whitelists them) and never sees secrets: credential
 * values go in, but only masked hints come back out.
 */
import type { PaymentRequestDto, PlanDto, StatusResponse } from '@tradepilot/shared'
import type { DefinitionChange, StrategyDefinition, StrategyExplanation, ValidationResult } from './strategyRules'

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
export type IntegrationId = 'delta' | 'openai' | 'anthropic' | 'smtp' | 'whatsapp' | 'marketdata'
export type ConnectionState = 'not_configured' | 'untested' | 'connected' | 'failed'
export interface IntegrationActionResult {
  action: string
  ok: boolean
  message: string
  at: string
}
export interface IntegrationView {
  id: IntegrationId
  state: ConnectionState
  message: string | null
  checkedAt: string | null
  /** last time a test or action against the provider succeeded */
  lastSuccessAt: string | null
  lastAction: IntegrationActionResult | null
  /** Non-secret configuration values. */
  config: Record<string, string>
  /** Masked hints (e.g. "••••3f9a") for stored secrets; null when not set. */
  secrets: Record<string, string | null>
  /** Section-specific data: model lists, opt-in recipients, usage, templates… */
  extras: Record<string, unknown>
}
export interface IntegrationSaveInput {
  id: IntegrationId
  config: Record<string, string>
  /** Only secrets the user re-entered; omitted keys keep the stored value, "" clears. */
  secrets: Record<string, string>
}
export interface IntegrationProgress {
  id: IntegrationId
  step: string
}
export interface GeneralPreferences {
  welcomeSound: boolean
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

export interface Strategy {
  id: string
  name: string
  symbol: string
  timeframe: Timeframe | null
  definition: StrategyDefinition
  /** "enabled" only after passing validation; enabling never places orders in this release. */
  status: 'enabled' | 'disabled'
  source: 'manual' | 'ai' | 'converted'
  aiProvider: string | null
  enabledAt: string | null
  createdAt: string
  updatedAt: string
  validation: ValidationResult
  lastBacktest: BacktestSummary | null
  /** The plain-language prompt the rules were interpreted from (null for manually built strategies). */
  prompt: string | null
  /** Current version; every confirmed change creates a new one. */
  version: number
}

export interface StrategyVersion {
  version: number
  name: string
  definition: StrategyDefinition
  prompt: string | null
  /** The plain-language change that produced this version, when it came from an AI-assisted edit. */
  changeRequest: string | null
  source: 'manual' | 'ai' | 'converted'
  aiProvider: string | null
  createdAt: string
}

/** Automation activity for one strategy (paper and live), for the strategy page. */
export interface StrategyActivity {
  sessions: AutomationSessionView[]
  trades: AutoTradeView[]
  events: AutomationEventView[]
}

export type AiProviderId = 'openai' | 'anthropic'
export interface AiPreferences {
  /** Provider used for strategy prompts; null = the first configured one. */
  preferredProvider: AiProviderId | null
}

export interface BacktestOptions {
  days: number
  /** Overrides the strategy's fee assumption for this run (basis points per side). */
  feeBps?: number
  /** Adverse price movement applied to every simulated fill (basis points). */
  slippageBps: number
  initialEquity?: number
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/** One turn of the AI interpreter. Everything here is a proposal for the client to review. */
export interface InterpretationTurn {
  status: 'needs_clarification' | 'ready_for_review' | 'unsupported'
  /** Questions the model asked. */
  questions: string[]
  /** Required elements still missing, found by TradePilot's own checks (not by the model). */
  missing: string[]
  ambiguities: string[]
  unsupported: string[]
  definition: StrategyDefinition
  validation: ValidationResult
  explanation: StrategyExplanation
  /** The model's own summary, shown labelled as AI output. */
  aiSummary: string
  /** To append to the conversation for the next turn. */
  assistantMessage: string
  /** When modifying a saved strategy: what would change compared with its current version (computed by TradePilot). */
  changes: DefinitionChange[] | null
  provider: 'openai' | 'anthropic'
  model: string
  usage: { inputTokens: number; outputTokens: number }
}

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
  netPnl?: number
  totalFees?: number
  feeBps?: number
  slippageBps?: number
  winningTrades?: number
  losingTrades?: number
  avgWin?: number | null
  avgLoss?: number | null
  largestLoss?: number | null
  maxConsecutiveLosses?: number
  daysBlockedByTradeLimit?: number
  daysBlockedByLossLimit?: number
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
  /** True when the self-contained engine shipped with the installer is used (no system Python needed). */
  bundled: boolean
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
/** live: streaming and fresh · delayed: REST polling or brief stream gap · stale: older than allowed · unavailable: no data */
export type DataState = 'live' | 'delayed' | 'stale' | 'unavailable'
export type DeltaRegionId = 'india' | 'global' | 'india_testnet' | 'global_testnet'

export interface Quote {
  symbol: string
  lastPrice: number | null
  markPrice: number | null
  bid: number | null
  ask: number | null
  change24hPct: number | null
  high24h: number | null
  low24h: number | null
  volume24hUsd: number | null
  fundingRate: number | null
  /** exchange timestamp of this update */
  exchangeTime: string | null
  /** when TradePilot received it */
  receivedAt: string
  source: 'websocket' | 'rest'
  state: DataState
}

export interface MarketHealth {
  region: DeltaRegionId
  regionLabel: string
  transport: 'websocket' | 'rest' | 'offline'
  socket: 'disabled' | 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'
  /** increments on every successful (re)connect so views can backfill candles */
  connectionEpoch: number
  lastMessageAt: string | null
  lastRestAt: string | null
  reconnects: number
  lastError: string | null
  instruments: number
  instrumentsAt: string | null
  staleAfterMs: number
  unsupported: string[]
  duplicatesIgnored: number
}

export interface MarketSnapshot {
  health: MarketHealth
  quotes: Record<string, Quote>
  at: string
}

export interface Instrument {
  symbol: string
  productId: number
  settlingAsset: string | null
  description: string
  underlying: string | null
  quoteAsset: string | null
  tickSize: number
  contractValue: number | null
  tradingStatus: string | null
}

export interface CandleGap {
  from: number
  to: number
  missing: number
}

export interface CandleSeries {
  symbol: string
  timeframe: Timeframe
  candles: Candle[]
  gaps: CandleGap[]
  missing: number
  fetchedAt: string
  source: 'historical'
}

export interface LiveCandle {
  symbol: string
  timeframe: Timeframe
  candle: Candle
  receivedAt: string
}

export interface DeltaAccountView {
  configured: boolean
  region: DeltaRegionId
  fetchedAt: string | null
  error: string | null
  balances: { asset: string; balance: number; available: number | null }[]
  positions: { symbol: string; size: number; entryPrice: number | null; margin: number | null; liquidationPrice: number | null; unrealizedPnl: number | null }[]
}

export interface ExchangeOrder {
  id: string
  symbol: string
  side: string
  size: number
  unfilled: number | null
  type: string | null
  state: string | null
  limitPrice: number | null
  avgFillPrice: number | null
  commission: number | null
  createdAt: string | null
}

// ---------- automated trading (Phase 4) ----------
export type AutomationMode = 'paper' | 'live'
export type AutomationStatus = 'running' | 'paused' | 'stopped'
export type OrderState = 'pending' | 'open' | 'partially_filled' | 'filled' | 'cancelled' | 'rejected' | 'unknown'

export interface AutoPosition {
  side: 'long' | 'short'
  contracts: number
  contractValue: number
  entryPrice: number
  entryTime: string
  stopPrice: number | null
  takePrice: number | null
  entryFee: number
}

export interface AutomationSessionView {
  id: string
  strategyId: string | null
  strategyName: string
  symbol: string
  timeframe: string
  mode: AutomationMode
  status: AutomationStatus
  startedAt: string
  stoppedAt: string | null
  stopReason: string | null
  position: AutoPosition | null
  markPrice: number | null
  unrealizedPnl: number | null
  today: { trades: number; realizedPnl: number }
  totals: { trades: number; netPnl: number; fees: number }
  lastEvaluatedAt: string | null
  lastCandle: number | null
  nextEvaluationAt: string | null
  lastDecision: { action: string; reason: string; blockedBy: string[]; at: string } | null
  warning: string | null
  /** Strategy version this session runs (pinned at start; changed only by an explicit apply while flat). */
  strategyVersion: number | null
  /** Newer saved version of the strategy that this session is not running yet. */
  latestVersion: number | null
}

export interface AutoOrderView {
  id: string
  sessionId: string
  mode: AutomationMode
  symbol: string
  side: 'buy' | 'sell'
  purpose: 'entry' | 'exit' | 'emergency'
  size: number
  filledSize: number
  avgFillPrice: number | null
  fee: number
  state: OrderState
  clientOrderId: string
  exchangeOrderId: string | null
  stopPrice: number | null
  takePrice: number | null
  error: string | null
  createdAt: string
  updatedAt: string
}

export interface AutoTradeView {
  id: string
  sessionId: string
  mode: AutomationMode
  symbol: string
  side: 'long' | 'short'
  contracts: number
  entryPrice: number
  exitPrice: number
  entryTime: string
  exitTime: string
  grossPnl: number
  fees: number
  netPnl: number
  exitReason: string
  strategyVersion: number | null
}

export interface AutomationEventView {
  id: number
  sessionId: string | null
  level: 'info' | 'warning' | 'error'
  message: string
  createdAt: string
}

export interface LiveTradingState {
  enabled: boolean
  enabledAt: string | null
  region: DeltaRegionId
  regionLabel: string
  testnet: boolean
  checks: { id: string; label: string; ok: boolean; detail: string }[]
}

export interface TradingOverview {
  live: LiveTradingState
  risk: import('./tradingRisk').TradingRiskSettings
  emergency: { active: boolean; at: string | null; detail: string | null }
  sessions: AutomationSessionView[]
  orders: AutoOrderView[]
  trades: AutoTradeView[]
  events: AutomationEventView[]
  exchange: { lastReconcileAt: string | null; lastError: string | null }
  paperAccount: { equity: number; realizedPnl: number }
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
  welcomeSound: boolean
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
  'integrations:action': [{ id: IntegrationId; action: string; params?: Record<string, unknown> }, { view: IntegrationView; result: IntegrationActionResult }]
  'integrations:clear': [{ id: IntegrationId }, IntegrationView]

  'strategies:list': [void, Strategy[]]
  'strategies:get': [{ id: string }, Strategy]
  'strategies:save': [{ id?: string; definition: StrategyDefinition; source?: 'manual' | 'ai'; aiProvider?: string; prompt?: string; changeRequest?: string }, Strategy]
  'strategies:versions': [{ id: string }, StrategyVersion[]]
  'strategies:activity': [{ id: string }, StrategyActivity]
  'strategies:validate': [{ definition: StrategyDefinition }, ValidationResult]
  'strategies:setEnabled': [{ id: string; enabled: boolean }, Strategy]
  'strategies:delete': [{ id: string }, { id: string }]
  'strategies:duplicate': [{ id: string }, Strategy]
  'strategies:backtest': [{ id: string } & BacktestOptions, BacktestResult]

  'engine:status': [void, EngineStatus]
  'engine:restart': [void, EngineStatus]

  'market:tickers': [{ symbols?: string[] }, Ticker[]]
  'market:symbols': [void, string[]]
  'market:candles': [{ symbol: string; timeframe: Timeframe; days: number }, Candle[]]
  'market:series': [{ symbol: string; timeframe: Timeframe; days: number }, CandleSeries]
  'market:watch': [{ view: string; symbols: string[]; chart?: { symbol: string; timeframe: Timeframe } | null }, MarketSnapshot]
  'market:unwatch': [{ view: string }, void]
  'market:snapshot': [void, MarketSnapshot]
  'market:instruments': [{ refresh?: boolean }, Instrument[]]

  'account:summary': [{ refresh?: boolean }, DeltaAccountView]
  'account:orders': [void, { orders: ExchangeOrder[]; error: string | null; fetchedAt: string | null; configured: boolean }]

  'trading:overview': [void, TradingOverview]
  'trading:saveRisk': [import('./tradingRisk').TradingRiskSettings, TradingOverview]
  'trading:enableLive': [{ password: string; confirmation: string }, TradingOverview]
  'trading:disableLive': [void, TradingOverview]
  'trading:emergencyStop': [void, TradingOverview]
  'trading:clearEmergency': [void, TradingOverview]
  'automation:start': [{ strategyId: string; mode: AutomationMode }, TradingOverview]
  'automation:pause': [{ sessionId: string }, TradingOverview]
  'automation:resume': [{ sessionId: string }, TradingOverview]
  'automation:stop': [{ sessionId: string; closePosition: boolean }, TradingOverview]
  'automation:applyVersion': [{ sessionId: string }, TradingOverview]

  'ai:interpretStrategy': [{ provider?: AiProviderId; messages: ChatMessage[]; baseStrategyId?: string }, InterpretationTurn]
  'ai:getPreferences': [void, AiPreferences]
  'ai:savePreferences': [AiPreferences, AiPreferences]

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
  'market:changed': MarketSnapshot
  'market:candle': LiveCandle
  'integrations:progress': IntegrationProgress
  'trading:changed': TradingOverview
}
export type EventName = keyof EventContract

export const CHANNELS: Channel[] = [
  'app:info', 'auth:status', 'auth:setup', 'auth:unlock', 'auth:lock', 'auth:logout', 'auth:changePassword', 'auth:resetApplication', 'auth:activity',
  'subscription:view', 'subscription:refresh', 'subscription:plans', 'subscription:requests', 'subscription:pickScreenshot', 'subscription:submit',
  'settings:getPreferences', 'settings:savePreferences', 'settings:secretStorage',
  'integrations:list', 'integrations:save', 'integrations:test', 'integrations:action', 'integrations:clear',
  'strategies:list', 'strategies:get', 'strategies:save', 'strategies:validate', 'strategies:setEnabled', 'strategies:delete', 'strategies:duplicate', 'strategies:backtest', 'strategies:versions', 'strategies:activity',
  'engine:status', 'engine:restart',
  'market:tickers', 'market:symbols', 'market:candles', 'market:series', 'market:watch', 'market:unwatch', 'market:snapshot', 'market:instruments',
  'account:summary', 'account:orders', 'ai:interpretStrategy', 'ai:getPreferences', 'ai:savePreferences',
  'trading:overview', 'trading:saveRisk', 'trading:enableLive', 'trading:disableLive', 'trading:emergencyStop', 'trading:clearEmergency',
  'automation:start', 'automation:pause', 'automation:resume', 'automation:stop', 'automation:applyVersion',
  'paper:placeOrder', 'paper:orders', 'paper:positions', 'paper:closePosition', 'paper:reset',
  'notifications:list', 'notifications:markRead', 'notifications:clear',
  'updates:state', 'updates:check', 'updates:install',
  'shell:openDataFolder'
]
export const EVENTS: EventName[] = ['auth:changed', 'subscription:changed', 'updates:changed', 'notifications:changed', 'engine:changed', 'market:changed', 'market:candle', 'integrations:progress', 'trading:changed']

export interface TradePilotBridge {
  invoke<C extends Channel>(channel: C, ...args: Req<C> extends void ? [] : [Req<C>]): Promise<Result<Res<C>>>
  on<E extends EventName>(event: E, listener: (payload: EventContract[E]) => void): () => void
}
