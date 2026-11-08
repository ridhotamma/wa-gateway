import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import { secureHeaders } from 'hono/secure-headers'

import type { Config } from '../config.js'
import type { Logger } from '../lib/logger.js'
import type { DirectSender } from '../services/direct-send.js'
import type { MediaStore } from '../services/media-store.js'
import type { Outbox } from '../services/outbox.js'
import type { SessionManager } from '../services/session-manager.js'
import { HttpError } from './errors.js'
import { authMiddleware } from './middleware/auth.js'
import { requestContext } from './middleware/request-context.js'
import { healthRoutes } from './routes/health.js'
import { messageRoutes } from './routes/messages.js'
import { notifyRoutes } from './routes/notify.js'
import { sessionRoutes } from './routes/sessions.js'
import type { AppEnv } from './types.js'

/**
 * The daemon's JSON bodies: text is small, but an outbound attachment arrives
 * as base64 and a 4 MB file is ~5.4 MB of JSON. Anything bigger is refused,
 * not buffered.
 */
export const MAX_BODY_BYTES = 8 * 1024 * 1024

export interface AppDependencies {
  config: Config
  logger: Logger
  instanceId: string
  sessions: SessionManager
  outbox: Outbox
  mediaStore: MediaStore
  directSender: DirectSender
}

export function createApp(dependencies: AppDependencies): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.use('*', requestContext(dependencies.logger))
  app.use('*', secureHeaders())
  app.use(
    '*',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json({ ok: false, error: 'Payload too large' }, 413),
    }),
  )

  // Public liveness. The handler exposes session inventory only when the
  // caller presents the shared secret.
  app.route(
    '/health',
    healthRoutes({
      config: dependencies.config,
      sessions: dependencies.sessions,
      outbox: dependencies.outbox,
      instanceId: dependencies.instanceId,
    }),
  )

  // Everything else requires the shared secret (when configured).
  app.use('*', authMiddleware(dependencies.config.apiKey))

  app.route(
    '/sessions',
    sessionRoutes({
      sessions: dependencies.sessions,
      outbox: dependencies.outbox,
      mediaStore: dependencies.mediaStore,
    }),
  )
  app.route(
    '/notify',
    notifyRoutes({
      sessions: dependencies.sessions,
      outbox: dependencies.outbox,
    }),
  )
  app.route('/messages', messageRoutes({ directSender: dependencies.directSender }))

  app.notFound((c) => c.json({ ok: false, error: 'Not found' }, 404))

  app.onError((error, c) => {
    if (error instanceof HttpError) {
      return c.json(
        {
          ok: false,
          error: error.message,
          ...(error.code ? { code: error.code } : {}),
        },
        error.status,
      )
    }
    if (error instanceof HTTPException) return error.getResponse()

    c.get('logger').error({ err: error }, 'unhandled request error')
    return c.json({ ok: false, error: 'Internal error' }, 500)
  })

  return app
}
