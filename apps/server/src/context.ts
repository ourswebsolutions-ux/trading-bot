import type { Clock } from './clock.js'
import type { ServerConfig } from './config.js'
import type { Db } from './db/sqlite.js'
import type { SigningKeys } from './security/keys.js'
import type { EvidenceStore } from './services/evidence.js'
import type { Notifier } from './services/notifier.js'

/** Everything a service needs, passed explicitly so tests can swap any piece. */
export interface AppContext {
  config: ServerConfig
  db: Db
  clock: Clock
  keys: SigningKeys
  evidence: EvidenceStore
  notifier: Notifier
}
