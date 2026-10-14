import nodemailer, { type Transporter } from 'nodemailer'

/**
 * SMTP transport shared by the subscription server (admin/customer notifications)
 * and the desktop app (user alert email). Node-only; never import from renderer code.
 */
export interface SmtpSettings {
  host: string
  port: number
  /** true = implicit TLS (465); false = plain connection upgraded with STARTTLS */
  secure: boolean
  /** with secure=false: refuse to continue if the server does not offer STARTTLS */
  requireTLS: boolean
  user?: string
  password?: string
  from: string
  timeoutMs?: number
}

export interface SmtpMessage {
  to: string
  subject: string
  text: string
}

/** What the SMTP server actually answered. "Accepted" means queued by the server, not delivered to the inbox. */
export interface SmtpDeliveryResult {
  messageId: string
  accepted: string[]
  rejected: string[]
  response: string
}

export class SmtpError extends Error {
  constructor(
    readonly kind: 'connection' | 'tls' | 'auth' | 'rejected' | 'timeout' | 'unknown',
    message: string,
    readonly responseCode?: number
  ) {
    super(message)
  }
}

export function createSmtpTransport(s: SmtpSettings): Transporter {
  const timeout = s.timeoutMs ?? 15_000
  return nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.secure,
    requireTLS: !s.secure && s.requireTLS,
    auth: s.user ? { user: s.user, pass: s.password ?? '' } : undefined,
    tls: { minVersion: 'TLSv1.2' },
    connectionTimeout: timeout,
    greetingTimeout: timeout,
    socketTimeout: timeout * 2
  })
}

/** Turns nodemailer errors into actionable messages without echoing credentials. */
export function classifySmtpError(err: unknown): SmtpError {
  if (err instanceof SmtpError) return err
  const e = err as { code?: string; responseCode?: number; message?: string; command?: string }
  const msg = e.message ?? String(err)
  if (e.code === 'EAUTH' || e.responseCode === 535 || e.responseCode === 534) {
    return new SmtpError('auth', `Authentication failed (${e.responseCode ?? e.code}). Check the username and password; many providers require an app password.`, e.responseCode)
  }
  if (e.code === 'ETIMEDOUT' || /timeout/i.test(msg)) return new SmtpError('timeout', 'The SMTP server did not respond in time. Check host, port and firewall.')
  if (e.code === 'ESOCKET' && /wrong version number|ssl3_get_record|EPROTO/i.test(msg)) {
    return new SmtpError('tls', 'TLS handshake failed. Port 465 needs "Implicit TLS"; port 587 needs "STARTTLS".')
  }
  if (/STARTTLS/i.test(msg)) return new SmtpError('tls', 'The server does not offer STARTTLS, and TLS is required. Use implicit TLS (port 465) or a server that supports STARTTLS.')
  if (e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND' || e.code === 'EDNS' || e.code === 'ECONNECTION' || e.code === 'ESOCKET') {
    return new SmtpError('connection', `Could not connect to the SMTP server (${e.code}). Check the host name and port.`)
  }
  if (e.code === 'EENVELOPE' || (e.responseCode && e.responseCode >= 500)) {
    return new SmtpError('rejected', `The server rejected the message: ${msg.split('\n')[0]}`, e.responseCode)
  }
  return new SmtpError('unknown', msg.split('\n')[0] ?? 'SMTP error')
}

/** Connects and authenticates without sending anything. */
export async function verifySmtp(s: SmtpSettings): Promise<void> {
  const t = createSmtpTransport(s)
  try {
    await t.verify()
  } catch (err) {
    throw classifySmtpError(err)
  } finally {
    t.close()
  }
}

export async function sendSmtp(s: SmtpSettings, m: SmtpMessage, transport?: Transporter): Promise<SmtpDeliveryResult> {
  const t = transport ?? createSmtpTransport(s)
  try {
    const info = await t.sendMail({ from: s.from, to: m.to, subject: m.subject, text: m.text })
    const result: SmtpDeliveryResult = {
      messageId: info.messageId,
      accepted: (info.accepted ?? []).map(String),
      rejected: (info.rejected ?? []).map(String),
      response: String(info.response ?? '')
    }
    if (result.accepted.length === 0) throw new SmtpError('rejected', `No recipients were accepted: ${result.rejected.join(', ') || result.response}`)
    return result
  } catch (err) {
    throw classifySmtpError(err)
  } finally {
    if (!transport) t.close()
  }
}
