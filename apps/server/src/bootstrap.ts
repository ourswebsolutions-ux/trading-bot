import { systemClock, type Clock } from './clock.js'
import type { ServerConfig } from './config.js'
import type { AppContext } from './context.js'
import { migrate, openDatabase } from './db/sqlite.js'
import { loadSigningKeys, type SigningKeys } from './security/keys.js'
import { EvidenceStore } from './services/evidence.js'
import { SmtpMailer, UnconfiguredMailer, type Mailer } from './services/mailer.js'
import { Notifier } from './services/notifier.js'
import { seedSettings } from './services/settings.js'

export function createContext(
  config: ServerConfig,
  overrides: { clock?: Clock; mailer?: Mailer; keys?: SigningKeys; log?: { error: (o: object, m: string) => void } } = {}
): AppContext {
  const db = openDatabase(config.dbPath)
  migrate(db)
  const clock = overrides.clock ?? systemClock
  seedSettings(db, clock.now(), config.initialAdminNotifyEmail)
  const mailer = overrides.mailer ?? (config.smtp ? new SmtpMailer(config.smtp) : new UnconfiguredMailer())
  return {
    config,
    db,
    clock,
    keys: overrides.keys ?? loadSigningKeys(config),
    evidence: new EvidenceStore(config.uploadDir),
    notifier: new Notifier(db, clock, mailer, overrides.log)
  }
}
