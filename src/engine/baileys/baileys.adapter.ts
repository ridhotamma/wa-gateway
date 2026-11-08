import makeWASocket, {
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  type WAMessage,
  type WASocket,
  type WAVersion,
} from 'baileys'
import type { Boom } from '@hapi/boom'
import pino, { type Logger } from 'pino'
import qrcode from 'qrcode'
import type {
  ButtonsInput,
  EngineEventCallbacks,
  EngineStatus,
  IncomingMessage,
  MediaInput,
  MessageResult,
  PresenceState,
  WhatsAppEngine,
} from '../types.js'
import { closeAction } from './close-policy.js'
import { extractInboundMessage } from './inbound.js'
import { getBaileysAuthState, type BaileysSessionConfig } from './session-store.js'
import {
  sendBaileysButtons,
  sendBaileysMedia,
  sendBaileysPresence,
  sendBaileysText,
} from './messaging.js'

export interface BaileysEngineOptions extends BaileysSessionConfig {
  /** Service logger. A silent one is used when omitted (tests, scripts). */
  logger?: Logger
  /** Baileys' own protocol log. Silent by default; very noisy when raised. */
  baileysLogLevel?: pino.LevelWithSilent
  /**
   * How long an unpaired session may keep showing QR codes before it gives
   * up (ms). Without a limit an abandoned "Connect" click regenerates QRs and
   * holds a socket forever. Default 3 minutes.
   */
  pairingTimeoutMs?: number
  /** Ceiling for the reconnect backoff of a paired session (ms). Default 5 min. */
  maxReconnectDelayMs?: number
  /**
   * Largest inbound attachment to download, in bytes. A larger file is
   * forwarded as metadata only: downloading a 100 MB document would spike
   * memory and the webhook could not store it anyway. Default 16 MB.
   */
  inboundMediaMaxBytes?: number
}

const BASE_RECONNECT_DELAY_MS = 2_000

// One version lookup per process instead of per connect: the lookup is an
// HTTP call to GitHub, and every restored session would otherwise repeat it.
let versionPromise: Promise<WAVersion | undefined> | null = null
function resolveWaVersion(): Promise<WAVersion | undefined> {
  versionPromise ??= fetchLatestBaileysVersion({ signal: AbortSignal.timeout(5_000) })
    // Undefined lets Baileys use the version it ships with.
    .then((r) => (r.error ? undefined : r.version))
    .catch(() => undefined)
  return versionPromise
}

export class BaileysAdapter implements WhatsAppEngine {
  private socket: WASocket | null = null
  private status: EngineStatus = 'disconnected'
  private callbacks: EngineEventCallbacks = {}
  private stopped = false
  private clearSessionFn: (() => void) | null = null
  /** Bumped per socket so events from a replaced socket are ignored. */
  private generation = 0
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pairingTimer: ReturnType<typeof setTimeout> | null = null
  private paired = false
  private selfId: string | null = null
  private readonly log: Logger

  constructor(private readonly options: BaileysEngineOptions) {
    this.log = (options.logger ?? pino({ level: 'silent' })).child({
      sessionId: options.sessionId,
    })
  }

  async initialize(callbacks: EngineEventCallbacks): Promise<void> {
    this.callbacks = callbacks
    this.stopped = false
    this.reconnectAttempts = 0
    await this.connect()
  }

