import { Hono, type Context } from 'hono'

import type { DirectSendResult, DirectSender } from '../../services/direct-send.js'
import { messageSendButtonsSchema, messageSendMediaSchema, messageSendSchema } from '../schemas.js'
import type { AppEnv } from '../types.js'
import { parseBody } from '../validation.js'

export interface MessageRoutesOptions {
  directSender: DirectSender
}

/** Direct (non-queued) sends. These share the session's outbox rate budget. */
export function messageRoutes(options: MessageRoutesOptions): Hono<AppEnv> {
  const route = new Hono<AppEnv>()

  route.post('/send', async (c) => {
    const body = await parseBody(c, messageSendSchema)
    return sendResult(
      c,
      await options.directSender.send(body.sessionId, body.to, { text: body.text }),
    )
  })

  route.post('/send-media', async (c) => {
    const body = await parseBody(c, messageSendMediaSchema)
    const { media, text } = body
    return sendResult(
      c,
      await options.directSender.send(body.sessionId, body.to, {
        text: media.caption || text || '',
        media,
      }),
    )
  })

  route.post('/send-buttons', async (c) => {
    const body = await parseBody(c, messageSendButtonsSchema)
    return sendResult(
      c,
      await options.directSender.send(body.sessionId, body.to, {
        text: body.message.text,
        ...(body.message.footer ? { footer: body.message.footer } : {}),
        buttons: body.message.buttons,
      }),
    )
  })

  return route
}

function sendResult(c: Context<AppEnv>, outcome: DirectSendResult) {
  if (outcome.ok) {
    return c.json({ ok: true, result: outcome.result })
  }
  return c.json(
    {
      ok: false,
      error: outcome.error,
      ...(outcome.code ? { code: outcome.code } : {}),
    },
    outcome.status,
  )
}
