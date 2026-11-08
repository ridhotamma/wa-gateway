import type { Context, MiddlewareHandler } from 'hono'

import type { Config } from '../config.js'
import type {
  ConsoleAdmin,
  ConsoleAuthStore,
  ConsoleSessionInfo,
} from '../services/console-auth.js'
import type { AppEnv } from '../http/types.js'
import { page } from './html.js'

export const CONSOLE_COOKIE = 'wa_console'

export interface ConsoleAuthDependencies {
  config: Config
  auth: ConsoleAuthStore
}

export interface ConsoleRequestSession {
  admin: ConsoleAdmin
  session: ConsoleSessionInfo
  token: string
}

const WINDOW_MS = 15 * 60_000
const MAX_ATTEMPTS = 10
const attempts = new Map<string, { count: number; resetAt: number }>()

export function loginRateLimited(key: string): boolean {
  if (attempts.size > 4_096) attempts.clear()
  const now = Date.now()
  const entry = attempts.get(key)
  if (!entry || entry.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS })
    return false
  }
  entry.count += 1
  return entry.count > MAX_ATTEMPTS
}

export function clearLoginAttempts(key: string): void {
  attempts.delete(key)
}

export function clientIp(c: Context): string {
  const forwarded = c.req.header('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0]?.trim() || 'unknown'
  return c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || 'unknown'
}

export function readConsoleSession(
  c: Context,
  dependencies: ConsoleAuthDependencies,
): ConsoleRequestSession | null {
  const token = cookieValue(c.req.header('cookie'), CONSOLE_COOKIE)
  if (!token) return null
  const resolved = dependencies.auth.resolve(token)
  if (!resolved) return null
  return { ...resolved, token }
}

export function requireConsoleSession(
  c: Context,
  dependencies: ConsoleAuthDependencies,
): ConsoleRequestSession {
  const session = readConsoleSession(c, dependencies)
  if (!session) throw new Error('Console session missing.')
  return session
}

export function consoleMiddleware(
  dependencies: ConsoleAuthDependencies,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!dependencies.config.console.enabled) {
      return new Response('Not found', { status: 404 })
    }

    const session = readConsoleSession(c, dependencies)
    if (!session) {
      const target = dependencies.auth.countAdmins() === 0 ? '/console/setup' : '/console/login'
      return c.redirect(target, 303)
    }

    return next()
  }
}

/** SameSite guards most cross-site POSTs; this closes the rest. */
export function consoleCsrf(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const origin = c.req.header('origin')
      if (origin) {
        try {
          if (new URL(origin).host !== c.req.header('host')) {
            return terse(403, 'Cross-site request refused.')
          }
        } catch {
          return terse(403, 'Cross-site request refused.')
        }
      }
      if (c.req.header('sec-fetch-site') === 'cross-site') {
        return terse(403, 'Cross-site request refused.')
      }
    }
    return next()
  }
}

export function setSessionCookie(c: Context, token: string, config: Config): void {
  const maxAge = Math.floor(config.console.sessionTtlMs / 1000)
  c.header(
    'Set-Cookie',
    `${CONSOLE_COOKIE}=${token}; Path=/console; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${
      config.isProduction ? '; Secure' : ''
    }`,
  )
}

export function clearSessionCookie(c: Context, config: Config): void {
  c.header(
    'Set-Cookie',
    `${CONSOLE_COOKIE}=; Path=/console; HttpOnly; SameSite=Lax; Max-Age=0${
      config.isProduction ? '; Secure' : ''
    }`,
  )
}

function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=') || null
  }
  return null
}

function terse(status: 403, message: string): Response {
  return new Response(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  })
}

export function htmlPage(body: string, status = 200): Response {
  return page(body, status)
}
