import { createRoute, OpenAPIHono } from '@hono/zod-openapi'

import type { Config } from '../../config.js'
import type { ApiKeyStore } from '../../services/api-key-store.js'
import type { Outbox } from '../../services/outbox.js'
import type { SessionManager } from '../../services/session-manager.js'
import { isAuthorized } from '../middleware/auth.js'
import { healthResponseSchema } from '../openapi.js'
import type { AppEnv } from '../types.js'

export interface HealthRoutesOptions {
  config: Config
  sessions: SessionManager
  outbox: Outbox
  apiKeys: ApiKeyStore
  instanceId: string
}

export function healthRoutes(options: HealthRoutesOptions): OpenAPIHono<AppEnv> {
  const route = new OpenAPIHono<AppEnv>()

  route.openapi(
    createRoute({
      method: 'get',
      path: '/',
      tags: ['Health'],
      summary: 'Liveness and session inventory',
      description:
        'Public liveness probe. When the request carries a valid API key, the response also includes the instance id, session inventory and outbox totals.',
      responses: {
        200: {
          description:
            'The gateway is running. Unauthenticated callers receive `status` and `uptime` only.',
          content: {
            'application/json': {
              schema: healthResponseSchema,
              example: { status: 'ok', uptime: 1234.5 },
            },
          },
        },
      },
    }),
    (c) => {
      // Public liveness only. Session inventory reveals tenant slugs, so it is
      // returned only to an authenticated caller.
      if (
        !isAuthorized(c.req.raw, {
          envKey: options.config.apiKey,
          keys: options.apiKeys,
        })
      ) {
        return c.json({ status: 'ok' as const, uptime: process.uptime() }, 200)
      }

      const sessions = options.sessions.listSessions()
      return c.json(
        {
          status: 'ok' as const,
          uptime: process.uptime(),
          instanceId: options.instanceId,
          authEnabled: options.config.apiKey !== '' || options.apiKeys.activeCount() > 0,
          sessionCount: sessions.length,
          readyCount: sessions.filter((session) => session.status === 'ready').length,
          outbox: options.outbox.totals(),
          sessions,
        },
        200,
      )
    },
  )

  return route
}
