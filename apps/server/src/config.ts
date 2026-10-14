import { readFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1')

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  PUBLIC_BASE_URL: z.string().url().default('http://127.0.0.1:8787'),
  DATA_DIR: z.string().default('./data'),
  TRUST_PROXY: bool.default(false),
  COOKIE_SECURE: bool.optional(),
  ENTITLEMENT_PRIVATE_KEY_FILE: z.string().optional(),
  ENTITLEMENT_TOKEN_TTL_HOURS: z.coerce.number().min(1).max(168).default(12),
  ADMIN_NOTIFY_EMAIL: z.string().email().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  /** true = implicit TLS (port 465). false = STARTTLS upgrade, which SMTP_REQUIRE_TLS enforces. */
  SMTP_SECURE: bool.default(false),
  SMTP_REQUIRE_TLS: bool.default(true),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_PASSWORD_FILE: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  BACKUP_INTERVAL_HOURS: z.coerce.number().min(0).default(24),
  BACKUP_RETENTION: z.coerce.number().int().min(1).default(14)
})

export interface SmtpConfig {
  host: string
  port: number
  secure: boolean
  requireTLS: boolean
  user?: string
  password?: string
  from: string
}

export interface ServerConfig {
  env: 'development' | 'production' | 'test'
  host: string
  port: number
  publicBaseUrl: string
  dataDir: string
  dbPath: string
  uploadDir: string
  backupDir: string
  trustProxy: boolean
  cookieSecure: boolean
  entitlementPrivateKeyFile?: string
  entitlementTtlMs: number
  initialAdminNotifyEmail?: string
  smtp: SmtpConfig | null
  backupIntervalHours: number
  backupRetention: number
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = EnvSchema.safeParse(env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`Invalid server configuration: ${issues}`)
  }
  const e = parsed.data
  const dataDir = path.resolve(e.DATA_DIR)
  const publicBaseUrl = e.PUBLIC_BASE_URL.replace(/\/+$/, '')

  if (e.NODE_ENV === 'production') {
    if (!publicBaseUrl.startsWith('https://')) throw new Error('PUBLIC_BASE_URL must use https:// in production')
    if (!e.ENTITLEMENT_PRIVATE_KEY_FILE) throw new Error('ENTITLEMENT_PRIVATE_KEY_FILE is required in production')
  }

  let smtp: SmtpConfig | null = null
  if (e.SMTP_HOST) {
    const password = e.SMTP_PASSWORD_FILE ? readFileSync(e.SMTP_PASSWORD_FILE, 'utf8').trim() : e.SMTP_PASSWORD
    if (!e.SMTP_FROM) throw new Error('SMTP_FROM is required when SMTP_HOST is set')
    smtp = {
      host: e.SMTP_HOST,
      port: e.SMTP_PORT,
      secure: e.SMTP_SECURE,
      requireTLS: e.SMTP_REQUIRE_TLS,
      user: e.SMTP_USER,
      password,
      from: e.SMTP_FROM
    }
  }

  return {
    env: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    publicBaseUrl,
    dataDir,
    dbPath: path.join(dataDir, 'tradepilot.sqlite'),
    uploadDir: path.join(dataDir, 'evidence'),
    backupDir: path.join(dataDir, 'backups'),
    trustProxy: e.TRUST_PROXY,
    cookieSecure: e.COOKIE_SECURE ?? publicBaseUrl.startsWith('https://'),
    entitlementPrivateKeyFile: e.ENTITLEMENT_PRIVATE_KEY_FILE,
    entitlementTtlMs: e.ENTITLEMENT_TOKEN_TTL_HOURS * 3600_000,
    initialAdminNotifyEmail: e.ADMIN_NOTIFY_EMAIL,
    smtp,
    backupIntervalHours: e.BACKUP_INTERVAL_HOURS,
    backupRetention: e.BACKUP_RETENTION
  }
}
