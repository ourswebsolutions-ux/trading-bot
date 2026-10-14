import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import electronUpdater, { type AppUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater'
import type { UpdateState } from '../shared/ipc.js'

const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000]
const PERIODIC_CHECK_MS = 4 * 60 * 60_000

/**
 * Wraps electron-updater. Only reports what actually happened: if the build has no
 * update feed (dev builds, packages built without TRADEPILOT_UPDATE_URL, unsupported
 * Linux package formats) the state is "disabled" with the reason, never a fake success.
 *
 * Integrity: electron-updater verifies the SHA-512 of every download against the
 * release metadata, the Windows installer's Authenticode publisher (when the app is
 * signed), and macOS code signatures via Squirrel.Mac.
 */
export class UpdateService {
  private state: UpdateState
  private updater: AppUpdater | null = null
  private retryIndex = 0
  private retryTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly onChange: (s: UpdateState) => void,
    private readonly canAutoInstall: () => boolean,
    private readonly log: (msg: string, extra?: unknown) => void
  ) {
    this.state = { phase: 'disabled', currentVersion: app.getVersion(), availableVersion: null, progress: null, message: null, lastCheckedAt: null, nextRetryAt: null, feedUrl: null }
  }

  getState(): UpdateState {
    return this.state
  }

  private set(patch: Partial<UpdateState>) {
    this.state = { ...this.state, ...patch }
    this.onChange(this.state)
  }

  private disabledReason(): { reason: string | null; feedUrl: string | null } {
    if (!app.isPackaged) return { reason: 'Development build: automatic updates run only in packaged releases.', feedUrl: null }
    const configFile = path.join(process.resourcesPath, 'app-update.yml')
    if (!existsSync(configFile)) return { reason: 'This build was packaged without an update feed (TRADEPILOT_UPDATE_URL was not set).', feedUrl: null }
    if (process.platform === 'linux' && !process.env.APPIMAGE && !existsSync('/usr/bin/dpkg') && !existsSync('/usr/bin/rpm')) {
      return { reason: 'Automatic updates on Linux require the AppImage, .deb or .rpm package.', feedUrl: null }
    }
    const feedUrl = /url:\s*(\S+)/.exec(readFileSync(configFile, 'utf8'))?.[1] ?? null
    return { reason: null, feedUrl }
  }

  start(): void {
    const { reason, feedUrl } = this.disabledReason()
    if (reason) {
      this.set({ phase: 'disabled', message: reason, feedUrl })
      return
    }
    const updater = electronUpdater.autoUpdater
    this.updater = updater
    updater.autoDownload = true
    updater.autoInstallOnAppQuit = true // a downloaded update is applied on next quit/launch at the latest
    updater.allowDowngrade = false
    updater.allowPrerelease = false
    updater.logger = { info: (m: unknown) => this.log(String(m)), warn: (m: unknown) => this.log(String(m)), error: (m: unknown) => this.log(String(m)), debug: () => {} }

    updater.on('checking-for-update', () => this.set({ phase: 'checking', message: null }))
    updater.on('update-available', (info: UpdateInfo) => this.set({ phase: 'available', availableVersion: info.version, message: `Version ${info.version} is available; downloading in the background.` }))
    updater.on('update-not-available', () => {
      this.retryIndex = 0
      this.set({ phase: 'up_to_date', availableVersion: null, progress: null, message: null, lastCheckedAt: new Date().toISOString(), nextRetryAt: null })
    })
    updater.on('download-progress', (p: ProgressInfo) =>
      this.set({ phase: 'downloading', progress: { percent: p.percent, transferred: p.transferred, total: p.total, bytesPerSecond: p.bytesPerSecond }, message: null })
    )
    updater.on('update-downloaded', (info: UpdateInfo) => {
      this.retryIndex = 0
      this.set({
        phase: 'downloaded',
        availableVersion: info.version,
        progress: null,
        lastCheckedAt: new Date().toISOString(),
        message: `Version ${info.version} is ready. It installs when you restart, or automatically the next time TradePilot quits.`
      })
      this.maybeAutoInstall()
    })
    updater.on('error', (err: Error) => this.handleError(err))

    this.set({ phase: 'idle', feedUrl, message: null })
    void this.check()
    setInterval(() => void this.check(), PERIODIC_CHECK_MS).unref()
  }

  private handleError(err: Error) {
    const delay = RETRY_DELAYS_MS[Math.min(this.retryIndex, RETRY_DELAYS_MS.length - 1)]!
    this.retryIndex++
    const nextRetryAt = new Date(Date.now() + delay).toISOString()
    this.log('update error', err.message)
    this.set({ phase: 'error', progress: null, lastCheckedAt: new Date().toISOString(), nextRetryAt, message: `Update failed: ${err.message.split('\n')[0]}. Retrying automatically.` })
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => void this.check(), delay)
    this.retryTimer.unref()
  }

  async check(): Promise<UpdateState> {
    if (!this.updater) return this.state
    if (this.state.phase === 'downloading' || this.state.phase === 'installing') return this.state
    if (this.state.phase === 'downloaded') return this.state
    try {
      await this.updater.checkForUpdates()
    } catch (err) {
      this.handleError(err instanceof Error ? err : new Error(String(err)))
    }
    return this.state
  }

  /** Installs now if an update is downloaded (restarts the app). */
  install(): UpdateState {
    if (!this.updater || this.state.phase !== 'downloaded') return this.state
    this.set({ phase: 'installing', message: 'Restarting to install the update…' })
    setImmediate(() => this.updater!.quitAndInstall(false, true))
    return this.state
  }

  /** Called on lock/idle: installs a downloaded update automatically when the user opted in and nothing is running. */
  maybeAutoInstall(): void {
    if (this.state.phase === 'downloaded' && this.canAutoInstall()) this.install()
  }
}