  private async connect(): Promise<void> {
    const generation = ++this.generation
    this.updateStatus('initializing')

    try {
      const { state, saveCreds, clearSession } = await getBaileysAuthState(this.options)
      this.clearSessionFn = clearSession
      this.paired = Boolean(state.creds.me?.id)

      const logger = pino({ level: this.options.baileysLogLevel ?? 'silent' })
      const version = await resolveWaVersion()
      if (this.stopped || generation !== this.generation) return

      const sock = makeWASocket({
        ...(version ? { version } : {}),
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        logger,
        browser: ['WA Gateway', 'Chrome', '120.0.0'],
        // Staying "offline" keeps push notifications flowing to the seller's
        // phone; an always-online linked device silences them.
        markOnlineOnConnect: false,
        // Notification-only client: never pull chat history into memory.
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
      })
      this.socket = sock

      sock.ev.on('creds.update', () => {
        if (state.creds.me?.id) this.paired = true
        // A write that fails here (disk full, volume owned by another user)
        // loses the link on the next restart, so it has to be seen.
        saveCreds().catch((err: unknown) => {
          this.log.error({ err }, 'saving credentials failed')
        })
      })

      // Inbound chat: the bot only ever *reads* here. Extracting and
      // forwarding is deliberately best-effort and fire-and-forget — a slow
      // or down webhook must never backpressure the socket.
      sock.ev.on('messages.upsert', ({ messages, type }) => {
        if (generation !== this.generation) return
        // `append` is history/offline sync; only real-time messages reply.
        if (type !== 'notify') return
        // Downloads are async; keep one upsert batch in order without making
        // the socket event handler wait on WhatsApp's media servers.
        void (async () => {
          for (const raw of messages) {
            if (generation !== this.generation) return
            const inbound = extractInboundMessage(raw)
            if (!inbound) continue
            const message = await this.attachInboundMedia(raw, inbound)
            if (generation !== this.generation) return
            try {
              this.callbacks.onMessage?.(message)
            } catch (error) {
              // A callback bug must not kill the socket loop.
              this.log.error({ err: error }, 'onMessage handler failed')
            }
          }
        })().catch((error: unknown) => {
          this.log.error({ err: error }, 'inbound batch failed')
        })
      })

      sock.ev.on('connection.update', async (update) => {
        if (generation !== this.generation) return
        const { connection, lastDisconnect, qr } = update

        if (qr) {
          this.updateStatus('qr_ready')
          this.armPairingTimeout()
          try {
            this.callbacks.onQrCode?.(qr, await qrcode.toDataURL(qr))
          } catch {
            this.callbacks.onQrCode?.(qr)
          }
        }

        if (connection === 'open') {
          this.clearPairingTimeout()
          this.reconnectAttempts = 0
          this.paired = true
          this.selfId = sock.user?.id ?? null
          // No number in the log: it is the seller's phone.
          this.log.info('connected')
          this.updateStatus('ready')
          return
        }

        if (connection === 'close') {
          this.detachSocket(sock)
          if (this.stopped) return
          const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode
          this.handleClose(statusCode)
        }
      })
    } catch (error) {
      if (generation !== this.generation) return
      this.updateStatus('failed', (error as Error).message)
      this.callbacks.onError?.(error as Error)
      // A failure before the socket exists (disk, version lookup) is as
      // transient as a dropped connection for a paired session.
      if (this.paired && !this.stopped) this.scheduleReconnect('init_error')
    }
  }

  private handleClose(statusCode: number | undefined): void {
    const action = closeAction(statusCode, this.paired)
    // One line per close: the trail a failed scan or a flapping session
    // leaves in `docker compose logs`, where Baileys' own logger is silent.
    this.log.info(
      {
        statusCode: statusCode ?? null,
        paired: this.paired,
        action: action.kind,
        ...('reason' in action ? { reason: action.reason } : {}),
      },
      'socket closed',
    )

    switch (action.kind) {
      case 'terminal':
        this.stopped = true
        this.clearPairingTimeout()
        if (action.clearCreds) this.clearSessionFn?.()
        this.updateStatus(action.status, action.reason)
        return

      // WhatsApp asks the newly scanned device to reconnect with its fresh
      // credentials. Do it at once, no backoff.
      case 'restart':
        void this.connect()
        return

      case 'pairing_ended':
        this.endPairing(action.reason)
        return

      case 'reconnect':
        this.updateStatus('disconnected', action.reason)
        this.scheduleReconnect(action.reason)
    }
  }

  /**
   * Give up on a pairing nobody completed: close the socket, drop the
   * half-made keys (they can't be restored) and report `failed`, which the
   * admin shows as "expired, connect again".
   */
  private endPairing(reason: string): void {
    this.stopped = true
    this.clearPairingTimeout()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    if (this.socket) this.detachSocket(this.socket, true)
    this.clearSessionFn?.()
    this.updateStatus('failed', reason)
  }

