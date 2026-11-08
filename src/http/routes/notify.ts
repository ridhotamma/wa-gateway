import { Hono, type Context } from 'hono'

import type { Outbox } from '../../services/outbox.js'
import type { SessionManager } from '../../services/session-manager.js'
import {
  buttonsNotifySchema,
  MAX_QUEUED_MEDIA_BASE64,
  mediaNotifySchema,
  textNotifySchema,
} from '../schemas.js'
import type { AppEnv } from '../types.js'
import { parseBody } from '../validation.js'

export interface NotifyRoutesOptions {
  sessions: SessionManager
  outbox: Outbox
}

/**
 * Queued notifications. A 202 means the job is on disk and will be sent when
 * the session is ready; 409 means this tenant has not linked WhatsApp.
 */
export function notifyRoutes(options: NotifyRoutesOptions): Hono<AppEnv> {
  const route = new Hono<AppEnv>()

  route.post('/text', async (c) => {
    const body = await parseBody(c, textNotifySchema)
    if (!options.sessions.isKnown(body.sessionId)) return notConnected(c)

    const queued = options.outbox.enqueue({
      sessionId: body.sessionId,
      idempotencyKey: body.idempotencyKey,
      kind: body.kind,
      to: body.phone,
      text: body.text,
      typing: body.typing,
    })
    return c.json({ ok: true, queued: true, ...queued }, 202)
  })

  route.post('/media', async (c) => {
    const body = await parseBody(c, mediaNotifySchema)
    if (!options.sessions.isKnown(body.sessionId)) return notConnected(c)

    const media = body.media
    if (!/^https?:\/\//i.test(media.data) && media.data.length > MAX_QUEUED_MEDIA_BASE64) {
      return c.json(
        {
          ok: false,
          error:
            'Queued media over 1.5 MB must be a URL. Use /messages/send-media for a direct base64 send.',
        },
        413,
      )
    }

    const queued = options.outbox.enqueue({
      sessionId: body.sessionId,
      idempotencyKey: body.idempotencyKey,
      kind: body.kind,
      to: body.phone,
      text: media.caption || body.text || '',
      media,
    })
    return c.json({ ok: true, queued: true, ...queued }, 202)
  })

  route.post('/buttons', async (c) => {
    const body = await parseBody(c, buttonsNotifySchema)
    if (!options.sessions.isKnown(body.sessionId)) return notConnected(c)

    const queued = options.outbox.enqueue({
      sessionId: body.sessionId,
      idempotencyKey: body.idempotencyKey,
      kind: body.kind,
      to: body.phone,
      text: body.message.text,
      buttons: body.message.buttons,
      ...(body.message.footer ? { footer: body.message.footer } : {}),
      typing: body.typing,
    })
    return c.json({ ok: true, queued: true, ...queued }, 202)
  })

  return route
}

/** 409, not 400: the request is fine, the tenant just has not linked WhatsApp. */
function notConnected(c: Context<AppEnv>) {
  return c.json({ ok: false, queued: false, error: 'not_connected' }, 409)
}
