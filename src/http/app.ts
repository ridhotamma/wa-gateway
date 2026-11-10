import { fileURLToPath } from 'node:url'

import { OpenAPIHono, type Hook } from '@hono/zod-openapi'
import { Scalar } from '@scalar/hono-api-reference'
import { serveStatic } from '@hono/node-server/serve-static'
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

export function createApp(dependencies: AppDependencies): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>({ defaultHook: validationError })

  app.openAPIRegistry.registerComponent('securitySchemes', 'apiKey', {
    type: 'apiKey',
    in: 'header',
    name: 'x-api-key',
    description: 'A key created in the console, or the bootstrap `WHATSAPP_API_KEY`.',
  })
  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    description: 'The same API key, sent as `Authorization: Bearer <key>`.',
  })

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

  // The OpenAPI document and its reference UI stay public: they contain no
  // secrets, and the API key is entered in the UI, not fetched with the page.
  app.doc('/openapi.json', {
    openapi: '3.0.0',
    info: {
      title: 'WhatsApp Gateway API',
      version: '1.1.0',
      description: [
        'REST API for the self-hosted WhatsApp gateway.',
        'All endpoints except `GET /health` require an API key, sent as `x-api-key: <key>` or `Authorization: Bearer <key>`. When no key is configured (development only), requests are allowed.',
        'Use the queued `/notify/*` endpoints for integrations: they return `202` immediately and the durable SQLite outbox retries and paces delivery. Use `/messages/*` for direct sends that report the result inline.',
      ].join('\n\n'),
    },
    servers: [{ url: '/', description: 'This gateway' }],
    tags: [
      { name: 'Health', description: 'Liveness and inventory.' },
      { name: 'Sessions', description: 'Pair, inspect, rename and unlink WhatsApp sessions.' },
      {
        name: 'Notifications',
        description: 'Durable queued messages, retried and paced by the outbox.',
      },
      { name: 'Messages', description: 'Direct sends through a ready session.' },
    ],
  })

  app.get(
    '/docs',
    Scalar({
      url: '/openapi.json',
      pageTitle: 'WhatsApp Gateway API',
      theme: 'default',
      authentication: { preferredSecurityScheme: 'apiKey' },
      defaultOpenAllTags: true,
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
    if (error instanceof HTTPException) {
      // The JSON validator reports malformed bodies before our hook runs.
      if (error.status === 400 && error.message === 'Malformed JSON in request body') {
        return c.json({ ok: false, error: 'Invalid JSON body.' }, 400)
      }
      return error.getResponse()
    }

    c.get('logger').error({ err: error }, 'unhandled request error')
    return c.json({ ok: false, error: 'Internal error' }, 500)
  })

  return app
}

/**
 * Keep the API's existing validation contract: a 400 with one field-specific
 * message rather than Zod's full issue list.
 */
const validationError: Hook<any, AppEnv, any, any> = (result, c) => {
  if (result.success) return

  if (result.target === 'param') {
    const field = result.error.issues[0]?.path.join('.') ?? ''
    if (field === 'mediaId') return c.json({ ok: false, error: 'Invalid media id.' }, 400)
    return c.json({ ok: false, error: 'Invalid sessionId. Use 1-64 chars of [a-zA-Z0-9_-].' }, 400)
  }

  const issue = result.error.issues[0]
  const field = issue?.path.join('.') || '(root)'
  return c.json({ ok: false, error: `Invalid body: ${field} ${issue?.message ?? ''}`.trim() }, 400)
}
