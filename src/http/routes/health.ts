import { Hono } from 'hono'

import type { Config } from '../../config.js'
import type { ApiKeyStore } from '../../services/api-key-store.js'
import type { Outbox } from '../../services/outbox.js'
import type { SessionManager } from '../../services/session-manager.js'
import { isAuthorized } from '../middleware/auth.js'
import type { AppEnv } from '../types.js'

export interface HealthRoutesOptions {
  config: Config
  sessions: SessionManager
  outbox: Outbox
  apiKeys: ApiKeyStore
  instanceId: string
}

export function healthRoutes(options: HealthRoutesOptions): Hono<AppEnv> {
  const route = new Hono<AppEnv>()

  route.get('/', (c) => {
    // Public liveness only. Session inventory reveals tenant slugs, so it is
    // returned only to an authenticated caller.
    if (
      !isAuthorized(c.req.raw, {
        envKey: options.config.apiKey,
        keys: options.apiKeys,
      })
    ) {
      return c.json({ status: 'ok', uptime: process.uptime() })
    }

    const sessions = options.sessions.listSessions()
    return c.json({
      status: 'ok',
      uptime: process.uptime(),
      instanceId: options.instanceId,
      authEnabled: options.config.apiKey !== '' || options.apiKeys.activeCount() > 0,
      sessionCount: sessions.length,
      readyCount: sessions.filter((session) => session.status === 'ready').length,
      outbox: options.outbox.totals(),
      sessions,
    })
  })

  return route
}
