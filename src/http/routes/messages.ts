import { createRoute, OpenAPIHono } from '@hono/zod-openapi'
import type { Context } from 'hono'

import type { DirectSendResult, DirectSender } from '../../services/direct-send.js'
import { API_SECURITY, errorResponse, sendMessageResponseSchema } from '../openapi.js'
import { messageSendButtonsSchema, messageSendMediaSchema, messageSendSchema } from '../schemas.js'
import type { AppEnv } from '../types.js'

export interface MessageRoutesOptions {
  directSender: DirectSender
}

/** Direct (non-queued) sends. These share the session's outbox rate budget. */
export function messageRoutes(options: MessageRoutesOptions): OpenAPIHono<AppEnv> {
  const route = new OpenAPIHono<AppEnv>()

  route.openapi(
    createRoute({
      method: 'post',
      path: '/send',
      tags: ['Messages'],
      summary: 'Send a text message directly',
      description:
        'Sends through a ready session and returns the WhatsApp message id. This path is not queued or retried; use `/notify/text` for durable delivery. Direct sends share the session rate budget.',
      security: API_SECURITY,
      request: {
        body: { required: true, content: { 'application/json': { schema: messageSendSchema } } },
      },
      responses: directResponses('The message was accepted by WhatsApp.'),
    }),
    async (c) => {
      const body = c.req.valid('json')
      return sendResult(
        c,
        await options.directSender.send(body.sessionId, body.to, { text: body.text }),
      )
    },
  )

  route.openapi(
    createRoute({
      method: 'post',
      path: '/send-media',
      tags: ['Messages'],
      summary: 'Send media directly',
      description:
        'Sends media through a ready session without queueing. Base64 payloads are allowed up to the JSON body limit; queued media is capped at 1.5 MB.',
      security: API_SECURITY,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: messageSendMediaSchema } },
        },
      },
      responses: directResponses('The media was accepted by WhatsApp.'),
    }),
    async (c) => {
      const body = c.req.valid('json')
      const { media, text } = body
      return sendResult(
        c,
        await options.directSender.send(body.sessionId, body.to, {
          text: media.caption || text || '',
          media,
        }),
      )
    },
  )

  route.openapi(
    createRoute({
      method: 'post',
      path: '/send-buttons',
      tags: ['Messages'],
      summary: 'Send reply buttons directly',
      description:
        'Sends one to three reply buttons through a ready session. Buttons are an unofficial WhatsApp feature, so the gateway falls back to plain text if they are rejected.',
      security: API_SECURITY,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: messageSendButtonsSchema } },
        },
      },
      responses: directResponses('The message was accepted by WhatsApp.'),
    }),
    async (c) => {
      const body = c.req.valid('json')
      return sendResult(
        c,
        await options.directSender.send(body.sessionId, body.to, {
          text: body.message.text,
          ...(body.message.footer ? { footer: body.message.footer } : {}),
          buttons: body.message.buttons,
        }),
      )
    },
  )

  return route
}

function directResponses(successDescription: string) {
  return {
    200: {
      description: successDescription,
      content: { 'application/json': { schema: sendMessageResponseSchema } },
    },
    400: errorResponse('Invalid JSON body or field.'),
    401: errorResponse('Missing or invalid API key.', { ok: false, error: 'Unauthorized' }),
    409: errorResponse('The session is not connected or ready.', {
      ok: false,
      error: 'Session is not connected or ready',
    }),
    422: errorResponse('Permanent failure: not on WhatsApp, invalid recipient or unsafe media.', {
      ok: false,
      error: 'The recipient is not on WhatsApp.',
      code: 'not_on_whatsapp',
    }),
    429: errorResponse('The per-session send budget is exhausted; retry later.', {
      ok: false,
      error: 'Sending too fast. Try again in 3s.',
    }),
    502: errorResponse('WhatsApp did not accept the message.', {
      ok: false,
      error: 'WhatsApp did not accept the message.',
    }),
  } as const
}

function sendResult(c: Context<AppEnv>, outcome: DirectSendResult) {
  if (outcome.ok) {
    return c.json({ ok: true as const, result: outcome.result }, 200)
  }
  return c.json(
    {
      ok: false as const,
      error: outcome.error,
      ...(outcome.code ? { code: outcome.code } : {}),
    },
    outcome.status,
  )
}
