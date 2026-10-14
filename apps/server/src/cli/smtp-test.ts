/**
 * Sends a test email with the server's SMTP settings and prints the server's reply.
 *   npm run smtp:test -w @tradepilot/server -- [recipient]   (defaults to ADMIN_NOTIFY_EMAIL)
 */
import { sendSmtp } from '@tradepilot/shared/smtp'
import { loadConfig } from '../config.js'

const config = loadConfig()
const to = process.argv[2] ?? config.adminNotifyEmail
if (!config.smtp) {
  console.error('SMTP is not configured (set SMTP_HOST, SMTP_FROM and credentials).')
  process.exit(1)
}
if (!to) {
  console.error('Give a recipient or set ADMIN_NOTIFY_EMAIL.')
  process.exit(1)
}
try {
  const r = await sendSmtp(config.smtp, { to, subject: 'TradePilot — SMTP test', text: `Test message from the TradePilot subscription server (${config.publicBaseUrl}).` })
  console.log(`Accepted by ${config.smtp.host} for ${r.accepted.join(', ')}. Server reply: ${r.response}`)
} catch (err) {
  console.error(`Not sent: ${err instanceof Error ? err.message : err}`)
  process.exit(1)
}
