import type { Config } from '../config.js'
import type { Logger } from '../lib/logger.js'
import type { ApiKeyStore } from '../services/api-key-store.js'
import type { AuditLog } from '../services/audit-log.js'
import type { ConsoleAuthStore } from '../services/console-auth.js'
import type { DirectSender } from '../services/direct-send.js'
import type { MediaStore } from '../services/media-store.js'
import type { Outbox } from '../services/outbox.js'
import type { SessionManager } from '../services/session-manager.js'
import type { SettingsStore } from '../services/settings-store.js'

export interface ConsoleDependencies {
  config: Config
  logger: Logger
  settings: SettingsStore
  sessions: SessionManager
  outbox: Outbox
  mediaStore: MediaStore
  directSender: DirectSender
  apiKeys: ApiKeyStore
  auth: ConsoleAuthStore
  audit: AuditLog
}
