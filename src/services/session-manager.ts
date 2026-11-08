import {
  BaileysAdapter,
  PermanentSendError,
  type EngineStatus,
  type IncomingMessage,
  type MessageResult,
  type StoredSessionInfo,
  type WhatsAppAuthStore,
} from '../engine/index.js'
import { silentLogger, type Logger } from '../lib/logger.js'
import { maskPhone } from '../lib/phone.js'
import type { OutboxMessage } from './outbox.js'
import type { RuntimeSettings } from './settings-store.js'
import { simulateTyping, type TypingTiming } from './typing.js'

export interface ActiveSession {
  sessionId: string
  engine: BaileysAdapter
  status: EngineStatus
  qrCode?: string
  qrDataUrl?: string
  lastStatusReason?: string
}

export interface SessionSummary {
  sessionId: string
  status: EngineStatus
  reason?: string
}

/** A session in one of these states is already working towards "ready". */
const IN_PROGRESS: ReadonlySet<EngineStatus> = new Set([
  'initializing',
  'qr_ready',
  'authenticating',
  'ready',
])

export interface SessionManagerOptions {
  /** SQLite-backed credential store. */
  authStore: WhatsAppAuthStore
  /** Live runtime settings; pairing timeout and typing are read per use. */
  settings: RuntimeSettings
  /**
   * Called for every direct inbound customer message. Wired by the daemon to
   * the webhook forwarder; kept as a callback so the session manager never
   * imports the chatbot or the network.
   */
  forwardInbound?: (sessionId: string, message: IncomingMessage) => void
  logger?: Logger
}

export class SessionManager {
  private readonly sessions = new Map<string, ActiveSession>()
  private readonly log: Logger

  constructor(private readonly options: SessionManagerOptions) {
    this.log = options.logger ?? silentLogger
  }

  /**
   * Start pairing, or return the session that is already running. An
   * in-progress session is never torn down here: a second "Connect" click,
   * or one landing while a boot restore is still handshaking, used to kill
   * the live socket and race a new one over the same credentials.
   */
  async startSession(sessionId: string): Promise<ActiveSession> {
    const existing = this.sessions.get(sessionId)
    if (existing && IN_PROGRESS.has(existing.status)) return existing
    if (existing) {
      await existing.engine.disconnect().catch(() => {})
      this.sessions.delete(sessionId)
    }

    this.options.authStore.ensureSession(sessionId)
    const engine = new BaileysAdapter({
      sessionId,
      authStore: this.options.authStore,
      logger: this.log,
      pairingTimeoutMs: this.options.settings.session.pairingTimeoutMs,
      inboundMediaMaxBytes: this.options.settings.inbound.mediaMaxBytes,
    })
    const session: ActiveSession = { sessionId, engine, status: 'initializing' }
    this.sessions.set(sessionId, session)

    void engine
      .initialize({
        onStatusChange: (status, reason) => {
          session.status = status
          session.lastStatusReason = reason
          this.options.authStore.setStatus(sessionId, status, reason)
          if (status !== 'qr_ready') {
            session.qrCode = undefined
            session.qrDataUrl = undefined
          }
        },
        onQrCode: (qr, qrDataUrl) => {
          session.qrCode = qr
          session.qrDataUrl = qrDataUrl
        },
        onMessage: (message) => {
          // Fire-and-forget: the forwarder owns its timeout and error logging.
          this.options.forwardInbound?.(sessionId, message)
        },
      })
      .catch((err: unknown) => {
        this.log.error({ err, sessionId }, 'session failed to start')
        this.options.authStore.setStatus(sessionId, 'failed', 'start_failed')
      })

    return session
  }

  getSession(sessionId: string): ActiveSession | undefined {
    return this.sessions.get(sessionId)
  }

  /** Paired now, or paired before and restorable. */
  isKnown(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (session && IN_PROGRESS.has(session.status)) return true
    return this.options.authStore.hasPairedCreds(sessionId)
  }

  /** Sends through a ready session; null while it is not ready. */
  send(sessionId: string, to: string, message: OutboxMessage): Promise<MessageResult> | null {
    const session = this.sessions.get(sessionId)
    if (!session || session.status !== 'ready') return null
    const typing = this.options.settings.typing
    if (message.typing && typing) {
      return this.sendWithTyping(session, to, message, typing)
    }
    return this.dispatch(session, to, message)
  }

