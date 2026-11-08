import { timingSafeEqual } from 'node:crypto'

import type { MiddlewareHandler } from 'hono'

import type { AppEnv } from '../types.js'

/**
 * Accept `Authorization: Bearer <key>` or `x-api-key: <key>`. Both are
 * compared in constant time. An empty configured key means development mode,
 * where every request is allowed.
 */
export function isAuthorized(request: Request, apiKey: string): boolean {
  if (!apiKey) return true

  const bearer = request.headers.get('authorization')
  if (bearer?.startsWith('Bearer ') && timingSafeCompare(bearer.slice(7), apiKey)) {
    return true
  }

  const header = request.headers.get('x-api-key')
  return header ? timingSafeCompare(header, apiKey) : false
}

export function authMiddleware(apiKey: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (isAuthorized(c.req.raw, apiKey)) return next()
    return c.json({ ok: false, error: 'Unauthorized' }, 401)
  }
}

function timingSafeCompare(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a)
  const bBuffer = Buffer.from(b)
  if (aBuffer.length !== bBuffer.length) return false
  return timingSafeEqual(aBuffer, bBuffer)
}
