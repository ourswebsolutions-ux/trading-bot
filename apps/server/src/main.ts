import { loadConfig } from './config.js'
import { createContext } from './bootstrap.js'
import { buildApp } from './http/app.js'
import { backupNow } from './services/backup.js'

const config = loadConfig()
const ctx = createContext(config)
const app = await buildApp(ctx, { logger: true })

app.log.info({ publicBaseUrl: config.publicBaseUrl, smtp: ctx.notifier.mailer.description }, 'TradePilot server starting')
app.log.info({ businessEmail: config.adminNotifyEmail }, 'payment requests are emailed to the business address for confirmation')
if (!config.reviewPassphraseHash) app.log.warn('REVIEW_PASSPHRASE_HASH is not set: payment requests are refused until you run  npm run review:passphrase -w @tradepilot/server -- --write  and restart')
if (!ctx.notifier.mailer.configured) app.log.info('server SMTP not configured (optional): clients are notified in the app; payment requests are emailed by the client app itself')
app.log.info(`Entitlement public key (pin in the desktop build as MAIN_VITE_ENTITLEMENT_PUBLIC_KEY): ${ctx.keys.publicKeyBase64}`)

const timers: NodeJS.Timeout[] = []
if (config.backupIntervalHours > 0) {
  const runBackup = () => {
    try {
      const target = backupNow(ctx.db, { backupDir: config.backupDir, uploadDir: config.uploadDir, retention: config.backupRetention })
      app.log.info({ target }, 'database backup written')
    } catch (err) {
      app.log.error({ err }, 'database backup failed')
    }
  }
  timers.push(setInterval(runBackup, config.backupIntervalHours * 3600_000))
}

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down')
  timers.forEach(clearInterval)
  await app.close()
  await ctx.notifier.idle()
  ctx.db.close()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

await app.listen({ host: config.host, port: config.port })
