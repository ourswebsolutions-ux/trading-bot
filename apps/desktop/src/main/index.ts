import { appendFileSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, dialog, Notification, powerMonitor, safeStorage, session, shell, type IpcMainInvokeEvent } from 'electron'
import { audit, getSetting, openDatabase, setSetting, type Db } from './db.js'
import { EngineBridge } from './engine.js'
import { UserError } from './errors.js'
import { machineFingerprint } from './fingerprint.js'
import { AiUsageTracker } from './ai/provider.js'
import { AnthropicProvider } from './ai/anthropic.js'
import { OpenAiProvider } from './ai/openai.js'
import { interpretTurn } from './ai/strategyInterpreter.js'
import { ConsentStore } from './channels/whatsapp.js'
import { DeltaAccountService } from './delta/account.js'
import { IntegrationService } from './integrations.js'
import { aiSettings, buildIntegrationSpecs, DEFAULT_OPENAI_MODEL, deltaRegion, marketSettings, migrateIntegrationConfig, smtpSettings } from './integrationSpecs.js'
import { sendSmtp } from '@tradepilot/shared/smtp'
import { DEFAULT_ANTHROPIC_MODEL } from './ai/anthropic.js'
import { redact, redactValue } from './redact.js'
import { AutomationService } from './trading/automation.js'
import { AlertDispatcher } from './trading/alerts.js'
import { DeltaExchange, PaperExchange } from './trading/exchange.js'
import { DeltaRest } from './delta/rest.js'
import { DELTA_REGIONS } from './delta/regions.js'
import { createIpcRegistry, v } from './ipc.js'
import { LocalAuth } from './localAuth.js'
import { MAX_DAYS, MarketDataService } from './marketData.js'
import { NotificationCenter } from './notifications.js'
import { PaperBroker } from './paper.js'
import { SecretStore, type SecretCipher } from './secrets.js'
import { StrategyStore } from './strategies.js'
import { SubscriptionService } from './subscription.js'
import { UpdateService } from './updater.js'
import { loadDesktopConfig } from './config.js'
import type { AiPreferences, BacktestMetrics, BacktestTrade, ChatMessage, EventContract, EventName, GeneralPreferences, IntegrationId, Timeframe } from '../shared/ipc.js'
import type { StrategyDefinition } from '../shared/strategyRules.js'
import { DEFAULT_RISK } from '../shared/tradingRisk.js'

// Development/test-only switches; packaged builds ignore them.
const E2E_HIDDEN = !app.isPackaged && process.env.TRADEPILOT_E2E_HIDDEN === '1'
if (!app.isPackaged && process.env.TRADEPILOT_USER_DATA_DIR) app.setPath('userData', process.env.TRADEPILOT_USER_DATA_DIR)

if (!app.requestSingleInstanceLock()) app.quit()

const INTEGRATION_IDS: IntegrationId[] = ['delta', 'openai', 'anthropic', 'smtp', 'whatsapp', 'marketdata']
const TIMEFRAMES: Timeframe[] = ['5m', '15m', '1h', '4h', '1d']
const DEFAULT_PREFS: GeneralPreferences = {
  welcomeSound: true,
  theme: 'dark',
  autoLockMinutes: 15,
  desktopNotifications: true,
  autoInstallUpdates: true,
  pythonPath: process.platform === 'win32' ? 'python' : 'python3',
  defaultSymbol: 'BTCUSD'
}

let mainWindow: BrowserWindow | null = null
const logDir = () => path.join(app.getPath('userData'), 'logs')
function log(msg: string, extra?: unknown) {
  // every log line passes through the redactor: no credentials in logs
  const line = `${new Date().toISOString()} ${redact(msg)}${extra !== undefined ? ` ${redactValue(extra)}` : ''}\n`
  try {
    mkdirSync(logDir(), { recursive: true })
    appendFileSync(path.join(logDir(), 'main.log'), line)
  } catch {
    // logging must never crash the app
  }
  if (!app.isPackaged) process.stdout.write(line)
}

function emit<E extends EventName>(event: E, payload: EventContract[E]) {
  mainWindow?.webContents.send(`event:${event}`, payload)
}

/** safeStorage-backed cipher. On Linux we refuse the "basic_text" fallback, which is not real encryption. */
const cipher: SecretCipher = {
  available() {
    if (!safeStorage.isEncryptionAvailable()) return { ok: false, backend: 'none', reason: 'The operating system keychain is unavailable, so credentials cannot be stored securely.' }
    if (process.platform === 'linux') {
      const backend = safeStorage.getSelectedStorageBackend()
      if (backend === 'basic_text' || backend === 'unknown') {
        return { ok: false, backend, reason: 'No Secret Service keyring (GNOME Keyring / KWallet) is running, so credentials cannot be encrypted. Install or unlock a keyring and restart TradePilot.' }
      }
      return { ok: true, backend, reason: null }
    }
    return { ok: true, backend: process.platform === 'darwin' ? 'macOS Keychain' : 'Windows DPAPI', reason: null }
  },
  encrypt: (plain) => safeStorage.encryptString(plain),
  decrypt: (buf) => safeStorage.decryptString(buf)
}

