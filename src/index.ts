import { loadConfig, loadEnvFiles } from './config.js'
import { createApp } from './http/app.js'
import { createLogger } from './lib/logger.js'
import { startServer } from './server.js'
import { DirectSender } from './services/direct-send.js'
import { createInboundForwarder } from './services/inbound-forwarder.js'
import { MediaStore } from './services/media-store.js'
import { Outbox } from './services/outbox.js'
import { SessionManager } from './services/session-manager.js'
import { createStatusReporter } from './services/status-reporter.js'

async function main(): Promise<void> {
  loadEnvFiles()
  const config = loadConfig()
  const logger = createLogger(config.logLevel)
  const instanceId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

  const mediaStore = new MediaStore(
    config.mediaDir,
    config.inbound.mediaTtlMs,
    config.inbound.mediaSpoolMaxBytes,
  )

  const inboundForwarder = createInboundForwarder({
    urlTemplate: config.inbound.urlTemplate,
    apiKey: config.apiKey,
    timeoutMs: config.inbound.timeoutMs,
    mediaStore,
    logger,
  })

  const statusReporter = createStatusReporter({
    urlTemplate: config.inbound.statusUrlTemplate,
    apiKey: config.apiKey,
    timeoutMs: config.inbound.statusTimeoutMs,
    logger,
  })

  const sessions = new SessionManager({
    authDir: config.authDir,
    pairingTimeoutMs: config.pairingTimeoutMs,
    inboundMediaMaxBytes: config.inbound.mediaMaxBytes,
    typing: config.typing,
    logger,
    forwardInbound: (sessionId, message) => {
      void inboundForwarder(sessionId, message)
    },
  })

  const outbox = new Outbox(
    {
      dir: config.outboxDir,
      ...config.outbox,
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
    sessions,
    outbox,
    mediaStore,
    directSender,
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

  const server = await startServer({
    fetch: app.fetch,
    port: config.port,
    hostname: config.host,
  })

  logger.info({ port: server.port, host: config.host, instanceId }, 'gateway listening')
  logger.info(
    {
      auth: config.apiKey ? 'enabled' : 'DISABLED (set WHATSAPP_API_KEY)',
      inboundForwarding: config.inbound.urlTemplate ? 'enabled' : 'disabled',
      statusReporting: config.inbound.statusUrlTemplate ? 'enabled' : 'disabled',
      restoredSessions: config.restoreOnBoot,
    },
    'configuration',
  )
  logger.info(
    'sessions are in-memory: run a SINGLE replica with persistent session and outbox volumes, and back them up',
  )

  if (config.restoreOnBoot) {
    void sessions
      .restoreSessions({ delayMs: config.restoreDelayMs })
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
    logger.info('session restore disabled (WHATSAPP_RESTORE=false)')
  }

  let shuttingDown = false
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ signal }, 'shutting down')

    try {
      outbox.stop()
      clearInterval(mediaPruneTimer)
      await server.stop()
      await sessions.shutdown()
    } catch (error) {
      logger.error({ err: error }, 'shutdown failed')
    } finally {
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
