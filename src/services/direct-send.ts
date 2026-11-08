import { PermanentSendError, type MessageResult } from '../engine/index.js'
import { silentLogger, type Logger } from '../lib/logger.js'
import { maskPhone } from '../lib/phone.js'
import type { Outbox, OutboxMessage } from './outbox.js'
import type { SessionManager } from './session-manager.js'

export type DirectSendResult =
  | { ok: true; result: Pick<MessageResult, 'id' | 'timestamp'> }
  | { ok: false; status: 409 | 422 | 429 | 502; error: string; code?: string }

export interface DirectSenderOptions {
  sessions: SessionManager
  outbox: Outbox
  logger?: Logger
}

/**
 * The direct (non-queued) send path used by admin tools and seller
 * attachments. It shares the session's hourly budget with the outbox, so a
 * "send test" button cannot be used to bypass pacing.
 */
export class DirectSender {
  private readonly log: Logger

  constructor(private readonly options: DirectSenderOptions) {
    this.log = options.logger ?? silentLogger
  }

  async send(sessionId: string, to: string, message: OutboxMessage): Promise<DirectSendResult> {
    if (this.options.sessions.getSession(sessionId)?.status !== 'ready') {
      return { ok: false, status: 409, error: 'Session is not connected or ready' }
    }

    const slot = this.options.outbox.reserveDirectSend(sessionId)
    if (!slot.ok) {
      return {
        ok: false,
        status: 429,
        error: `Sending too fast. Try again in ${Math.ceil(slot.retryAfterMs / 1_000)}s.`,
      }
    }

    const sending = this.options.sessions.send(sessionId, to, message)
    if (!sending) {
      return { ok: false, status: 409, error: 'Session is not connected or ready' }
    }

    try {
      const result = await sending
      return { ok: true, result: { id: result.id, timestamp: result.timestamp } }
    } catch (error) {
      if (error instanceof PermanentSendError) {
        return { ok: false, status: 422, error: error.message, code: error.code }
      }
      this.log.warn({ err: error, sessionId, to: maskPhone(to) }, 'direct send failed')
      return { ok: false, status: 502, error: 'WhatsApp did not accept the message.' }
    }
  }
}
