/**
 * Report a queued message's final outcome back to the caller's platform.
 *
 * The gateway holds no platform database credentials, so it cannot settle the
 * platform's WhatsApp log itself. After the outbox sends a job — or gives up
 * on it — this posts the outcome, keyed by the caller's idempotency key, to
 * the configured status callback with the shared secret.
 *
 * Best-effort, like inbound forwarding: a down webhook costs a log line,
 * never a message.
 */

import { webhookUrlFor } from '../lib/callbacks.js'
import { silentLogger, type Logger } from '../lib/logger.js'
import type { OutboxSettlement } from './outbox.js'

const DEFAULT_TIMEOUT_MS = 3_000

export interface StatusReporterOptions {
  /**
   * Full template with `{sessionId}` or a base origin. Null/empty disables
   * reporting.
   */
  urlTemplate: string | null
  /** Shared secret the webhook verifies (`WHATSAPP_API_KEY`). */
  apiKey: string
  timeoutMs?: number
  logger?: Logger
}

export type StatusReporter = (event: OutboxSettlement) => Promise<void>

export function createStatusReporter(options: StatusReporterOptions): StatusReporter {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const log = options.logger ?? silentLogger

  return async (event) => {
    if (!options.urlTemplate) return
    const url = webhookUrlFor(options.urlTemplate, event.sessionId, 'whatsapp-status')
    if (!url) return

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(options.apiKey ? { 'x-api-key': options.apiKey } : {}),
        },
        body: JSON.stringify({
          sessionId: event.sessionId,
          idempotencyKey: event.idempotencyKey,
          status: event.status,
          ...(event.messageId ? { messageId: event.messageId } : {}),
          ...(event.reason ? { reason: event.reason } : {}),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })

      if (!response.ok) {
        log.warn(
          { sessionId: event.sessionId, status: response.status },
          'status report was rejected',
        )
      }
    } catch (error) {
      log.warn({ err: error, sessionId: event.sessionId }, 'status report failed')
    }
  }
}
