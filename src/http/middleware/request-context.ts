import { randomUUID } from 'node:crypto'

import type { MiddlewareHandler } from 'hono'

import type { Logger } from '../../lib/logger.js'
import type { AppEnv } from '../types.js'

/**
 * Give every request a stable id and a child logger, then log one line with
 * its status and duration. The id is echoed as `x-request-id`, so a log line
 * can be tied to a caller's report.
 */
export function requestContext(logger: Logger): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const requestId = c.req.header('x-request-id')?.slice(0, 128) || randomUUID()
    const log = logger.child({
      requestId,
      method: c.req.method,
      path: new URL(c.req.url).pathname,
    })

    c.set('logger', log)
    c.set('requestId', requestId)
    c.header('x-request-id', requestId)

    const startedAt = performance.now()
    try {
      await next()
    } catch (error) {
      log.error({ err: error }, 'request failed')
      throw error
    }

    log.info(
      {
        status: c.res.status,
        durationMs: Math.round(performance.now() - startedAt),
      },
      'request',
    )
  }
}
