import nodemailer, { type Transporter } from 'nodemailer'
import type { SmtpConfig } from '../config.js'

export interface MailMessage {
  to: string
  subject: string
  text: string
}

export interface Mailer {
  /** False when SMTP is not configured; callers must record that nothing was sent. */
  readonly configured: boolean
  readonly description: string
  send(message: MailMessage): Promise<{ messageId: string }>
}

export class SmtpMailer implements Mailer {
  readonly configured = true
  private readonly transport: Transporter

  constructor(private readonly cfg: SmtpConfig) {
    this.transport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      requireTLS: !cfg.secure && cfg.requireTLS,
      auth: cfg.user ? { user: cfg.user, pass: cfg.password ?? '' } : undefined,
      tls: { minVersion: 'TLSv1.2' },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000
    })
  }

  get description(): string {
    const mode = this.cfg.secure ? 'implicit TLS' : this.cfg.requireTLS ? 'STARTTLS required' : 'STARTTLS optional'
    return `${this.cfg.host}:${this.cfg.port} (${mode}) as ${this.cfg.from}`
  }

  async send(message: MailMessage): Promise<{ messageId: string }> {
    const info = await this.transport.sendMail({ from: this.cfg.from, to: message.to, subject: message.subject, text: message.text })
    if (info.rejected && info.rejected.length > 0) throw new Error(`Recipient rejected: ${info.rejected.join(', ')}`)
    return { messageId: info.messageId }
  }
}

export class UnconfiguredMailer implements Mailer {
  readonly configured = false
  readonly description = 'SMTP is not configured (set SMTP_HOST, SMTP_FROM and credentials)'
  async send(): Promise<{ messageId: string }> {
    throw new Error('SMTP is not configured')
  }
}

/** Test double that records messages and can be told to fail. */
export class MemoryMailer implements Mailer {
  readonly configured = true
  readonly description = 'in-memory test mailer'
  readonly sent: MailMessage[] = []
  failNext = false
  async send(message: MailMessage): Promise<{ messageId: string }> {
    if (this.failNext) {
      this.failNext = false
      throw new Error('simulated SMTP failure')
    }
    this.sent.push(message)
    return { messageId: `mem-${this.sent.length}` }
  }
}
