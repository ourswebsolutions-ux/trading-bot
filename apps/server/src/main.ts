import { loadConfig } from './config.js'
import { createContext } from './bootstrap.js'
import { buildApp } from './http/app.js'
import { backupNow } from './services/backup.js'

const config = loadConfig()
const ctx = createContext(config)
const app = await buildApp(ctx, { logger: true })

app.log.info({ publicBaseUrl: config.publicBaseUrl, smtp: ctx.notifier.mailer.description }, 'TradePilot server starting')
if (!config.adminNotifyEmail) app.log.warn('ADMIN_NOTIFY_EMAIL is not set: payment requests cannot be emailed for approval')
if (!config.paymentInstructions) app.log.warn('PAYMENT_INSTRUCTIONS(_FILE) is not set: clients cannot submit payments yet')
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
