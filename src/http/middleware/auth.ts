import { timingSafeEqual } from 'node:crypto'

import type { MiddlewareHandler } from 'hono'

import type { ApiKeyStore } from '../../services/api-key-store.js'
import type { AppEnv } from '../types.js'

export interface ApiAuthOptions {
  /** Permanent bootstrap key from the environment. */
  envKey: string
  keys: ApiKeyStore
}

/**
 * Accept `Authorization: Bearer <key>` or `x-api-key: <key>`.
 *
 * The environment key is compared in constant time. Console-created keys are
 * looked up by SHA-256 hash, never stored in plaintext. When neither exists
 * (development only) requests are allowed, preserving the old local setup.
 */
export function isAuthorized(request: Request, options: ApiAuthOptions): boolean {
  const provided = apiKeyFrom(request)
  if (!provided) return !options.envKey && options.keys.activeCount() === 0

  if (options.envKey && timingSafeCompare(provided, options.envKey)) return true
  return options.keys.verify(provided) !== null
}

export function authMiddleware(options: ApiAuthOptions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (isAuthorized(c.req.raw, options)) return next()
    return c.json({ ok: false, error: 'Unauthorized' }, 401)
  }
}

function apiKeyFrom(request: Request): string | null {
  const bearer = request.headers.get('authorization')
  if (bearer?.startsWith('Bearer ')) return bearer.slice(7)
  return request.headers.get('x-api-key')
}

function timingSafeCompare(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a)
  const bBuffer = Buffer.from(b)
  if (aBuffer.length !== bBuffer.length) return false
  return timingSafeEqual(aBuffer, bBuffer)
}
