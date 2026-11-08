import { fileURLToPath } from 'node:url'

import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import { secureHeaders } from 'hono/secure-headers'

import { htmlPage } from '../console/auth.js'
import { renderNotFound } from '../console/pages/auth-pages.js'
import { createConsoleApp } from '../console/router.js'
import type { ConsoleDependencies } from '../console/types.js'
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

const PUBLIC_DIR = fileURLToPath(new URL('../../public', import.meta.url))

export interface AppDependencies extends ConsoleDependencies {
  instanceId: string
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

  // Polaris-style console fonts and favicon. Everything else is inline.
  app.use('/fonts/*', serveStatic({ root: PUBLIC_DIR }))
  app.use('/favicon.svg', serveStatic({ root: PUBLIC_DIR }))

  // The console has its own cookie/email/password auth; do not put it behind
  // the API key middleware. The catch-all keeps unknown console URLs as HTML
  // instead of falling through to the API's 401.
  app.route('/console', createConsoleApp(dependencies))
  app.all('/console/*', () =>
    htmlPage(String(renderNotFound('Page not found', 'The console page may have moved.')), 404),
  )

  // Public liveness. The handler exposes session inventory only when the
  // caller presents the shared secret.
  app.route(
    '/health',
    healthRoutes({
      config: dependencies.config,
      sessions: dependencies.sessions,
      outbox: dependencies.outbox,
      apiKeys: dependencies.apiKeys,
      instanceId: dependencies.instanceId,
    }),
  )

  // Everything else requires the shared secret (when configured).
  app.use(
    '*',
    authMiddleware({
      envKey: dependencies.config.apiKey,
      keys: dependencies.apiKeys,
    }),
  )

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