  private async sendWithTyping(
    session: ActiveSession,
    to: string,
    message: OutboxMessage,
    timing: TypingTiming,
  ): Promise<MessageResult> {
    await simulateTyping(session.engine, to, message.text, timing, {
      onError: (error) => {
        this.log.warn(
          { err: error, sessionId: session.sessionId, to: maskPhone(to) },
          'typing indicator failed',
        )
      },
    })
    return this.dispatch(session, to, message)
  }

  private dispatch(
    session: ActiveSession,
    to: string,
    message: OutboxMessage,
  ): Promise<MessageResult> {
    if (message.buttons?.length) {
      return session.engine
        .sendButtonsMessage(to, {
          text: message.text,
          ...(message.footer ? { footer: message.footer } : {}),
          buttons: message.buttons,
        })
        .catch((error: unknown) => {
          // The button profile is unofficial. If WhatsApp rejects it, send
          // the same body as plain text rather than losing the reply.
          if (error instanceof PermanentSendError) throw error
          this.log.warn(
            { err: error, sessionId: session.sessionId },
            'button send failed; falling back to text',
          )
          return session.engine.sendTextMessage(to, message.text)
        })
    }
    if (message.media) {
      return session.engine.sendMediaMessage(to, {
        data: message.media.data,
        mimetype: message.media.mimetype,
        ...(message.media.filename ? { filename: message.media.filename } : {}),
        ...(message.media.caption || message.text
          ? { caption: message.media.caption || message.text }
          : {}),
      })
    }
    return session.engine.sendTextMessage(to, message.text)
  }

  async logoutSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session) {
      await session.engine.logout()
      this.sessions.delete(sessionId)
    }
    // No live socket (not restored yet, or failed and dropped): the creds in
    // SQLite must still go, or the next boot restore silently re-links it.
    this.options.authStore.clearSession(sessionId)
  }

  /**
   * Follow a tenant slug rename (the session id is the slug). The socket is
   * closed, the credential row moved, and the session reconnected under its
   * new id — no re-scan needed.
   */
  async renameSession(from: string, to: string): Promise<void> {
    if (this.sessions.has(to) || this.options.authStore.hasSession(to)) {
      throw new Error(`A session named "${to}" already exists.`)
    }

    const session = this.sessions.get(from)
    const wasRunning = session ? IN_PROGRESS.has(session.status) : false
    if (session) {
      await session.engine.disconnect().catch(() => {})
      this.sessions.delete(from)
    }

    this.options.authStore.renameSession(from, to)

    if (wasRunning || this.options.authStore.hasPairedCreds(to)) await this.startSession(to)
  }

  listSessions(): SessionSummary[] {
    return Array.from(this.sessions.values()).map((session) => ({
      sessionId: session.sessionId,
      status: session.status,
      reason: session.lastStatusReason,
    }))
  }

  /** Every session row in SQLite, for the console and boot restore. */
  listStoredSessions(): StoredSessionInfo[] {
    return this.options.authStore.listSessions()
  }

  /**
   * Reconnect every previously-paired session after a (container) restart.
   * Half-paired rows (QR shown, never scanned) are skipped — they need a
   * fresh scan anyway. Restores are staggered so N sessions don't handshake
   * WA servers at once.
   */
  async restoreSessions(options?: {
    delayMs?: number
  }): Promise<{ restored: string[]; skipped: string[] }> {
    const delayMs = options?.delayMs ?? this.options.settings.session.restoreDelayMs
    const restored: string[] = []
    const skipped: string[] = []

    const candidates = this.options.authStore.listSessionIds().sort()
    for (const sessionId of candidates) {
      if (!this.options.authStore.hasPairedCreds(sessionId)) {
        skipped.push(sessionId)
        continue
      }
      try {
        await this.startSession(sessionId)
        restored.push(sessionId)
      } catch (error) {
        this.log.error({ err: error, sessionId }, 'session restore failed')
        skipped.push(sessionId)
      }
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
    }

    return { restored, skipped }
  }

  /** Graceful shutdown: close sockets but KEEP auth rows so boot restores. */
  async shutdown(): Promise<void> {
    await Promise.all(
      Array.from(this.sessions.values()).map((session) =>
        session.engine.disconnect().catch(() => {}),
      ),
    )
    this.sessions.clear()
  }
}
