import { appendFileSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, dialog, Notification, powerMonitor, safeStorage, session, shell, type IpcMainInvokeEvent } from 'electron'
import { audit, getSetting, openDatabase, setSetting, type Db } from './db.js'
import { EngineBridge } from './engine.js'
import { UserError } from './errors.js'
import { machineFingerprint } from './fingerprint.js'
import { IntegrationService } from './integrations.js'
import { createIpcRegistry, v } from './ipc.js'
import { LocalAuth } from './localAuth.js'
import { MAX_DAYS, MarketData } from './market.js'
import { NotificationCenter } from './notifications.js'
import { PaperBroker } from './paper.js'
import { SecretStore, type SecretCipher } from './secrets.js'
import { StrategyStore } from './strategies.js'
import { SubscriptionService } from './subscription.js'
import { UpdateService } from './updater.js'
import { loadDesktopConfig } from './config.js'
import type { BacktestMetrics, BacktestTrade, EventContract, EventName, GeneralPreferences, IntegrationId, StrategyInput, Timeframe } from '../shared/ipc.js'

// Development/test-only switches; packaged builds ignore them.
const E2E_HIDDEN = !app.isPackaged && process.env.TRADEPILOT_E2E_HIDDEN === '1'
if (!app.isPackaged && process.env.TRADEPILOT_USER_DATA_DIR) app.setPath('userData', process.env.TRADEPILOT_USER_DATA_DIR)

if (!app.requestSingleInstanceLock()) app.quit()

const INTEGRATION_IDS: IntegrationId[] = ['delta', 'openai', 'anthropic', 'smtp', 'whatsapp']
const TIMEFRAMES: Timeframe[] = ['5m', '15m', '1h', '4h', '1d']
const DEFAULT_PREFS: GeneralPreferences = {
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
  const line = `${new Date().toISOString()} ${msg}${extra !== undefined ? ` ${typeof extra === 'string' ? extra : JSON.stringify(extra)}` : ''}\n`
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
  const integrations = new IntegrationService(db, secrets)
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
    }
  })

  const market = new MarketData(() => integrations.config('delta').baseUrl ?? 'https://api.india.delta.exchange')
  const paper = new PaperBroker(db, (s) => market.markPrice(s))
  const strategies = new StrategyStore(db)
  const engineDir = app.isPackaged ? path.join(process.resourcesPath, 'engine') : path.resolve(app.getAppPath(), '../../engine')
  const engine = new EngineBridge(engineDir, () => prefs().pythonPath, (s) => emit('engine:changed', s))

  const updates = new UpdateService(
    (s) => {
      emit('updates:changed', s)
      if (s.phase === 'downloaded') notifications.add({ category: 'update', severity: 'info', title: `Update ${s.availableVersion} ready`, body: 'Restart TradePilot to install it, or it will install automatically when you quit.', native: true })
    },
    // Safe to restart only when the user opted in and the session is locked (nobody is mid-task).
    () => prefs().autoInstallUpdates && !auth.isUnlocked(),
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
    return view
  })
  ipc.handle('integrations:test', async (req) => {
    const id = v.oneOf(v.obj(req).id, INTEGRATION_IDS)
    const view = await integrations.test(id)
    audit(db, 'integration.tested', { id, state: view.state })
    return view
  })
  ipc.handle('integrations:clear', (req) => {
    const id = v.oneOf(v.obj(req).id, INTEGRATION_IDS)
    audit(db, 'integration.cleared', { id })
    return integrations.clear(id)
  })

  // Viewing saved strategies is always allowed; creating, editing and running them is a paid feature.
  ipc.handle('strategies:list', (req) => strategies.list(Boolean(req && v.obj(req).includeArchived)))
  ipc.handle('strategies:save', (req) => {
    subscription.requireAccess('Editing strategies')
    const o = v.obj(req)
    return strategies.save(v.optStr(o.id, 64), v.obj(o.input) as unknown as StrategyInput)
  })
  ipc.handle('strategies:archive', (req) => strategies.setStatus(v.str(v.obj(req).id, 64), 'archived'))
  ipc.handle('strategies:restore', (req) => strategies.setStatus(v.str(v.obj(req).id, 64), 'draft'))
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
    const s = strategies.get(v.str(o.id, 64))
    const days = Math.round(v.num(o.days, 1, MAX_DAYS[s.timeframe]))
    const candles = await market.candles(s.symbol, s.timeframe, days)
    if (candles.length < 30) throw new UserError('insufficient_data', `Only ${candles.length} candles are available for ${s.symbol} ${s.timeframe}; at least 30 are needed.`)
    const result = await engine.request<{ metrics: BacktestMetrics; trades: BacktestTrade[]; equityCurve: [number, number][] }>('backtest', {
      strategy: { type: s.type, params: s.params, risk: s.risk, allowShort: s.allowShort },
      candles
    })
    const runId = strategies.recordBacktest(s.id, s.symbol, s.timeframe, candles[0]!.time, candles.at(-1)!.time, result.metrics)
    audit(db, 'strategy.backtested', { id: s.id, runId, bars: candles.length })
    return { runId, strategyId: s.id, symbol: s.symbol, timeframe: s.timeframe, candles, ...result }
  })

  ipc.handle('engine:status', () => engine.getStatus())
  ipc.handle('engine:restart', () => engine.restart())

  ipc.handle('market:tickers', (req) => {
    const symbols = req ? (v.obj(req).symbols as unknown) : undefined
    return market.tickers(Array.isArray(symbols) ? symbols.slice(0, 50).map((s) => v.str(s, 32)) : undefined)
  })
  ipc.handle('market:symbols', async () => (await market.allTickers()).map((t) => t.symbol))
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

  app.on('before-quit', () => engine.stop())
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
      // hidden test windows still need animation frames for UI automation
      backgroundThrottling: !E2E_HIDDEN
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