  /**
   * Exponential backoff with jitter. Paired sessions retry forever (capped
   * delay): giving up would silently stop a seller's notifications after an
   * outage. Unpaired sessions never get here: their close ends the pairing
   * (`closeAction`), and so does the pairing window below.
   */
  private scheduleReconnect(reason: string): void {
    if (this.stopped || this.reconnectTimer) return
    const cap = this.options.maxReconnectDelayMs ?? 5 * 60_000
    const exp = Math.min(cap, BASE_RECONNECT_DELAY_MS * 2 ** this.reconnectAttempts)
    const delay = Math.round(exp / 2 + Math.random() * (exp / 2))
    this.reconnectAttempts += 1
    this.updateStatus('disconnected', `${reason}; retry_in_${Math.round(delay / 1000)}s`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.stopped) void this.connect()
    }, delay)
  }

  /**
   * The outer limit on one pairing attempt, whatever Baileys does. It belongs
   * to the attempt, not to a socket: it used to bail out when the socket had
   * been replaced (a generation check), which is exactly the case where it is
   * needed.
   */
  private armPairingTimeout(): void {
    if (this.paired || this.pairingTimer) return
    const timeout = this.options.pairingTimeoutMs ?? 3 * 60_000
    this.pairingTimer = setTimeout(() => {
      this.pairingTimer = null
      if (this.paired || this.stopped) return
      this.endPairing('qr_timeout')
    }, timeout)
  }

  private clearPairingTimeout(): void {
    if (this.pairingTimer) clearTimeout(this.pairingTimer)
    this.pairingTimer = null
  }

  private detachSocket(sock: WASocket, end = false): void {
    sock.ev.removeAllListeners('connection.update')
    sock.ev.removeAllListeners('creds.update')
    sock.ev.removeAllListeners('messages.upsert')
    if (end) {
      try {
        sock.end(undefined)
      } catch {
        // Already closed.
      }
    }
    if (this.socket === sock) this.socket = null
  }

  private stopTimers(): void {
    this.clearPairingTimeout()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  async disconnect(): Promise<void> {
    this.stopped = true
    this.generation += 1
    this.stopTimers()
    if (this.socket) this.detachSocket(this.socket, true)
    this.updateStatus('disconnected', 'explicit_disconnect')
  }

  async logout(): Promise<void> {
    this.stopped = true
    this.generation += 1
    this.stopTimers()
    const sock = this.socket
    if (sock) {
      // logout() needs a live connection; an unlinked-while-offline device
      // still gets its local creds removed below.
      await sock.logout().catch(() => {})
      this.detachSocket(sock, true)
    }
    this.clearSessionFn?.()
    this.updateStatus('disconnected', 'logged_out')
  }

  getStatus(): EngineStatus {
    return this.status
  }

  /** The linked account's own JID once connected (e.g. `628xx:3@s.whatsapp.net`). */
  getSelfId(): string | null {
    return this.selfId
  }

  async probeLiveness(): Promise<boolean> {
    return this.status === 'ready' && this.socket !== null
  }

  /**
   * Download a customer attachment before the daemon forwarder sees it.
   * Best-effort: a failed download still forwards the caption/metadata, so
   * the seller's log shows that something arrived even if the bytes expired.
   */
  private async attachInboundMedia(
    raw: WAMessage,
    inbound: IncomingMessage,
  ): Promise<IncomingMessage> {
    const media = inbound.media
    if (!media) return inbound

    const maxBytes = this.options.inboundMediaMaxBytes ?? 16 * 1024 * 1024
    if (media.sizeBytes > maxBytes) {
      this.log.warn(
        { kind: media.kind, messageId: inbound.id, sizeBytes: media.sizeBytes, maxBytes },
        'inbound media exceeds the download limit; forwarding metadata only',
      )
      return inbound
    }

    try {
      const data = await downloadMediaMessage(raw, 'buffer', {})
      if (!data.length) return inbound
      if (data.length > maxBytes) {
        this.log.warn(
          { kind: media.kind, messageId: inbound.id, sizeBytes: data.length, maxBytes },
          'downloaded inbound media exceeds the limit; forwarding metadata only',
        )
        return inbound
      }
      return {
        ...inbound,
        media: { ...media, sizeBytes: media.sizeBytes || data.length, data },
      }
    } catch (error) {
      this.log.warn(
        { err: error, kind: media.kind, messageId: inbound.id },
        'could not download inbound media',
      )
      return inbound
    }
  }

  async sendTextMessage(to: string, text: string): Promise<MessageResult> {
    return sendBaileysText(this.assertReady(), to, text)
  }

  async sendMediaMessage(to: string, media: MediaInput): Promise<MessageResult> {
    return sendBaileysMedia(this.assertReady(), to, media)
  }

  async sendButtonsMessage(to: string, buttons: ButtonsInput): Promise<MessageResult> {
    return sendBaileysButtons(this.assertReady(), to, buttons)
  }

  async sendPresenceUpdate(to: string, state: PresenceState): Promise<void> {
    await sendBaileysPresence(this.assertReady(), to, state)
  }

  private updateStatus(status: EngineStatus, reason?: string): void {
    this.status = status
    this.callbacks.onStatusChange?.(status, reason)
  }

  private assertReady(): WASocket {
    if (this.status !== 'ready' || !this.socket) {
      throw new Error(`WhatsApp engine is not ready (status: ${this.status}).`)
    }
    return this.socket
  }
}
