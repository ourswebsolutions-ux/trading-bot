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
import type { AiPreferences, BacktestMetrics, BacktestTrade, BrokerId, ChatMessage, EventContract, EventName, GeneralPreferences, Instrument, IntegrationId, Timeframe } from '../shared/ipc.js'
import { BrokerMarkets } from './brokers/markets.js'
import { Mt5AccountService, tradeModeOf } from './mt5/account.js'
import { GoldService } from './gold/service.js'
import type { GoldSettings } from '../shared/gold.js'
import { Mt5BridgeClient } from './mt5/client.js'
import { Mt5Connection } from './mt5/connection.js'
import { Mt5MarketData } from './mt5/marketData.js'
import { Mt5Exchange } from './trading/mt5Exchange.js'
import { venueOf, type StrategyDefinition } from '../shared/strategyRules.js'
import { DEFAULT_RISK } from '../shared/tradingRisk.js'
import { sizingSpecOf } from '../shared/sizing.js'

// Development/test-only switches; packaged builds ignore them.
const E2E_HIDDEN = !app.isPackaged && process.env.TRADEPILOT_E2E_HIDDEN === '1'
if (!app.isPackaged && process.env.TRADEPILOT_USER_DATA_DIR) app.setPath('userData', process.env.TRADEPILOT_USER_DATA_DIR)

if (!app.requestSingleInstanceLock()) app.quit()

