import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'

import type { MediaStore } from '../../services/media-store.js'
import type { Outbox } from '../../services/outbox.js'
import type { ActiveSession, SessionManager } from '../../services/session-manager.js'
import { HttpError } from '../errors.js'
import { attachmentDisposition, safeContentType } from '../headers.js'
import {
  API_SECURITY,
  binaryResponseSchema,
  errorResponse,
  mediaIdParamSchema,
  okResponseSchema,
  sessionIdParamSchema,
  sessionStatusSchema,
  sessionViewSchema,
  startSessionResponseSchema,
} from '../openapi.js'
import { renameSchema } from '../schemas.js'
import type { AppEnv } from '../types.js'
import { parseMediaId, parseSessionId } from '../validation.js'

export interface SessionRoutesOptions {
  sessions: SessionManager
  outbox: Outbox
  mediaStore: MediaStore
}

const sessionParamsSchema = z.object({ sessionId: sessionIdParamSchema })
const mediaParamsSchema = z.object({
  sessionId: sessionIdParamSchema,
  mediaId: mediaIdParamSchema,
})

export function sessionRoutes(options: SessionRoutesOptions): OpenAPIHono<AppEnv> {
  const route = new OpenAPIHono<AppEnv>()

  // GET /sessions/:sessionId/media/:mediaId — fetch a spooled inbound
  // attachment after the daemon has already downloaded it.
  //
  // Registered manually: the binary 200 makes the typed-response helper
  // awkward, while the plain handler already returns a raw Response.
  route.openAPIRegistry.registerPath({
    method: 'get',
    path: '/{sessionId}/media/{mediaId}',
    tags: ['Sessions'],
    summary: 'Download an inbound attachment',
    description:
      'Returns the bytes the daemon spooled for an inbound message. The spool is temporary and size-capped; fetch attachments promptly after the webhook arrives.',
    security: API_SECURITY,
    request: { params: mediaParamsSchema },
    responses: {
      200: {
        description: 'Raw attachment bytes.',
        content: { 'application/octet-stream': { schema: binaryResponseSchema } },
      },
      400: errorResponse('Invalid session or media id.'),
      401: errorResponse('Missing or invalid API key.', { ok: false, error: 'Unauthorized' }),
      404: errorResponse('The attachment is not in the spool.', {
        ok: false,
        error: 'Media not found',
      }),
    },
  })
  route.get('/:sessionId/media/:mediaId', async (c) => {
    const sessionId = parseSessionId(c.req.param('sessionId'))
    const mediaId = parseMediaId(c.req.param('mediaId'))
    const stored = await options.mediaStore.read(sessionId, mediaId)
    if (!stored) throw new HttpError(404, 'Media not found')

    return c.body(new Uint8Array(stored.data), 200, {
      'Content-Type': safeContentType(stored.media.mimetype),
      'Content-Length': String(stored.data.byteLength),
      'Content-Disposition': attachmentDisposition(
        stored.media.filename ?? `${stored.media.kind}-${stored.media.id}`,
      ),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    })
  })

  // POST /sessions/:sessionId/start
  route.openapi(
    createRoute({
      method: 'post',
      path: '/{sessionId}/start',
      tags: ['Sessions'],
      summary: 'Start pairing or reconnect a session',
      description:
        'Starts the Baileys socket and returns immediately. Poll `GET /sessions/{sessionId}/status` for `qrDataUrl` while `status` is `qr_ready`, and until it becomes `ready`.',
      security: API_SECURITY,
      request: { params: sessionParamsSchema },
      responses: {
        200: {
          description: 'The running session. A second call returns the existing session.',
          content: { 'application/json': { schema: startSessionResponseSchema } },
        },
        400: errorResponse('Invalid session id.'),
        401: errorResponse('Missing or invalid API key.', { ok: false, error: 'Unauthorized' }),
      },
    }),
    async (c) => {
      const { sessionId } = c.req.valid('param')
      const session = await options.sessions.startSession(sessionId)
      return c.json({ ok: true as const, session: sessionView(session) }, 200)
    },
  )

  // GET /sessions/:sessionId/status
  route.openapi(
    createRoute({
      method: 'get',
      path: '/{sessionId}/status',
      tags: ['Sessions'],
      summary: 'Read session and outbox status',
      description:
        'While `qrDataUrl` is present, render it for the operator to scan. A paired session waiting for boot restore reports `initializing` with reason `pending_restore`.',
      security: API_SECURITY,
      request: { params: sessionParamsSchema },
      responses: {
        200: {
          description: 'Current status and outbox counters.',
          content: { 'application/json': { schema: sessionStatusSchema } },
        },
        400: errorResponse('Invalid session id.'),
        401: errorResponse('Missing or invalid API key.', { ok: false, error: 'Unauthorized' }),
        404: errorResponse('Unknown session.', { ok: false, error: 'Session not found' }),
      },
    }),
    (c) => {
      const { sessionId } = c.req.valid('param')
      const session = options.sessions.getSession(sessionId)

      if (!session) {
        // Paired but not reconnected yet (boot restore is staggered): report it
        // as coming up, not as unknown — callers treat 404 as "unlinked".
        if (options.sessions.isKnown(sessionId)) {
          return c.json(
            {
              ok: true as const,
              session: {
                sessionId,
                engineType: 'baileys' as const,
                status: 'initializing' as const,
                lastReason: 'pending_restore',
                outbox: options.outbox.stats(sessionId),
              },
            },
            200,
          )
        }
        return c.json({ ok: false as const, error: 'Session not found' }, 404)
      }

      return c.json(
        {
          ok: true as const,
          session: {
            ...sessionView(session),
            outbox: options.outbox.stats(sessionId),
          },
        },
        200,
      )
    },
  )

  // POST /sessions/:sessionId/logout
  route.openapi(
    createRoute({
      method: 'post',
      path: '/{sessionId}/logout',
      tags: ['Sessions'],
      summary: 'Unlink a session',
      description:
        'Logs out and deletes the stored WhatsApp credentials. The tenant must scan a new QR code before it can send again.',
      security: API_SECURITY,
      request: { params: sessionParamsSchema },
      responses: {
        200: {
          description: 'The session is unlinked.',
          content: { 'application/json': { schema: okResponseSchema } },
        },
        400: errorResponse('Invalid session id.'),
        401: errorResponse('Missing or invalid API key.', { ok: false, error: 'Unauthorized' }),
      },
    }),
    async (c) => {
      const { sessionId } = c.req.valid('param')
      await options.sessions.logoutSession(sessionId)
      return c.json({ ok: true as const }, 200)
    },
  )

  // POST /sessions/:sessionId/rename  { to }
  route.openapi(
    createRoute({
      method: 'post',
      path: '/{sessionId}/rename',
      tags: ['Sessions'],
      summary: 'Rename a tenant slug',
      description:
        'Moves the credentials and outbox jobs to a new slug and reconnects without another QR scan. Renaming to the current slug is a no-op.',
      security: API_SECURITY,
      request: {
        params: sessionParamsSchema,
        body: { required: true, content: { 'application/json': { schema: renameSchema } } },
      },
      responses: {
        200: {
          description: 'The rename was applied.',
          content: { 'application/json': { schema: okResponseSchema } },
        },
        400: errorResponse('Invalid session id or body.'),
        401: errorResponse('Missing or invalid API key.', { ok: false, error: 'Unauthorized' }),
        409: errorResponse('The target slug is already in use.', {
          ok: false,
          error: 'A session named "new-shop" already exists.',
        }),
      },
    }),
    async (c) => {
      const { sessionId } = c.req.valid('param')
      const body = c.req.valid('json')
      if (body.to === sessionId) return c.json({ ok: true as const }, 200)

      try {
        await options.sessions.renameSession(sessionId, body.to)
        options.outbox.renameSession(sessionId, body.to)
      } catch (error) {
        throw new HttpError(409, error instanceof Error ? error.message : 'Rename failed.')
      }

      return c.json({ ok: true as const }, 200)
    },
  )

  return route
}

function sessionView(session: ActiveSession) {
  return {
    sessionId: session.sessionId,
    engineType: 'baileys' as const,
    status: session.status,
    qrDataUrl: session.qrDataUrl,
    lastReason: session.lastStatusReason,
  }
}
