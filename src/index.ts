import { loadConfig, loadEnvFiles } from './config.js'
import { openDatabase } from './db/database.js'
import { SqliteWhatsAppAuthStore } from './db/whatsapp-auth-store.js'
import { createApp } from './http/app.js'
import { createLogger } from './lib/logger.js'
import { startServer } from './server.js'
import { ApiKeyStore } from './services/api-key-store.js'
import { AuditLog } from './services/audit-log.js'
import { ConsoleAuthStore } from './services/console-auth.js'
import { DirectSender } from './services/direct-send.js'
import { createInboundForwarder } from './services/inbound-forwarder.js'
import { MediaStore } from './services/media-store.js'
import { Outbox } from './services/outbox.js'
import { SessionManager } from './services/session-manager.js'
import { SettingsStore, settingsFromConfig } from './services/settings-store.js'
import { createStatusReporter } from './services/status-reporter.js'

async function main(): Promise<void> {
  loadEnvFiles()
  const config = loadConfig()
  const logger = createLogger(config.logLevel)
  const instanceId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

  const db = openDatabase(config.databasePath)
  const settings = new SettingsStore(db, settingsFromConfig(config), logger)
  const runtime = settings.get()

  const apiKeys = new ApiKeyStore(db)
  const consoleAuth = new ConsoleAuthStore(db, config.console.sessionTtlMs)
  const audit = new AuditLog(db)
  const authStore = new SqliteWhatsAppAuthStore(db)

  if (config.console.email && config.console.password) {
    try {
      const seeded = consoleAuth.seedAdmin(config.console.email, config.console.password)
      if (seeded) {
        logger.info({ email: seeded.email }, 'created the bootstrap console admin')
        audit.record('system', 'console.admin.seeded', seeded.email)
      }
    } catch (error) {
      logger.error({ err: error }, 'could not seed the bootstrap console admin')
    }
  } else if (config.console.email || config.console.password) {
    logger.warn(
      'WHATSAPP_CONSOLE_EMAIL and WHATSAPP_CONSOLE_PASSWORD must both be set to seed the console admin',
    )
  }

  const mediaStore = new MediaStore(config.mediaDir, db, runtime)

  const inboundForwarder = createInboundForwarder({
    settings: runtime,
    apiKey: config.apiKey,
    mediaStore,
    logger,
  })

  const statusReporter = createStatusReporter({
    settings: runtime,
    apiKey: config.apiKey,
    logger,
  })

  const sessions = new SessionManager({
    authStore,
    settings: runtime,
    logger,
    forwardInbound: (sessionId, message) => {
      void inboundForwarder(sessionId, message)
    },
  })

  const outbox = new Outbox(
    {
      db,
      settings: runtime,
      logger,
      onSettled: statusReporter,
    },
    sessions,
  )

  const directSender = new DirectSender({ sessions, outbox, logger })
  const app = createApp({
    config,
    logger,
    instanceId,
    settings,
    sessions,
    outbox,
    mediaStore,
    directSender,
    apiKeys,
    auth: consoleAuth,
    audit,
  })

  outbox.start()

  const pruneMedia = async (): Promise<void> => {
    try {
      const removed = await mediaStore.prune()
      if (removed > 0) logger.info({ removed }, 'pruned stale inbound media')
    } catch (error) {
      logger.warn({ err: error }, 'inbound media prune failed')
    }
  }
  void pruneMedia()
  const mediaPruneTimer = setInterval(() => void pruneMedia(), 60 * 60_000)
  mediaPruneTimer.unref()
  const auditPruneTimer = setInterval(() => audit.prune(), 24 * 60 * 60_000)
  auditPruneTimer.unref()

  const server = await startServer({
    fetch: app.fetch,
    port: config.port,
    hostname: config.host,
  })

  audit.record('system', 'gateway.started', instanceId)

  logger.info({ port: server.port, host: config.host, instanceId }, 'gateway listening')
  logger.info(
    {
      database: config.databasePath,
      media: config.mediaDir,
      auth: config.apiKey ? 'enabled' : 'DISABLED (set WHATSAPP_API_KEY)',
      console: config.console.enabled ? 'enabled at /console' : 'disabled',
      inboundForwarding: runtime.inbound.urlTemplate ? 'enabled' : 'disabled',
      statusReporting: runtime.inbound.statusUrlTemplate ? 'enabled' : 'disabled',
    },
    'configuration',
  )
  logger.info(
    'sessions are in-memory: run a SINGLE replica with a persistent database volume, and back it up',
  )

  if (config.console.enabled && consoleAuth.countAdmins() === 0) {
    logger.warn(
      'no console admin exists yet: open /console/setup to create one, or set WHATSAPP_CONSOLE_EMAIL and WHATSAPP_CONSOLE_PASSWORD',
    )
  }

  if (runtime.session.restoreOnBoot) {
    void sessions
      .restoreSessions({ delayMs: runtime.session.restoreDelayMs })
      .then(({ restored, skipped }) => {
        logger.info(
          { restored, skipped },
          `session restore complete: ${restored.length} reconnected, ${skipped.length} skipped`,
        )
      })
      .catch((error: unknown) => {
        logger.error({ err: error }, 'session restore failed')
      })
  } else {
    logger.info('session restore disabled')
  }

  let shuttingDown = false
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ signal }, 'shutting down')

    try {
      await outbox.stop()
      clearInterval(mediaPruneTimer)
      clearInterval(auditPruneTimer)
      await server.stop()
      await sessions.shutdown()
    } catch (error) {
      logger.error({ err: error }, 'shutdown failed')
    } finally {
      try {
        db.close()
      } catch {
        // Already closed.
      }
      process.exit(0)
    }
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  // A rejected promise nobody awaited (a failed credential write, say) must be
  // visible in the logs. Node's default is to crash on one, which would drop
  // every other seller's socket for one session's problem.
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled rejection')
  })

  // An uncaught exception leaves the process in an unknown state, so it still
  // exits — the supervisor restarts it — but the log line lands first.
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'uncaught exception')
    process.exit(1)
  })
}

main().catch((error: unknown) => {
  console.error('[wa-gateway] fatal startup error:', error)
  process.exit(1)
})