const INTEGRATION_IDS: IntegrationId[] = ['delta', 'mt5', 'openai', 'anthropic', 'smtp', 'whatsapp', 'marketdata']
/** Identifies TradePilot's orders and positions in MetaTrader 5 (shared by all MT5 automations). */
const MT5_MAGIC = 260901
/** Manual BUY/SELL orders from the Gold Bot page (kept apart from the bot's own orders). */
const MT5_MANUAL_MAGIC = 260902
const TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '30m', '1h', '4h', '1d']
const DEFAULT_PREFS: GeneralPreferences = {
  welcomeSound: true,
  theme: 'dark',
  autoLockMinutes: 15,
  desktopNotifications: true,
  autoInstallUpdates: true,
  pythonPath: process.platform === 'win32' ? 'python' : 'python3',
  defaultSymbol: 'BTCUSD',
  // XAUUSD on MetaTrader 5 is the primary instrument; MT5 exists only on Windows, so other
  // systems start on Delta Exchange (the user can switch in Settings → General)
  broker: process.platform === 'win32' ? 'mt5' : 'delta',
  defaultSymbolMt5: 'XAUUSD'
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
  let deltaMarket: MarketDataService
  let mt5Market: Mt5MarketData
  let mt5Conn: Mt5Connection
  const integrations: IntegrationService = new IntegrationService(
    db,
    secrets,
    buildIntegrationSpecs({ integrations: () => integrations, market: () => deltaMarket, usage, consents, defaultSymbol: () => prefs().defaultSymbol, mt5: () => ({ conn: mt5Conn, market: mt5Market }) }),
    (id, step) => emit('integrations:progress', { id, step }),
    migrateIntegrationConfig
  )
  const activeBroker = (): BrokerId => (prefs().broker === 'mt5' ? 'mt5' : 'delta')
  deltaMarket = new MarketDataService({
    region: () => deltaRegion(integrations.config('delta')),
    settings: () => marketSettings(integrations.config('marketdata')),
    onSnapshot: (snap) => activeBroker() === 'delta' && emit('market:changed', snap),
    onCandle: (c) => activeBroker() === 'delta' && emit('market:candle', c),
    log
  })
  const engineDir = app.isPackaged ? path.join(process.resourcesPath, 'engine') : path.resolve(app.getAppPath(), '../../engine')

  // ---------------- MetaTrader 5 (Windows: official MetaTrader5 package + local MT5 terminal) ----------------
  const mt5Client = new Mt5BridgeClient({
    engineDir,
    bundledExecutable: app.isPackaged ? path.join(engineDir, 'mt5', 'tradepilot-mt5-bridge.exe') : null,
    python: () => prefs().pythonPath,
    log
  })
  mt5Conn = new Mt5Connection(
    mt5Client,
    () => {
      if (!integrations.isConfigured('mt5')) return null
      const c = integrations.config('mt5')
      return { login: c.login!, password: integrations.secret('mt5', 'password')!, server: c.server!, path: c.terminalPath || undefined }
    },
    // per trade server: another broker's server may run on another clock
    {
      get: () => getSetting<Record<string, number>>(db, 'mt5.serverOffsets', {})[integrations.config('mt5').server ?? ''] ?? null,
      set: (sec) => setSetting(db, 'mt5.serverOffsets', { ...getSetting<Record<string, number>>(db, 'mt5.serverOffsets', {}), [integrations.config('mt5').server ?? '']: sec })
    },
    undefined,
    log
  )
  mt5Market = new Mt5MarketData({
    conn: mt5Conn,
    settings: () => marketSettings(integrations.config('marketdata')),
    onSnapshot: (snap) => activeBroker() === 'mt5' && emit('market:changed', snap),
    onCandle: (c) => activeBroker() === 'mt5' && emit('market:candle', c),
    log
  })
  const mt5Account = new Mt5AccountService(mt5Conn, () => integrations.isConfigured('mt5'))
  // stateless; built per use so a changed slippage limit applies to the next order
  const mt5Exchange = () => new Mt5Exchange(mt5Conn, { magic: MT5_MAGIC, deviationPoints: Number(integrations.config('mt5').deviationPoints) || 20 })
  const mt5ManualExchange = () => new Mt5Exchange(mt5Conn, { magic: MT5_MANUAL_MAGIC, deviationPoints: Number(integrations.config('mt5').deviationPoints) || 20 })
  const resetMt5 = () => {
    void mt5Conn.reset()
    mt5Market.applySettings()
    mt5Account.invalidate()
  }

  // screens see the active broker; automation addresses each broker directly
  const market = new BrokerMarkets({ delta: deltaMarket, mt5: mt5Market }, activeBroker)
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
  const strategies = new StrategyStore(db, async (venue) => ({ instruments: await market.for(venue).instruments().then((l) => l.map((i) => i.symbol)).catch(() => null) }))
  const bundledEngine = app.isPackaged ? path.join(engineDir, 'bin', process.platform === 'win32' ? 'tradepilot-engine.exe' : 'tradepilot-engine') : null
  const engine = new EngineBridge(engineDir, () => prefs().pythonPath, (s) => emit('engine:changed', s), bundledEngine)

  // ---------------- automated trading (Phase 4) ----------------
  const alerts = new AlertDispatcher(integrations, consents, notifications, log)
  const deltaRest = (): DeltaRest | null => {
    if (!integrations.isConfigured('delta')) return null
    return new DeltaRest(deltaRegion(integrations.config('delta')), { apiKey: integrations.secret('delta', 'apiKey')!, apiSecret: integrations.secret('delta', 'apiSecret')! })
  }
  let instrumentsCache: Instrument[] = []
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
  const mt5AccountInfo = () => (integrations.view('mt5').extras.account ?? null) as { login: number; server: string; tradeMode: 'demo' | 'contest' | 'real'; currency: string } | null
  const mt5LiveChecks = () => {
    const view = integrations.view('mt5')
    const recent = view.lastSuccessAt && Date.now() - Date.parse(view.lastSuccessAt) < 24 * 3600_000
    const platform = mt5Client.unavailable()
    const acct = mt5AccountInfo()
    const algo = view.extras.algoTrading === true
    return [
      { id: 'platform', label: 'Windows with the MetaTrader 5 terminal', ok: !platform, detail: platform ?? 'OK.' },
      { id: 'mt5', label: 'MetaTrader 5 connected', ok: view.state === 'connected' && Boolean(recent), detail: view.state === 'connected' && recent ? `Last successful test ${new Date(view.lastSuccessAt!).toLocaleString()}.` : 'Run a successful MetaTrader 5 connection test (Settings → MetaTrader 5) within the last 24 hours.' },
      { id: 'algo', label: 'Algo Trading allowed', ok: algo, detail: algo ? 'Allowed in the terminal and for the account.' : 'Turn on the "Algo Trading" button in the MT5 terminal (and check the account allows expert trading), then run the connection test again.' },
      { id: 'risk', label: 'Account risk settings configured', ok: automation.risk().configured, detail: automation.risk().configured ? 'Risk limits saved (amounts are in the MT5 account currency).' : 'Save the account risk settings.' },
      { id: 'emergency', label: 'Emergency stop not active', ok: !automation.emergency().active, detail: automation.emergency().active ? 'Clear the emergency stop first.' : 'OK.' },
      { id: 'region', label: !acct ? 'Account type unknown' : acct.tradeMode === 'demo' ? 'Demo account' : acct.tradeMode === 'contest' ? 'Contest account' : 'REAL-MONEY account', ok: Boolean(acct), detail: acct ? `${acct.server} · login ${acct.login} · ${acct.currency}` : 'Run the connection test to identify the account.' }
    ]
  }
  let tradingEmitPending = false
  const automation: AutomationService = new AutomationService({
    db,
    engine: (method, params) => engine.request(method, params, 30_000),
    strategy: async (id) => strategies.get(id).catch(() => null),
    validate: (d) => strategies.validate(d),
    candles: (symbol, tf, days) => deltaMarket.candles(symbol, tf, days),
    instruments: async () => (instrumentsCache = await deltaMarket.instruments(true)),
    markPrice: (symbol) => deltaMarket.markPrice(symbol),
    liveExchange: () => {
      const rest = deltaRest()
      return rest ? new DeltaExchange(rest) : null
    },
    paperExchange: new PaperExchange(
      (symbol) => deltaMarket.markPrice(symbol),
      (symbol) => {
        const inst = instrumentsCache.find((i) => i.symbol === symbol)
        return (inst && sizingSpecOf(inst)?.valuePerPoint) ?? 0
      },
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
    watchSymbols: (symbols) => void deltaMarket.watch('automation', symbols),
    venues: {
      mt5: {
        candles: (symbol, tf, days) => mt5Market.candles(symbol, tf, days, true),
        instruments: () => mt5Market.instruments(),
        instrument: (symbol) => mt5Market.instrument(symbol),
        markPrice: (symbol) => mt5Market.markPrice(symbol),
        quote: (symbol) => mt5Market.quote(symbol),
        isMarketOpen: (symbol) => mt5Market.isMarketOpen(symbol),
        liveExchange: () => (integrations.isConfigured('mt5') && !mt5Client.unavailable() ? mt5Exchange() : null),
        // spread is paid through bid/ask fills; no extra fee assumption
        paperExchange: new PaperExchange((symbol) => mt5Market.markPrice(symbol), () => 0, () => 0, () => automation.risk().paperSlippageBps, (symbol) => mt5Market.quote(symbol)),
        liveAccount: async () => {
          const a = await mt5Conn.account()
          return { equity: a.equity, available: a.margin_free }
        },
        liveChecks: mt5LiveChecks,
        region: () => {
          const acct = mt5AccountInfo()
          return { id: 'mt5', label: `MetaTrader 5 · ${acct?.server ?? (integrations.config('mt5').server || 'not set up')}`, testnet: acct ? acct.tradeMode !== 'real' : false }
        },
        watchSymbols: (symbols) => void mt5Market.watch('automation', symbols),
        accountIdentity: async () => {
          const a = await mt5Conn.account()
          return { login: String(a.login), mode: tradeModeOf(a) }
        },
        // manual Gold Bot trades count toward the open-position and exposure limits
        extraOpen: async () => {
          const manual = (await mt5Conn.read((c) => c.positions({ magic: MT5_MANUAL_MAGIC }))).filter((p) => p.magic === MT5_MANUAL_MAGIC)
          let exposure = 0
          for (const p of manual) {
            const inst = await mt5Market.instrument(p.symbol)
            exposure += p.volume * (inst.valuePerPoint ?? 0) * p.price_current
          }
          return { count: manual.length, exposure }
        }
      }
    },
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
  const gold = new GoldService({
    db,
    conn: mt5Conn,
    market: mt5Market,
    automation,
    strategies,
    engine: (method, params) => engine.request(method, params, 30_000),
    manualExchange: mt5ManualExchange,
    botMagic: MT5_MAGIC,
    manualMagic: MT5_MANUAL_MAGIC,
    configured: () => integrations.isConfigured('mt5'),
    onSymbolDetected: (symbol) => {
      // charts default to the broker's own gold symbol when the saved one is not listed
      const p = prefs()
      if (p.defaultSymbolMt5 !== symbol && mt5Market.isSupported(p.defaultSymbolMt5) === false) {
        setSetting(db, 'preferences', { ...getSetting<Partial<GeneralPreferences>>(db, 'preferences', {}), defaultSymbolMt5: symbol })
      }
    },
    onChange: () => automation.notifyChange(),
    log
  })

  const tradingOverview = async () => {
    const broker = activeBroker()
    const o = await automation.overview(currentMarks(), broker)
    if (broker === 'mt5') o.live.account = mt5AccountInfo()
    return o
  }
  void deltaMarket.instruments().then((l) => (instrumentsCache = l)).catch(() => undefined)
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
    if (o.broker !== undefined) next.broker = v.oneOf(o.broker, ['delta', 'mt5'] as const)
    if (o.defaultSymbolMt5 !== undefined) {
      const s = v.str(o.defaultSymbolMt5, 32).trim()
      if (!/^[A-Za-z0-9._#+!-]{1,32}$/.test(s)) throw new UserError('validation_failed', 'Invalid symbol.', { defaultSymbolMt5: 'Invalid symbol' })
      next.defaultSymbolMt5 = s
    }
    if (o.defaultSymbol !== undefined) {
      const s = v.str(o.defaultSymbol, 32).trim().toUpperCase()
      if (!/^[A-Z0-9_]{2,32}$/.test(s)) throw new UserError('validation_failed', 'Invalid symbol.', { defaultSymbol: 'Invalid symbol' })
      next.defaultSymbol = s
    }
    const pythonChanged = next.pythonPath !== prefs().pythonPath
    const brokerChanged = next.broker !== prefs().broker
    setSetting(db, 'preferences', next)
    if (pythonChanged) void engine.restart()
    if (brokerChanged) {
      audit(db, 'broker.selected', { broker: next.broker })
      market.refresh()
      emit('market:changed', market.snapshot())
      void tradingOverview().then((ov) => emit('trading:changed', ov)).catch(() => undefined)
    }
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
    if (id === 'delta' || id === 'marketdata') deltaMarket.applySettings()
    if (id === 'delta') account.invalidate()
    if (id === 'mt5') resetMt5()
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
    if (id === 'delta' || id === 'marketdata') deltaMarket.applySettings()
    if (id === 'delta') account.invalidate()
    if (id === 'mt5') resetMt5()
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
    return runBacktest(v.str(o.id, 64), o)
  })
  const runBacktest = async (id: string, o: Record<string, unknown>) => {
    const s = await strategies.get(id)
    if (!s.validation.valid) throw new UserError('strategy_invalid', `Fix the strategy before backtesting: ${s.validation.errors[0]!.message}`)
    const tf = s.timeframe!
    const days = Math.round(v.num(o.days, 1, MAX_DAYS[tf]))
    const slippageBps = o.slippageBps === undefined ? 0 : v.num(o.slippageBps, 0, 500)
    const feeBps = o.feeBps === undefined ? s.definition.risk.feeBps : v.num(o.feeBps, 0, 100)
    const initialEquity = o.initialEquity === undefined ? 10_000 : v.num(o.initialEquity, 100, 1e9)
    const venue = venueOf(s.definition)
    const candles = await market.for(venue).candles(s.symbol, tf, days)
    if (candles.length < 30) throw new UserError('insufficient_data', `Only ${candles.length} candles are available for ${s.symbol} ${tf}; at least 30 are needed.`)
    // MT5: profit per price move in the account currency, lots, pips and the spread in the candles
    let venueParams = {}
    if (venue === 'mt5') {
      const inst = await mt5Market.instrument(s.symbol)
      const spec = sizingSpecOf(inst)
      if (!spec || !inst.contractSize) throw new UserError('unsupported_symbol', `${s.symbol} has no contract size or tick value at your broker, so it cannot be backtested.`)
      const commissionPerLot = o.commissionPerLot === undefined ? 0 : v.num(o.commissionPerLot, 0, 10_000)
      // the broker's lot step, minimum and maximum apply as for live orders
      venueParams = { pointValue: spec.valuePerPoint / inst.contractSize, unitsPerLot: inst.contractSize, pipSize: inst.pipSize ?? undefined, volumeStep: spec.volumeStep, volumeMin: spec.volumeMin, volumeMax: spec.volumeMax ?? undefined, commissionPerLot }
    }
    const result = await engine.request<{ metrics: BacktestMetrics; trades: BacktestTrade[]; equityCurve: [number, number][] }>('backtest_rules', { definition: s.definition, candles, feeBps, slippageBps, initialEquity, extraMetrics: true, ...venueParams })
    const runId = strategies.recordBacktest(s.id, s.symbol, tf, candles[0]!.time, candles.at(-1)!.time, result.metrics, s.version)
    audit(db, 'strategy.backtested', { id: s.id, version: s.version, runId, bars: candles.length, feeBps, slippageBps })
    return { runId, strategyId: s.id, symbol: s.symbol, timeframe: tf, candles, ...result }
  }

  ipc.handle('engine:status', () => engine.getStatus())
  ipc.handle('engine:restart', () => engine.restart())

  ipc.handle('market:tickers', (req) => {
    const symbols = req ? (v.obj(req).symbols as unknown) : undefined
    return market.tickers(Array.isArray(symbols) ? symbols.slice(0, 50).map((s) => v.str(s, 32)) : undefined)
  })
  ipc.handle('market:symbols', async () => (await market.instruments()).map((i) => i.symbol))
  ipc.handle('market:instruments', (req) => {
    const o = req ? v.obj(req) : {}
    const refresh = Boolean(o.refresh)
    // a strategy's own broker (the builder), otherwise the active one
    return o.venue === 'mt5' || o.venue === 'delta' ? market.for(o.venue).instruments(refresh) : market.instruments(refresh)
  })
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
    const broker = o.broker === 'mt5' || o.broker === 'delta' ? o.broker : activeBroker()
    if (broker === 'mt5') {
      // a real-money MT5 account needs one more explicit step: typing its account number;
      // the account the terminal is logged in to now counts, else the last connection test's
      const live = await mt5Conn.account().then((a) => ({ login: a.login, tradeMode: tradeModeOf(a) })).catch(() => null)
      const acct = live ?? mt5AccountInfo()
      if (!acct) throw new UserError('live_checks_failed', 'Run the MetaTrader 5 connection test first so TradePilot knows which account it would trade.')
      if (acct.tradeMode !== 'demo' && v.optStr(o.accountConfirmation, 40)?.trim() !== String(acct.login)) {
        throw new UserError('validation_failed', `This is a ${acct.tradeMode === 'contest' ? 'contest' : 'REAL-MONEY'} account. Type its account number (${acct.login}) to confirm.`, { accountConfirmation: `Type ${acct.login}` })
      }
    }
    automation.setLive(true, broker)
    return tradingOverview()
  })
  ipc.handle('trading:disableLive', async (req) => {
    const o = req ? v.obj(req) : {}
    automation.setLive(false, o.broker === 'mt5' || o.broker === 'delta' ? o.broker : activeBroker())
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
  ipc.handle('mt5:account', (req) => mt5Account.summary(Boolean(req && v.obj(req).refresh)))
  ipc.handle('account:orders', () => account.orders())

  // The AI proposes rules in a conversation; nothing is saved until the client reviews and confirms it in the UI.
  ipc.handle('ai:interpretStrategy', async (req) => {
    subscription.requireAccess('AI strategy interpretation')
    const o = v.obj(req)
    const provider = o.provider === undefined ? chooseAiProvider() : v.oneOf(o.provider, ['openai', 'anthropic'] as const)
    if (!integrations.isConfigured(provider)) throw new UserError('not_configured', `Configure ${provider === 'openai' ? 'OpenAI' : 'Anthropic Claude'} in Settings first.`)
    const base = o.baseStrategyId === undefined ? undefined : (await strategies.get(v.str(o.baseStrategyId, 64))).definition
    // the strategy's own broker when modifying, otherwise the active broker
    const venue: BrokerId = base ? venueOf(base) : o.venue === 'mt5' || o.venue === 'delta' ? o.venue : activeBroker()
    const raw = Array.isArray(o.messages) ? o.messages.slice(-20) : []
    const messages: ChatMessage[] = raw.map((m) => {
      const mo = v.obj(m)
      return { role: v.oneOf(mo.role, ['user', 'assistant'] as const), content: v.str(mo.content, 20_000) }
    })
    const key = integrations.secret(provider, 'apiKey')!
    const client = provider === 'openai' ? new OpenAiProvider(key) : new AnthropicProvider(key)
    const settings = aiSettings(integrations.config(provider), provider === 'openai' ? DEFAULT_OPENAI_MODEL : DEFAULT_ANTHROPIC_MODEL)
    const symbols = await market.for(venue).instruments().then((l) => l.map((i) => i.symbol)).catch(() => [])
    const turn = await interpretTurn(messages, client, usage, settings, symbols, base, venue)
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

  // ---------- XAUUSD Gold Bot ----------
  const goldSettingsArg = (x: unknown): GoldSettings => {
    const o = v.obj(x)
    const n = (k: string) => v.num(o[k], -1e12, 1e12)
    const session = o.session === null ? null : v.obj(o.session)
    return {
      symbol: o.symbol === null || o.symbol === undefined || o.symbol === '' ? null : v.str(o.symbol, 32),
      accountMode: v.oneOf(o.accountMode, ['demo', 'live'] as const),
      timeframe: v.oneOf(o.timeframe, ['1m', '5m'] as const),
      trendTimeframe: v.oneOf(o.trendTimeframe, ['15m', '30m', '1h'] as const),
      direction: v.oneOf(o.direction, ['long', 'short', 'both'] as const),
      entryStyle: v.oneOf(o.entryStyle, ['pullback', 'breakout', 'momentum'] as const),
      useTrendFilter: Boolean(o.useTrendFilter),
      useRsi: Boolean(o.useRsi),
      useMacd: Boolean(o.useMacd),
      useVwap: Boolean(o.useVwap),
      useCandleConfirmation: Boolean(o.useCandleConfirmation),
      lotMode: v.oneOf(o.lotMode, ['risk', 'fixed'] as const),
      riskPercent: n('riskPercent'),
      fixedLots: n('fixedLots'),
      stopAtr: n('stopAtr'),
      takeProfitR: n('takeProfitR'),
      minRiskReward: n('minRiskReward'),
      maxDailyLossPct: n('maxDailyLossPct'),
      maxTradesPerDay: n('maxTradesPerDay'),
      maxConsecutiveLosses: n('maxConsecutiveLosses'),
      cooldownMinutes: n('cooldownMinutes'),
      maxTradeMinutes: n('maxTradeMinutes'),
      maxSpread: n('maxSpread'),
      maxExtensionAtr: n('maxExtensionAtr'),
      abnormalRangeAtr: n('abnormalRangeAtr'),
      session: session ? { start: v.str(session.start, 5), end: v.str(session.end, 5) } : null,
      events: (Array.isArray(o.events) ? o.events.slice(0, 200) : []).map((e) => {
        const eo = v.obj(e)
        return { start: v.str(eo.start, 40), end: v.str(eo.end, 40), label: v.str(eo.label, 80) }
      }),
      commissionPerLot: n('commissionPerLot')
    }
  }
  ipc.handle('gold:status', (req) => gold.status(Boolean(req && v.obj(req).refresh)))
  ipc.handle('gold:detectSymbol', () => gold.status(true))
  ipc.handle('gold:saveSettings', async (req) => {
    subscription.requireAccess('Automated trading')
    const o = v.obj(req)
    await gold.saveSettings(goldSettingsArg(o.settings), o.confirmLive === true)
    return gold.status()
  })
  ipc.handle('gold:start', async () => {
    subscription.requireAccess('Automated trading')
    await gold.startBot()
    return gold.status()
  })
  ipc.handle('gold:stop', async (req) => {
    await gold.stopBot(Boolean(v.obj(req).closePosition))
    return gold.status()
  })
  ipc.handle('gold:order', async (req) => {
    subscription.requireAccess('Live trading')
    const o = v.obj(req)
    const order = await gold.manualOrder(v.oneOf(o.side, ['buy', 'sell'] as const), v.str(o.requestId, 64))
    notifications.add({ category: 'trading', severity: order.state === 'rejected' ? 'warning' : 'info', title: `Manual ${order.side.toUpperCase()} ${order.state}`, body: `${order.volume} lots${order.avgPrice ? ` @ ${order.avgPrice}` : ''}${order.error ? ` — ${order.error}` : ''}`, native: false })
    return { order, status: await gold.status() }
  })
  // closing and protecting positions stays possible without an active subscription
  ipc.handle('gold:closePosition', async (req) => {
    const o = v.obj(req)
    await gold.closePosition(v.str(o.id, 80), o.confirmForeign === true)
    return gold.status()
  })
  ipc.handle('gold:closeAll', async () => {
    const r = await gold.closeAll()
    return { ...r, status: await gold.status() }
  })
  ipc.handle('gold:modifyPosition', async (req) => {
    const o = v.obj(req)
    const level = (x: unknown) => (x === null || x === undefined ? null : v.num(x, 0, 1e9))
    await gold.modifyPosition(v.str(o.id, 80), level(o.stopLoss), level(o.takeProfit))
    return gold.status()
  })
  ipc.handle('gold:candles', (req) => gold.candles(v.oneOf(v.obj(req).timeframe, ['1m', '5m', '15m'] as const)))
  ipc.handle('gold:backtest', async (req) => {
    subscription.requireAccess('Backtesting')
    const o = v.obj(req)
    const synced = await gold.syncStrategy()
    if (!synced.id || synced.problem) throw new UserError('strategy_invalid', synced.problem ?? 'The Gold strategy is not ready.')
    // spread from the candles, the broker's commission per lot, slippage for fast moves and requotes
    return runBacktest(synced.id, { days: o.days, slippageBps: o.slippageBps, commissionPerLot: gold.settings().commissionPerLot })
  })
  ipc.handle('gold:connect', async () => {
    await gold.connect()
    return gold.status(true)
  })
  ipc.handle('gold:disconnect', async () => {
    await gold.disconnect()
    return gold.status()
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
    void mt5Client.shutdown()
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
