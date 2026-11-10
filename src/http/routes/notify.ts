import { createRoute, OpenAPIHono } from '@hono/zod-openapi'

import type { Outbox } from '../../services/outbox.js'
import type { SessionManager } from '../../services/session-manager.js'
import { API_SECURITY, errorResponse, queuedResponseSchema } from '../openapi.js'
import {
  buttonsNotifySchema,
  MAX_QUEUED_MEDIA_BASE64,
  mediaNotifySchema,
  textNotifySchema,
} from '../schemas.js'
import type { AppEnv } from '../types.js'

export interface NotifyRoutesOptions {
  sessions: SessionManager
  outbox: Outbox
}

/**
 * Queued notifications. A 202 means the job is on disk and will be sent when
 * the session is ready; 409 means this tenant has not linked WhatsApp.
 */
export function notifyRoutes(options: NotifyRoutesOptions): OpenAPIHono<AppEnv> {
  const route = new OpenAPIHono<AppEnv>()

  route.openapi(
    createRoute({
      method: 'post',
      path: '/text',
      tags: ['Notifications'],
      summary: 'Queue a text message',
      description:
        'Writes a durable outbox job and returns immediately. The job is retried and paced per session. Reusing an `idempotencyKey` returns the same `jobId` with `duplicate: true`.',
      security: API_SECURITY,
      request: {
        body: { required: true, content: { 'application/json': { schema: textNotifySchema } } },
      },
      responses: {
        202: {
          description: 'Queued in SQLite.',
          content: { 'application/json': { schema: queuedResponseSchema } },
        },
        400: errorResponse('Invalid JSON body or field.'),
        401: errorResponse('Missing or invalid API key.', { ok: false, error: 'Unauthorized' }),
        409: errorResponse('The tenant has not linked WhatsApp.', {
          ok: false,
          queued: false,
          error: 'not_connected',
        }),
      },
    }),
    (c) => {
      const body = c.req.valid('json')
      if (!options.sessions.isKnown(body.sessionId)) {
        return c.json({ ok: false as const, queued: false as const, error: 'not_connected' }, 409)
      }

      const queued = options.outbox.enqueue({
        sessionId: body.sessionId,
        idempotencyKey: body.idempotencyKey,
        kind: body.kind,
        to: body.phone,
        text: body.text,
        typing: body.typing,
      })
      return c.json({ ok: true as const, queued: true as const, ...queued }, 202)
    },
  )

  route.openapi(
    createRoute({
      method: 'post',
      path: '/media',
      tags: ['Notifications'],
      summary: 'Queue a media message',
      description:
        'Queues an image, video, audio or document. `media.data` is a public URL or base64; queued base64 is capped at 1.5 MB because the job is stored in SQLite.',
      security: API_SECURITY,
      request: {
        body: { required: true, content: { 'application/json': { schema: mediaNotifySchema } } },
      },
      responses: {
        202: {
          description: 'Queued in SQLite.',
          content: { 'application/json': { schema: queuedResponseSchema } },
        },
        400: errorResponse('Invalid JSON body or field.'),
        401: errorResponse('Missing or invalid API key.', { ok: false, error: 'Unauthorized' }),
        409: errorResponse('The tenant has not linked WhatsApp.', {
          ok: false,
          queued: false,
          error: 'not_connected',
        }),
        413: errorResponse('The JSON body is too large, or queued base64 media exceeds 1.5 MB.'),
      },
    }),
    (c) => {
      const body = c.req.valid('json')
      if (!options.sessions.isKnown(body.sessionId)) {
        return c.json({ ok: false as const, queued: false as const, error: 'not_connected' }, 409)
      }

      const media = body.media
      if (!/^https?:\/\//i.test(media.data) && media.data.length > MAX_QUEUED_MEDIA_BASE64) {
        return c.json(
          {
            ok: false as const,
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
      return c.json({ ok: true as const, queued: true as const, ...queued }, 202)
    },
  )

  route.openapi(
    createRoute({
      method: 'post',
      path: '/buttons',
      tags: ['Notifications'],
      summary: 'Queue a reply-button message',
      description:
        'Queues a message with one to three reply buttons. Buttons are an unofficial WhatsApp feature, so the gateway falls back to plain text if they are rejected.',
      security: API_SECURITY,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: buttonsNotifySchema } },
        },
      },
      responses: {
        202: {
          description: 'Queued in SQLite.',
          content: { 'application/json': { schema: queuedResponseSchema } },
        },
        400: errorResponse('Invalid JSON body or field.'),
        401: errorResponse('Missing or invalid API key.', { ok: false, error: 'Unauthorized' }),
        409: errorResponse('The tenant has not linked WhatsApp.', {
          ok: false,
          queued: false,
          error: 'not_connected',
        }),
      },
    }),
    (c) => {
      const body = c.req.valid('json')
      if (!options.sessions.isKnown(body.sessionId)) {
        return c.json({ ok: false as const, queued: false as const, error: 'not_connected' }, 409)
      }

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
      return c.json({ ok: true as const, queued: true as const, ...queued }, 202)
    },
  )

  return route
}
