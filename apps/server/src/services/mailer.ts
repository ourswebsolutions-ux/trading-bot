import { createSmtpTransport, sendSmtp, type SmtpAttachment, type SmtpSettings } from '@tradepilot/shared/smtp'
import type { Transporter } from 'nodemailer'
import type { SmtpConfig } from '../config.js'

export interface MailMessage {
  to: string
  subject: string
  text: string
  attachments?: SmtpAttachment[]
}

export interface Mailer {
  /** False when SMTP is not configured; callers must record that nothing was sent. */
  readonly configured: boolean
  readonly description: string
  send(message: MailMessage): Promise<{ messageId: string }>
}

/** Uses the same SMTP module as the desktop app (packages/shared/src/smtp.ts). */
export class SmtpMailer implements Mailer {
  readonly configured = true
  private readonly settings: SmtpSettings
  private readonly transport: Transporter

  constructor(private readonly cfg: SmtpConfig) {
    this.settings = { host: cfg.host, port: cfg.port, secure: cfg.secure, requireTLS: cfg.requireTLS, user: cfg.user, password: cfg.password, from: cfg.from }
    this.transport = createSmtpTransport(this.settings)
  }

  get description(): string {
    const mode = this.cfg.secure ? 'implicit TLS' : this.cfg.requireTLS ? 'STARTTLS required' : 'STARTTLS optional'
    return `${this.cfg.host}:${this.cfg.port} (${mode}) as ${this.cfg.from}`
  }

  async send(message: MailMessage): Promise<{ messageId: string }> {
    const result = await sendSmtp(this.settings, message, this.transport)
    if (result.rejected.length > 0) throw new Error(`Recipient rejected: ${result.rejected.join(', ')}`)
    return { messageId: result.messageId }
  }
}

export class UnconfiguredMailer implements Mailer {
  readonly configured = false
  readonly description = 'SMTP is not configured (set SMTP_HOST, SMTP_FROM, SMTP_USER and SMTP_PASSWORD_FILE)'
  async send(): Promise<{ messageId: string }> {
    throw new Error('SMTP is not configured')
  }
}

/** Test double that records messages and can be told to fail. */
export class MemoryMailer implements Mailer {
  readonly description = 'in-memory test mailer'
  readonly sent: MailMessage[] = []
  failNext = false
  constructor(readonly configured = true) {}
  async send(message: MailMessage): Promise<{ messageId: string }> {
    if (this.failNext) {
      this.failNext = false
      throw new Error('simulated SMTP failure')
    }
    this.sent.push(message)
    return { messageId: `mem-${this.sent.length}` }
  }
}
