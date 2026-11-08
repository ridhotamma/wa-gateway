import { Hono } from 'hono'

import type { Config } from '../../config.js'
import type { Outbox } from '../../services/outbox.js'
import type { SessionManager } from '../../services/session-manager.js'
import { isAuthorized } from '../middleware/auth.js'
import type { AppEnv } from '../types.js'

export interface HealthRoutesOptions {
  config: Config
  sessions: SessionManager
  outbox: Outbox
  instanceId: string
}

export function healthRoutes(options: HealthRoutesOptions): Hono<AppEnv> {
  const route = new Hono<AppEnv>()

  route.get('/', (c) => {
    // Public liveness only. Session inventory reveals tenant slugs, so it is
    // returned only to an authenticated caller.
    if (!isAuthorized(c.req.raw, options.config.apiKey)) {
      return c.json({ status: 'ok', uptime: process.uptime() })
    }

    const sessions = options.sessions.listSessions()
    return c.json({
      status: 'ok',
      uptime: process.uptime(),
      instanceId: options.instanceId,
      authEnabled: options.config.apiKey !== '',
      sessionCount: sessions.length,
      readyCount: sessions.filter((session) => session.status === 'ready').length,
      outbox: options.outbox.totals(),
      sessions,
    })
  })

  return route
}
