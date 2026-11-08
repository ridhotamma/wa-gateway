import { existsSync, readdirSync, renameSync } from 'node:fs'
import path from 'node:path'

import {
  BaileysAdapter,
  clearSessionDir,
  getAuthBaseDir,
  hasPairedCreds,
  PermanentSendError,
  type EngineStatus,
  type IncomingMessage,
  type MessageResult,
} from '../engine/index.js'
import { silentLogger, type Logger } from '../lib/logger.js'
import { maskPhone } from '../lib/phone.js'
import type { OutboxMessage } from './outbox.js'
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
  /** Base directory holding one credential directory per session. */
  authDir: string
  pairingTimeoutMs?: number
  /** Largest inbound attachment the engine downloads before forwarding metadata. */
  inboundMediaMaxBytes?: number
  /**
   * Called for every direct inbound customer message. Wired by the daemon to
   * the webhook forwarder; kept as a callback so the session manager never
   * imports the chatbot or the network.
   */
  forwardInbound?: (sessionId: string, message: IncomingMessage) => void
  /**
   * Chatbot replies set `typing` and get a "typing…" pause before sending.
   * `null` disables the simulation without changing callers.
   */
  typing?: TypingTiming | null
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
   * the live socket and race a new one over the same credential files.
   */
  async startSession(sessionId: string): Promise<ActiveSession> {
    const existing = this.sessions.get(sessionId)
    if (existing && IN_PROGRESS.has(existing.status)) return existing
    if (existing) {
      await existing.engine.disconnect().catch(() => {})
      this.sessions.delete(sessionId)
    }

    const engine = new BaileysAdapter({
      sessionId,
      authDir: this.options.authDir,
      logger: this.log,
      ...(this.options.pairingTimeoutMs !== undefined
        ? { pairingTimeoutMs: this.options.pairingTimeoutMs }
        : {}),
      ...(this.options.inboundMediaMaxBytes !== undefined
        ? { inboundMediaMaxBytes: this.options.inboundMediaMaxBytes }
        : {}),
    })
    const session: ActiveSession = { sessionId, engine, status: 'initializing' }
    this.sessions.set(sessionId, session)

    void engine
      .initialize({
        onStatusChange: (status, reason) => {
          session.status = status
          session.lastStatusReason = reason
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
    return hasPairedCreds(getAuthBaseDir(this.options.authDir), sessionId)
  }

  /** Sends through a ready session; null while it is not ready. */
  send(sessionId: string, to: string, message: OutboxMessage): Promise<MessageResult> | null {
    const session = this.sessions.get(sessionId)
    if (!session || session.status !== 'ready') return null
    const typing = this.options.typing
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
    // No live socket (not restored yet, or failed and dropped): the creds on
    // disk must still go, or the next boot restore silently re-links it.
    clearSessionDir(getAuthBaseDir(this.options.authDir), sessionId)
  }

  /**
   * Follow a tenant slug rename (the session id is the slug). The socket is
   * closed, the credential dir moved, and the session reconnected under its
   * new id — no re-scan needed.
   */
  async renameSession(from: string, to: string): Promise<void> {
    const baseDir = getAuthBaseDir(this.options.authDir)
    const target = path.join(baseDir, to)
    if (this.sessions.has(to) || existsSync(target)) {
      throw new Error(`A session named "${to}" already exists.`)
    }

    const session = this.sessions.get(from)
    const wasRunning = session ? IN_PROGRESS.has(session.status) : false
    if (session) {
      await session.engine.disconnect().catch(() => {})
      this.sessions.delete(from)
    }

    const source = path.join(baseDir, from)
    if (existsSync(source)) renameSync(source, target)

    if (wasRunning || hasPairedCreds(baseDir, to)) await this.startSession(to)
  }

  listSessions(): SessionSummary[] {
    return Array.from(this.sessions.values()).map((session) => ({
      sessionId: session.sessionId,
      status: session.status,
      reason: session.lastStatusReason,
    }))
  }

  /**
   * Reconnect every previously-paired session after a (container) restart.
   * Half-paired directories (QR shown, never scanned) are skipped — they need
   * a fresh scan anyway. Restores are staggered so N sessions don't handshake
   * WA servers at once.
   */
  async restoreSessions(options?: {
    delayMs?: number
  }): Promise<{ restored: string[]; skipped: string[] }> {
    const baseDir = getAuthBaseDir(this.options.authDir)
    const delayMs = options?.delayMs ?? 1_500
    const restored: string[] = []
    const skipped: string[] = []

    if (!existsSync(baseDir)) return { restored, skipped }

    const candidates = readdirSync(baseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[a-zA-Z0-9_-]+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort()

    for (const sessionId of candidates) {
      if (!hasPairedCreds(baseDir, sessionId)) {
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

  /** Graceful shutdown: close sockets but KEEP auth files so boot restores. */
  async shutdown(): Promise<void> {
    await Promise.all(
      Array.from(this.sessions.values()).map((session) =>
        session.engine.disconnect().catch(() => {}),
      ),
    )
    this.sessions.clear()
  }
}
