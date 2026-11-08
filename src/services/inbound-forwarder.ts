/**
 * Forward inbound customer messages to the system that owns the chatbot.
 *
 * The gateway stays dumb on purpose: it extracts `{ messageId, from, body,
 * timestamp }` and posts it. Deciding whether and how to answer belongs to the
 * caller's webhook, where templates, shop data and model keys live.
 *
 * Delivery is best-effort with a short timeout. A down webhook or a slow reply
 * must not stall the Baileys event loop, so failures are logged and dropped —
 * WhatsApp redelivers the message on reconnect if it never landed, and the
 * webhook dedupes on `messageId`.
 */

import type { IncomingMessage } from '../engine/index.js'
import { webhookUrlFor } from '../lib/callbacks.js'
import { silentLogger, type Logger } from '../lib/logger.js'
import { maskPhone } from '../lib/phone.js'
import type { MediaStore } from './media-store.js'
import type { RuntimeSettings } from './settings-store.js'

export interface InboundForwarderOptions {
  /** Live runtime settings; the console can change the callback URL. */
  settings: RuntimeSettings
  /** Shared secret the webhook verifies (`WHATSAPP_API_KEY`). */
  apiKey: string
  /**
   * Where downloaded customer media is spooled. The webhook fetches it by id;
   * without a store the message is still forwarded with `hasMedia` only.
   */
  mediaStore?: MediaStore
  logger?: Logger
}

export type InboundForwarder = (sessionId: string, message: IncomingMessage) => Promise<void>

export function createInboundForwarder(options: InboundForwarderOptions): InboundForwarder {
  const log = options.logger ?? silentLogger

  return async (sessionId, message) => {
    const config = options.settings.inbound
    const url = config.urlTemplate ? webhookUrlFor(config.urlTemplate, sessionId, 'whatsapp') : null
    if (!url) return

    let media: Record<string, unknown> | undefined
    if (message.media?.data) {
      try {
        const stored = await options.mediaStore?.save(
          sessionId,
          message.id,
          message.media,
          message.media.data,
        )
        if (stored) {
          media = {
            id: stored.id,
            kind: stored.kind,
            mimetype: stored.mimetype,
            ...(stored.filename ? { filename: stored.filename } : {}),
            sizeBytes: stored.sizeBytes,
          }
        }
      } catch (error) {
        log.warn(
          { err: error, sessionId, from: maskPhone(message.from) },
          'inbound media spool failed',
        )
      }
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        // `x-api-key` is the gateway's convention. The webhook may also
        // accept `Authorization: Bearer`, but the shared key header is what
        // this service documents and sends.
        headers: {
          'Content-Type': 'application/json',
          ...(options.apiKey ? { 'x-api-key': options.apiKey } : {}),
        },
        body: JSON.stringify({
          sessionId,
          messageId: message.id,
          from: message.from,
          body: message.body ?? '',
          timestamp: message.timestamp,
          hasMedia: message.hasMedia ?? false,
          ...(media ? { media } : {}),
        }),
        signal: AbortSignal.timeout(config.timeoutMs),
      })

      if (!response.ok && response.status !== 409) {
        log.warn(
          { sessionId, status: response.status, from: maskPhone(message.from) },
          'inbound forward was rejected',
        )
      }
    } catch (error) {
      log.warn({ err: error, sessionId, from: maskPhone(message.from) }, 'inbound forward failed')
    }
  }
}
