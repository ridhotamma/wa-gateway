import { Hono } from 'hono'

import type { Outbox } from '../../services/outbox.js'
import type { ActiveSession, SessionManager } from '../../services/session-manager.js'
import type { MediaStore } from '../../services/media-store.js'
import { HttpError } from '../errors.js'
import { attachmentDisposition, safeContentType } from '../headers.js'
import { renameSchema } from '../schemas.js'
import type { AppEnv } from '../types.js'
import { parseBody, parseMediaId, parseSessionId } from '../validation.js'

export interface SessionRoutesOptions {
  sessions: SessionManager
  outbox: Outbox
  mediaStore: MediaStore
}

export function sessionRoutes(options: SessionRoutesOptions): Hono<AppEnv> {
  const route = new Hono<AppEnv>()

  // GET /sessions/:sessionId/media/:mediaId — fetch a spooled inbound
  // attachment after the daemon has already downloaded it.
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
  route.post('/:sessionId/start', async (c) => {
    const sessionId = parseSessionId(c.req.param('sessionId'))
    const session = await options.sessions.startSession(sessionId)
    return c.json({ ok: true, session: sessionView(session) })
  })

  // GET /sessions/:sessionId/status
  route.get('/:sessionId/status', (c) => {
    const sessionId = parseSessionId(c.req.param('sessionId'))
    const session = options.sessions.getSession(sessionId)

    if (!session) {
      // Paired but not reconnected yet (boot restore is staggered): report it
      // as coming up, not as unknown — callers treat 404 as "unlinked".
      if (options.sessions.isKnown(sessionId)) {
        return c.json({
          ok: true,
          session: {
            sessionId,
            engineType: 'baileys' as const,
            status: 'initializing' as const,
            lastReason: 'pending_restore',
            outbox: options.outbox.stats(sessionId),
          },
        })
      }
      return c.json({ ok: false, error: 'Session not found' }, 404)
    }

    return c.json({
      ok: true,
      session: {
        ...sessionView(session),
        outbox: options.outbox.stats(sessionId),
      },
    })
  })

  // POST /sessions/:sessionId/logout
  route.post('/:sessionId/logout', async (c) => {
    const sessionId = parseSessionId(c.req.param('sessionId'))
    await options.sessions.logoutSession(sessionId)
    return c.json({ ok: true })
  })

  // POST /sessions/:sessionId/rename  { to }
  route.post('/:sessionId/rename', async (c) => {
    const sessionId = parseSessionId(c.req.param('sessionId'))
    const body = await parseBody(c, renameSchema)
    if (body.to === sessionId) return c.json({ ok: true })

    try {
      await options.sessions.renameSession(sessionId, body.to)
      options.outbox.renameSession(sessionId, body.to)
    } catch (error) {
      throw new HttpError(409, error instanceof Error ? error.message : 'Rename failed.')
    }

    return c.json({ ok: true })
  })

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