async function bootstrap() {
  const userData = app.getPath('userData')
  const db: Db = openDatabase(path.join(userData, 'tradepilot.sqlite'))
  const config = loadDesktopConfig()
  const prefs = (): GeneralPreferences => ({ ...DEFAULT_PREFS, ...getSetting<Partial<GeneralPreferences>>(db, 'preferences', {}) })

  const auth = new LocalAuth(db)
  const devPassword = process.env.TRADEPILOT_DEV_INITIAL_PASSWORD
  if (!app.isPackaged && devPassword) {
    try {
      if (await auth.seedInitialPassword(devPassword)) log('seeded development initial password (must be changed after first login)')
    } catch (err) {
      log(String(err))
    }
  }

  const secrets = new SecretStore(db, cipher)
  const usage = new AiUsageTracker(db)
  const consents = new ConsentStore(db)
  let market: MarketDataService
  const integrations: IntegrationService = new IntegrationService(
    db,
    secrets,
    buildIntegrationSpecs({ integrations: () => integrations, market: () => market, usage, consents, defaultSymbol: () => prefs().defaultSymbol }),
    (id, step) => emit('integrations:progress', { id, step }),
    migrateIntegrationConfig
  )
  market = new MarketDataService({
    region: () => deltaRegion(integrations.config('delta')),
    settings: () => marketSettings(integrations.config('marketdata')),
    onSnapshot: (snap) => emit('market:changed', snap),
    onCandle: (c) => emit('market:candle', c),
    log
  })
  market.start()
  const account = new DeltaAccountService(integrations)
  const notifications = new NotificationCenter(
    db,
    (unread) => emit('notifications:changed', { unread }),
    (title, body) => {
      if (prefs().desktopNotifications && Notification.isSupported()) new Notification({ title, body, silent: false }).show()
    }
  )

  const subscription = new SubscriptionService({
    db,
    secrets,
    apiBaseUrl: config.apiBaseUrl,
    configurationError: config.configurationError,
    publicKey: config.entitlementPublicKey,
    appVersion: app.getVersion(),
    platform: process.platform,
    fingerprint: machineFingerprint,
    onRemoteNotification: (n) => {
      const severity = n.kind === 'payment_approved' ? 'success' : n.kind === 'payment_cancelled' ? 'warning' : 'info'
      notifications.add({ category: 'subscription', severity, title: n.title, body: n.body, remoteId: n.id, createdAt: n.createdAt })
    },
    // payment requests go out through the client's own SMTP connection (password in the OS keychain)
    clientEmail: {
      problem: () =>
        integrations.isConfigured('smtp')
          ? null
          : 'Set up your email connection first: open Settings → SMTP Email, enter your mail server and sign-in, and send a test email. TradePilot sends your payment request to ourswebsolutions@gmail.com from your own email account.',
      address: () => /<?([^<>\s]+@[^<>\s]+)>?\s*$/.exec(integrations.config('smtp').from ?? '')?.[1] ?? null,
      send: async (m) => {
        await sendSmtp(smtpSettings(integrations.config('smtp'), integrations.secret('smtp', 'password')), m)
      }
    }
  })

  const paper = new PaperBroker(db, (s) => market.markPrice(s))
  const strategies = new StrategyStore(db, async () => ({ instruments: await market.instruments().then((l) => l.map((i) => i.symbol)).catch(() => null) }))
  const engineDir = app.isPackaged ? path.join(process.resourcesPath, 'engine') : path.resolve(app.getAppPath(), '../../engine')
  const bundledEngine = app.isPackaged ? path.join(engineDir, 'bin', process.platform === 'win32' ? 'tradepilot-engine.exe' : 'tradepilot-engine') : null
  const engine = new EngineBridge(engineDir, () => prefs().pythonPath, (s) => emit('engine:changed', s), bundledEngine)

  // ---------------- automated trading (Phase 4) ----------------
  const alerts = new AlertDispatcher(integrations, consents, notifications, log)
  const deltaRest = (): DeltaRest | null => {
    if (!integrations.isConfigured('delta')) return null
    return new DeltaRest(deltaRegion(integrations.config('delta')), { apiKey: integrations.secret('delta', 'apiKey')!, apiSecret: integrations.secret('delta', 'apiSecret')! })
  }
  let instrumentsCache: Awaited<ReturnType<typeof market.instruments>> = []
  const liveChecks = () => {
    const delta = integrations.view('delta')
    const recent = delta.lastSuccessAt && Date.now() - Date.parse(delta.lastSuccessAt) < 24 * 3600_000
    const region = DELTA_REGIONS[deltaRegion(integrations.config('delta'))]
    return [
      { id: 'delta', label: 'Delta Exchange connected', ok: delta.state === 'connected' && Boolean(recent), detail: delta.state === 'connected' && recent ? `Last successful test ${new Date(delta.lastSuccessAt!).toLocaleString()}.` : 'Run a successful Delta Exchange connection test (Settings → Delta Exchange) within the last 24 hours.' },
      { id: 'risk', label: 'Account risk settings configured', ok: automation.risk().configured, detail: automation.risk().configured ? 'Risk limits saved.' : 'Save the account risk settings.' },
      { id: 'emergency', label: 'Emergency stop not active', ok: !automation.emergency().active, detail: automation.emergency().active ? 'Clear the emergency stop first.' : 'OK.' },
      { id: 'region', label: region.testnet ? 'Testnet (demo) account' : 'Production account — real money', ok: true, detail: region.label }
    ]
  }
  let tradingEmitPending = false
  const automation: AutomationService = new AutomationService({
    db,
    engine: (method, params) => engine.request(method, params, 30_000),
    strategy: async (id) => strategies.get(id).catch(() => null),
    validate: (d) => strategies.validate(d),
    candles: (symbol, tf, days) => market.candles(symbol, tf, days),
    instruments: async () => (instrumentsCache = await market.instruments(true)),
    markPrice: (symbol) => market.markPrice(symbol),
    liveExchange: () => {
      const rest = deltaRest()
      return rest ? new DeltaExchange(rest) : null
    },
    paperExchange: new PaperExchange(
      (symbol) => market.markPrice(symbol),
      (symbol) => instrumentsCache.find((i) => i.symbol === symbol)?.contractValue ?? 0,
      () => 5,
      () => automation.risk().paperSlippageBps
    ),
    liveAccount: async () => {
      const rest = deltaRest()
      if (!rest) throw new UserError('not_configured', 'Delta Exchange is not configured.')
      const balances = await rest.balances()
      const settle = instrumentsCache.find((i) => automation.activeSymbols().includes(i.symbol))?.settlingAsset ?? 'USD'
      const b = balances.find((x) => x.asset_symbol === settle) ?? balances.find((x) => x.asset_symbol === 'USD') ?? balances[0]
      return { equity: b?.balance ?? 0, available: b?.available_balance ?? null }
    },
    liveChecks,
    region: () => {
      const r = DELTA_REGIONS[deltaRegion(integrations.config('delta'))]
      return { id: r.id, label: r.label, testnet: r.testnet }
    },
    watchSymbols: (symbols) => void market.watch('automation', symbols),
    alert: (a) => alerts.send(a),
    onChange: () => {
      if (tradingEmitPending) return
      tradingEmitPending = true
      setTimeout(() => {
        tradingEmitPending = false
        void tradingOverview().then((o) => emit('trading:changed', o)).catch(() => undefined)
      }, 300)
    },
    log
  })
  const currentMarks = () => {
    const marks: Record<string, number | undefined> = {}
    for (const [sym, q] of Object.entries(market.snapshot().quotes)) marks[sym] = q.markPrice ?? q.lastPrice ?? undefined
    return marks
  }
  const tradingOverview = async () => automation.overview(currentMarks())
  void market.instruments().then((l) => (instrumentsCache = l)).catch(() => undefined)
  automation.startScheduler()

  const updates = new UpdateService(
    (s) => {
      emit('updates:changed', s)
      if (s.phase === 'downloaded') notifications.add({ category: 'update', severity: 'info', title: `Update ${s.availableVersion} ready`, body: 'Restart TradePilot to install it, or it will install automatically when you quit.', native: true })
    },
    // Safe to restart only when the user opted in, the session is locked and nobody has touched the computer for 2 minutes.
    () => prefs().autoInstallUpdates && !auth.isUnlocked() && powerMonitor.getSystemIdleTime() >= 120,
    log
  )

  const lockSession = (reason: 'manual' | 'idle' | 'logout') => {
    const status = auth.lock(reason)
    emit('auth:changed', status)
    updates.maybeAutoInstall()
    return status
  }

  // ---------------- IPC ----------------
  const ipc = createIpcRegistry({
    isTrustedSender: (event: IpcMainInvokeEvent) => {
      const url = event.senderFrame?.url ?? ''
      if (!mainWindow || event.sender !== mainWindow.webContents) return false
      return app.isPackaged ? url.startsWith('file://') : url.startsWith('file://') || url.startsWith(process.env.ELECTRON_RENDERER_URL ?? '\u0000')
    },
    isUnlocked: () => auth.isUnlocked(),
    log
  })

  let lastActivity = Date.now()
  const afterUnlock = () => {
    lastActivity = Date.now()
    emit('auth:changed', auth.status())
    void subscription.refresh().then((view) => emit('subscription:changed', view))
  }

  ipc.handle('app:info', () => ({
    welcomeSound: prefs().welcomeSound,
    version: app.getVersion(),
    platform: `${process.platform}-${process.arch}`,
    packaged: app.isPackaged,
    dataPath: userData,
    apiBaseUrl: config.apiBaseUrl || null,
    deviceId: subscription.deviceId
  }), { auth: false })
  ipc.handle('auth:status', () => auth.status(), { auth: false })
  ipc.handle('auth:setup', async (req) => {
    const o = v.obj(req)
    const status = await auth.setup(v.str(o.password, 1024), v.str(o.confirm, 1024))
    afterUnlock()
    return status
  }, { auth: false })
  ipc.handle('auth:unlock', async (req) => {
    const result = await auth.unlock(v.str(v.obj(req).password, 1024))
    if (result.unlocked) afterUnlock()
    return result
  }, { auth: false })
  ipc.handle('auth:lock', () => lockSession('manual'))
  ipc.handle('auth:logout', () => lockSession('logout'))
  ipc.handle('auth:changePassword', async (req) => {
    const o = v.obj(req)
    const status = await auth.changePassword(v.str(o.current, 1024), v.str(o.next, 1024), v.str(o.confirm, 1024))
    notifications.add({ category: 'security', severity: 'success', title: 'Password changed', body: 'Your TradePilot password was changed.', native: false })
    return status
  })
  ipc.handle('auth:resetApplication', async (req) => {
    if (v.str(v.obj(req).confirmation, 100) !== 'RESET') throw new UserError('validation_failed', 'Type RESET to confirm.', { confirmation: 'Type RESET' })
    // Wipes local data only. Trial and subscription live on the server and are restored on next sign-in.
    engine.stop()
    db.close()
    rmSync(path.join(userData, 'tradepilot.sqlite'), { force: true })
    rmSync(path.join(userData, 'tradepilot.sqlite-wal'), { force: true })
    rmSync(path.join(userData, 'tradepilot.sqlite-shm'), { force: true })
    log('local data reset by user')
    app.relaunch()
    app.exit(0)
    return auth.status()
  }, { auth: false })
  ipc.handle('auth:activity', () => {
    lastActivity = Date.now()
  })

  ipc.handle('subscription:view', () => subscription.view())
  ipc.handle('subscription:refresh', async () => {
    const view = await subscription.refresh()
    emit('subscription:changed', view)
    return view
  })
  ipc.handle('subscription:plans', () => subscription.plans())
  ipc.handle('subscription:requests', () => subscription.requests())
  ipc.handle('subscription:pickScreenshot', async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: 'Select payment screenshot',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
    })
    if (res.canceled || !res.filePaths[0]) return null
    return subscription.loadScreenshot(res.filePaths[0])
  })
  ipc.handle('subscription:submit', async (req) => {
    const o = v.obj(req)
    const created = await subscription.submit({
      planCode: v.str(o.planCode, 20),
      transactionId: v.str(o.transactionId, 100),
      contactEmail: v.optStr(o.contactEmail, 254),
      note: v.optStr(o.note, 600),
      screenshotId: v.str(o.screenshotId, 64)
    })
    audit(db, 'subscription.payment_submitted', { requestId: created.id, plan: created.planCode })
    notifications.add({ category: 'subscription', severity: 'info', title: 'Payment request submitted', body: `Request ${created.id.slice(0, 8)} is pending administrator review.`, native: false })
    emit('subscription:changed', subscription.view())
    return created
  })

  ipc.handle('settings:getPreferences', () => prefs())
  ipc.handle('settings:savePreferences', (req) => {
    const o = v.obj(req)
    const next = { ...prefs() }
    if (o.theme !== undefined) next.theme = v.oneOf(o.theme, ['dark', 'light', 'system'] as const)
    if (o.autoLockMinutes !== undefined) next.autoLockMinutes = Math.round(v.num(o.autoLockMinutes, 1, 240))
    if (o.desktopNotifications !== undefined) next.desktopNotifications = Boolean(o.desktopNotifications)
    if (o.autoInstallUpdates !== undefined) next.autoInstallUpdates = Boolean(o.autoInstallUpdates)
    if (o.pythonPath !== undefined) {
      const p = v.str(o.pythonPath, 400).trim()
      if (!p) throw new UserError('validation_failed', 'Python path is required.', { pythonPath: 'Required' })
      next.pythonPath = p
    }
    if (o.welcomeSound !== undefined) next.welcomeSound = Boolean(o.welcomeSound)
    if (o.defaultSymbol !== undefined) {
      const s = v.str(o.defaultSymbol, 32).trim().toUpperCase()
      if (!/^[A-Z0-9_]{2,32}$/.test(s)) throw new UserError('validation_failed', 'Invalid symbol.', { defaultSymbol: 'Invalid symbol' })
      next.defaultSymbol = s
    }
    const pythonChanged = next.pythonPath !== prefs().pythonPath
    setSetting(db, 'preferences', next)
    if (pythonChanged) void engine.restart()
    return next
  })
  ipc.handle('settings:secretStorage', () => {
    const info = secrets.info()
    return { available: info.ok, backend: info.backend, message: info.reason }
  })
  ipc.handle('integrations:list', () => integrations.list())
  ipc.handle('integrations:save', (req) => {
    const o = v.obj(req)
    const id = v.oneOf(o.id, INTEGRATION_IDS)
    const view = integrations.save({ id, config: v.strRecord(o.config ?? {}), secrets: v.strRecord(o.secrets ?? {}) })
    audit(db, 'integration.saved', { id })
    if (id === 'delta' || id === 'marketdata') market.applySettings()
    if (id === 'delta') account.invalidate()
    return view
  })
  ipc.handle('integrations:test', async (req) => {
    const id = v.oneOf(v.obj(req).id, INTEGRATION_IDS)
    const { view, result } = await integrations.run(id, 'test')
    audit(db, 'integration.tested', { id, ok: result.ok })
    return view
  })
  ipc.handle('integrations:action', async (req) => {
    const o = v.obj(req)
    const id = v.oneOf(o.id, INTEGRATION_IDS)
    const action = v.str(o.action, 40)
    const params = o.params === undefined ? {} : v.obj(o.params)
    const out = await integrations.run(id, action, params)
    audit(db, 'integration.action', { id, action, ok: out.result.ok })
    if (id === 'delta') account.invalidate()
    return out
  })
  ipc.handle('integrations:clear', (req) => {
    const id = v.oneOf(v.obj(req).id, INTEGRATION_IDS)
    audit(db, 'integration.cleared', { id })
    const view = integrations.clear(id)
    if (id === 'delta' || id === 'marketdata') market.applySettings()
    if (id === 'delta') account.invalidate()
    return view
  })

  // Viewing, disabling and deleting strategies is always allowed; creating, editing, enabling and running them is a paid feature.
  const definitionArg = (x: unknown) => {
    const d = v.obj(x) as unknown as StrategyDefinition
    if (JSON.stringify(d).length > 64_000) throw new UserError('validation_failed', 'The strategy definition is too large.')
    return d
  }
  ipc.handle('strategies:list', () => strategies.list())
  ipc.handle('strategies:get', (req) => strategies.get(v.str(v.obj(req).id, 64)))
  ipc.handle('strategies:validate', (req) => strategies.validate(definitionArg(v.obj(req).definition)))
  ipc.handle('strategies:save', (req) => {
    subscription.requireAccess('Editing strategies')
    const o = v.obj(req)
    const source = o.source === 'ai' ? 'ai' : 'manual'
    return strategies.save(v.optStr(o.id, 64), definitionArg(o.definition), {
      source,
      aiProvider: source === 'ai' ? v.oneOf(o.aiProvider, ['openai', 'anthropic'] as const) : undefined,
      prompt: v.optStr(o.prompt, 8000),
      changeRequest: v.optStr(o.changeRequest, 4000)
    })
  })
  ipc.handle('strategies:versions', (req) => strategies.versions(v.str(v.obj(req).id, 64)))
  ipc.handle('strategies:activity', (req) => automation.strategyActivity(v.str(v.obj(req).id, 64), currentMarks()))
  ipc.handle('strategies:setEnabled', (req) => {
    const o = v.obj(req)
    const enabled = o.enabled === true
    if (enabled) subscription.requireAccess('Enabling strategies')
    return strategies.setEnabled(v.str(o.id, 64), enabled)
  })
  ipc.handle('strategies:delete', (req) => {
    const id = v.str(v.obj(req).id, 64)
    strategies.delete(id)
    return { id }
  })
  ipc.handle('strategies:duplicate', (req) => {
    subscription.requireAccess('Creating strategies')
    return strategies.duplicate(v.str(v.obj(req).id, 64))
  })
  ipc.handle('strategies:backtest', async (req) => {
    subscription.requireAccess('Backtesting')
    const o = v.obj(req)
    const s = await strategies.get(v.str(o.id, 64))
    if (!s.validation.valid) throw new UserError('strategy_invalid', `Fix the strategy before backtesting: ${s.validation.errors[0]!.message}`)
    const tf = s.timeframe!
    const days = Math.round(v.num(o.days, 1, MAX_DAYS[tf]))
    const slippageBps = o.slippageBps === undefined ? 0 : v.num(o.slippageBps, 0, 500)
    const feeBps = o.feeBps === undefined ? s.definition.risk.feeBps : v.num(o.feeBps, 0, 100)
    const initialEquity = o.initialEquity === undefined ? 10_000 : v.num(o.initialEquity, 100, 1e9)
    const candles = await market.candles(s.symbol, tf, days)
    if (candles.length < 30) throw new UserError('insufficient_data', `Only ${candles.length} candles are available for ${s.symbol} ${tf}; at least 30 are needed.`)
    const result = await engine.request<{ metrics: BacktestMetrics; trades: BacktestTrade[]; equityCurve: [number, number][] }>('backtest_rules', { definition: s.definition, candles, feeBps, slippageBps, initialEquity })
    const runId = strategies.recordBacktest(s.id, s.symbol, tf, candles[0]!.time, candles.at(-1)!.time, result.metrics, s.version)
    audit(db, 'strategy.backtested', { id: s.id, version: s.version, runId, bars: candles.length, feeBps, slippageBps })
    return { runId, strategyId: s.id, symbol: s.symbol, timeframe: tf, candles, ...result }
  })

  ipc.handle('engine:status', () => engine.getStatus())
  ipc.handle('engine:restart', () => engine.restart())

  ipc.handle('market:tickers', (req) => {
    const symbols = req ? (v.obj(req).symbols as unknown) : undefined
    return market.tickers(Array.isArray(symbols) ? symbols.slice(0, 50).map((s) => v.str(s, 32)) : undefined)
  })
  ipc.handle('market:symbols', async () => (await market.instruments()).map((i) => i.symbol))
  ipc.handle('market:instruments', (req) => market.instruments(Boolean(req && v.obj(req).refresh)))
  // Public market data (no credentials) is also available on the login screen.
  ipc.handle('market:snapshot', () => market.snapshot(), { auth: false })
  ipc.handle('market:watch', (req) => {
    const o = v.obj(req)
    const symbols = Array.isArray(o.symbols) ? o.symbols.slice(0, 50).map((s) => v.str(s, 32)) : []
    const chart = o.chart ? v.obj(o.chart) : null
    return market.watch(v.str(o.view, 40), symbols, chart ? { symbol: v.str(chart.symbol, 32), timeframe: v.oneOf(chart.timeframe, TIMEFRAMES) } : null)
  }, { auth: false })
  ipc.handle('market:unwatch', (req) => market.unwatch(v.str(v.obj(req).view, 40)), { auth: false })
  ipc.handle('market:series', (req) => {
    const o = v.obj(req)
    const tf = v.oneOf(o.timeframe, TIMEFRAMES)
    return market.series(v.str(o.symbol, 32), tf, Math.round(v.num(o.days, 1, MAX_DAYS[tf])))
  }, { auth: false })

  // ---- automated trading controls ----
  ipc.handle('trading:overview', () => tradingOverview())
  ipc.handle('trading:saveRisk', async (req) => {
    const o = v.obj(req)
    automation.saveRisk({
      configured: true,
      maxExposurePct: v.num(o.maxExposurePct, -1e12, 1e12),
      maxOpenPositions: v.num(o.maxOpenPositions, -1e12, 1e12),
      accountMaxDailyLossPct: v.num(o.accountMaxDailyLossPct, -1e12, 1e12),
      maxOrderNotionalUsd: v.num(o.maxOrderNotionalUsd, -1e12, 1e12),
      paperStartingEquity: v.num(o.paperStartingEquity, -1e12, 1e12),
      paperSlippageBps: o.paperSlippageBps === undefined ? DEFAULT_RISK.paperSlippageBps : v.num(o.paperSlippageBps, -1e12, 1e12),
      emergencyAction: v.oneOf(o.emergencyAction, ['close_positions', 'keep_positions'] as const)
    })
    return tradingOverview()
  })
  ipc.handle('trading:enableLive', async (req) => {
    subscription.requireAccess('Live trading')
    const o = v.obj(req)
    if (v.str(o.confirmation, 40) !== 'ENABLE LIVE TRADING') throw new UserError('validation_failed', 'Type ENABLE LIVE TRADING to confirm.', { confirmation: 'Type ENABLE LIVE TRADING' })
    if (!(await auth.confirmPassword(v.str(o.password, 1024)))) throw new UserError('invalid_password', 'Incorrect password.', { password: 'Incorrect password' })
    automation.setLive(true)
    return tradingOverview()
  })
  ipc.handle('trading:disableLive', async () => {
    automation.setLive(false)
    return tradingOverview()
  })
  ipc.handle('trading:emergencyStop', async () => {
    await automation.emergencyStop()
    return tradingOverview()
  })
  ipc.handle('trading:clearEmergency', async () => {
    automation.clearEmergency()
    return tradingOverview()
  })
  ipc.handle('automation:start', async (req) => {
    subscription.requireAccess('Automated trading')
    const o = v.obj(req)
    await automation.start(v.str(o.strategyId, 64), v.oneOf(o.mode, ['paper', 'live'] as const))
    return tradingOverview()
  })
  ipc.handle('automation:pause', async (req) => {
    automation.pause(v.str(v.obj(req).sessionId, 64))
    return tradingOverview()
  })
  ipc.handle('automation:resume', async (req) => {
    subscription.requireAccess('Automated trading')
    await automation.resume(v.str(v.obj(req).sessionId, 64))
    return tradingOverview()
  })
  ipc.handle('automation:applyVersion', async (req) => {
    subscription.requireAccess('Automated trading')
    await automation.applyLatestVersion(v.str(v.obj(req).sessionId, 64))
    return tradingOverview()
  })
  ipc.handle('automation:stop', async (req) => {
    const o = v.obj(req)
    await automation.stop(v.str(o.sessionId, 64), o.closePosition === true)
    return tradingOverview()
  })

  ipc.handle('account:summary', (req) => account.summary(Boolean(req && v.obj(req).refresh)))
  ipc.handle('account:orders', () => account.orders())

  // The AI proposes rules in a conversation; nothing is saved until the client reviews and confirms it in the UI.
  ipc.handle('ai:interpretStrategy', async (req) => {
    subscription.requireAccess('AI strategy interpretation')
    const o = v.obj(req)
    const provider = o.provider === undefined ? chooseAiProvider() : v.oneOf(o.provider, ['openai', 'anthropic'] as const)
    if (!integrations.isConfigured(provider)) throw new UserError('not_configured', `Configure ${provider === 'openai' ? 'OpenAI' : 'Anthropic Claude'} in Settings first.`)
    const base = o.baseStrategyId === undefined ? undefined : (await strategies.get(v.str(o.baseStrategyId, 64))).definition
    const raw = Array.isArray(o.messages) ? o.messages.slice(-20) : []
    const messages: ChatMessage[] = raw.map((m) => {
      const mo = v.obj(m)
      return { role: v.oneOf(mo.role, ['user', 'assistant'] as const), content: v.str(mo.content, 20_000) }
    })
    const key = integrations.secret(provider, 'apiKey')!
    const client = provider === 'openai' ? new OpenAiProvider(key) : new AnthropicProvider(key)
    const settings = aiSettings(integrations.config(provider), provider === 'openai' ? DEFAULT_OPENAI_MODEL : DEFAULT_ANTHROPIC_MODEL)
    const symbols = await market.instruments().then((l) => l.map((i) => i.symbol)).catch(() => [])
    const turn = await interpretTurn(messages, client, usage, settings, symbols, base)
    audit(db, 'ai.strategy_turn', { provider, model: turn.model, status: turn.status, modify: Boolean(base), tokens: turn.usage.inputTokens + turn.usage.outputTokens })
    return turn
  })
  const aiPreferences = (): AiPreferences => getSetting<AiPreferences>(db, 'ai.preferences', { preferredProvider: null })
  /** The preferred provider if it is configured, otherwise the first configured one. */
  const chooseAiProvider = (): 'openai' | 'anthropic' => {
    const pref = aiPreferences().preferredProvider
    if (pref && integrations.isConfigured(pref)) return pref
    const any = (['anthropic', 'openai'] as const).find((p) => integrations.isConfigured(p))
    if (!any) throw new UserError('not_configured', 'Add an OpenAI or Anthropic Claude API key in Settings → Connections first.')
    return any
  }
  ipc.handle('ai:getPreferences', () => aiPreferences())
  ipc.handle('ai:savePreferences', (req) => {
    const o = v.obj(req)
    const preferredProvider = o.preferredProvider === null ? null : v.oneOf(o.preferredProvider, ['openai', 'anthropic'] as const)
    setSetting(db, 'ai.preferences', { preferredProvider })
    audit(db, 'ai.preferences_saved', { preferredProvider })
    return aiPreferences()
  })
  ipc.handle('market:candles', (req) => {
    const o = v.obj(req)
    const tf = v.oneOf(o.timeframe, TIMEFRAMES)
    return market.candles(v.str(o.symbol, 32), tf, Math.round(v.num(o.days, 1, MAX_DAYS[tf])))
  })

  ipc.handle('paper:placeOrder', async (req) => {
    subscription.requireAccess('Paper trading')
    const o = v.obj(req)
    const order = await paper.place(v.str(o.symbol, 32), v.oneOf(o.side, ['buy', 'sell'] as const), v.num(o.quantity, 0, 1e9))
    notifications.add({ category: 'trading', severity: 'info', title: `Paper ${order.side} filled`, body: `${order.quantity} ${order.symbol} @ ${order.fillPrice}`, native: false })
    return order
  })
  ipc.handle('paper:orders', () => paper.orders())
  ipc.handle('paper:positions', async () => {
    const symbols = [...new Set(paper.orders().map((o) => o.symbol))]
    let marks: Record<string, number> = {}
    if (symbols.length) {
      try {
        marks = Object.fromEntries((await market.tickers(symbols)).map((t) => [t.symbol, t.markPrice]))
      } catch {
        marks = {} // positions still render; P&L shows as unavailable
      }
    }
    return paper.positions(marks)
  })
  ipc.handle('paper:closePosition', async (req) => {
    subscription.requireAccess('Paper trading')
    return paper.close(v.str(v.obj(req).symbol, 32))
  })
  ipc.handle('paper:reset', () => paper.reset())

  ipc.handle('notifications:list', () => notifications.list())
  ipc.handle('notifications:markRead', (req) => {
    const ids = v.obj(req).ids
    return notifications.markRead(ids === 'all' ? 'all' : Array.isArray(ids) ? ids.map((x) => v.str(x, 64)) : [])
  })
  ipc.handle('notifications:clear', () => notifications.clearRead())

  ipc.handle('updates:state', () => updates.getState(), { auth: false })
  ipc.handle('updates:check', () => updates.check())
  ipc.handle('updates:install', () => updates.install())
  ipc.handle('shell:openDataFolder', async () => {
    const err = await shell.openPath(userData)
    if (err) throw new UserError('open_failed', err)
  })

  // ---------------- background work ----------------
  setInterval(() => {
    if (!auth.isUnlocked()) return
    const idleMs = Math.min(Date.now() - lastActivity, powerMonitor.getSystemIdleTime() * 1000 + 1000)
    if (idleMs > prefs().autoLockMinutes * 60_000) lockSession('idle')
  }, 15_000).unref()
  powerMonitor.on('lock-screen', () => auth.isUnlocked() && lockSession('idle'))
  powerMonitor.on('suspend', () => auth.isUnlocked() && lockSession('idle'))

  // Poll the server while unlocked: picks up approvals/cancellations and keeps the trial clock honest.
  let lastAllowed: boolean | null = null
  setInterval(async () => {
    if (!auth.isUnlocked() || !subscription.configured) return
    const view = await subscription.refresh()
    if (lastAllowed === true && !view.access.allowed && view.status) {
      notifications.add({ category: 'subscription', severity: 'warning', title: 'Paid features are paused', body: view.access.detail })
    }
    lastAllowed = view.access.allowed
    emit('subscription:changed', view)
  }, 60_000).unref()

  app.on('before-quit', () => {
    automation.stopScheduler()
    engine.stop()
    market.stop()
  })
  return { updates, prefs }
}

function createWindow(theme: string) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    title: 'TradePilot',
    backgroundColor: theme === 'light' ? '#f5f4f0' : '#0e1013',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      // the welcome screen plays a short synthesized chime without a click first
      autoplayPolicy: 'no-user-gesture-required',
      // test runs render offscreen: frames, input and screenshots work with no visible window
      offscreen: E2E_HIDDEN
    }
  })
  mainWindow.once('ready-to-show', () => !E2E_HIDDEN && mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault())
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  mainWindow.on('closed', () => (mainWindow = null))
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'notifications'))
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'notifications')
  try {
    const { updates, prefs } = await bootstrap()
    createWindow(prefs().theme)
    updates.start()
  } catch (err) {
    log('fatal startup error', err instanceof Error ? err.stack : err)
    dialog.showErrorBox('TradePilot could not start', err instanceof Error ? err.message : String(err))
    app.exit(1)
  }
})

app.on('window-all-closed', () => app.quit())
