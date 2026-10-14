import { sendSmtp } from '@tradepilot/shared/smtp'
import { ConsentStore, WhatsAppClient } from '../channels/whatsapp.js'
import type { IntegrationService } from '../integrations.js'
import { smtpSettings } from '../integrationSpecs.js'
import type { NotificationCenter } from '../notifications.js'
import { redact } from '../redact.js'

export interface TradingAlert {
  level: 'info' | 'warning' | 'error'
  title: string
  body: string
  key: string
}

const THROTTLE_MS = 60_000

/**
 * Delivers trading alerts to the in-app inbox (bell) and, when enabled in Settings, by email
 * (SMTP) and WhatsApp (approved template with one text variable, opted-in recipient only).
 * Delivery problems are logged; they never interrupt trading decisions.
 */
export class AlertDispatcher {
  private last = new Map<string, number>()

  constructor(
    private readonly integrations: IntegrationService,
    private readonly consents: ConsentStore,
    private readonly notifications: NotificationCenter,
    private readonly log: (msg: string) => void,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  send(a: TradingAlert): void {
    const now = Date.now()
    if (now - (this.last.get(a.key) ?? 0) < THROTTLE_MS) return
    this.last.set(a.key, now)
    const title = redact(a.title).slice(0, 120)
    const body = redact(a.body).slice(0, 900)
    this.notifications.add({ category: 'trading', severity: a.level === 'error' ? 'error' : a.level === 'warning' ? 'warning' : 'info', title, body })
    void this.email(title, body).catch((err) => this.log(`trading alert email failed: ${redact(String(err))}`))
    void this.whatsapp(title, body).catch((err) => this.log(`trading alert WhatsApp failed: ${redact(String(err))}`))
  }

  private async email(title: string, body: string) {
    if (!this.integrations.isConfigured('smtp')) return
    const cfg = this.integrations.config('smtp')
    if (cfg.tradingAlerts !== 'true') return
    const to = cfg.alertRecipient || cfg.testRecipient
    if (!to) return
    await sendSmtp(smtpSettings(cfg, this.integrations.secret('smtp', 'password')), { to, subject: `TradePilot — ${title}`, text: `${body}\n\nSent by TradePilot trading alerts (${new Date().toISOString()}).` })
  }

  private async whatsapp(title: string, body: string) {
    if (!this.integrations.isConfigured('whatsapp')) return
    const cfg = this.integrations.config('whatsapp')
    if (cfg.tradingAlerts !== 'true' || !cfg.alertTemplateName || !cfg.alertRecipient) return
    const to = cfg.alertRecipient.replace(/[\s()+-]/g, '')
    if (!this.consents.has(to)) {
      this.log('trading alert WhatsApp skipped: recipient is not on the opt-in list')
      return
    }
    const client = new WhatsAppClient({ phoneNumberId: cfg.phoneNumberId!, businessAccountId: cfg.businessAccountId || undefined, apiVersion: cfg.apiVersion! }, this.integrations.secret('whatsapp', 'accessToken')!, this.fetchImpl)
    await client.sendTemplate(to, cfg.alertTemplateName, cfg.alertTemplateLanguage || 'en_US', [`${title}: ${body}`.replace(/\s+/g, ' ').slice(0, 1000)])
  }
}
