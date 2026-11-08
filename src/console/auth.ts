import type { Context, MiddlewareHandler } from 'hono'

import type { Config, ConsoleConfig } from '../config.js'
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

/**
 * SameSite guards most cross-site POSTs; this closes the rest.
 *
 * A reverse proxy may rewrite `Host` to the upstream container while the
 * browser still sends the public `Origin`. The check therefore accepts the
 * original/forwarded hosts, and falls back to the browser-controlled
 * `Sec-Fetch-Site` hint when a proxy has hidden the original host entirely.
 */
export function consoleCsrf(consoleConfig: ConsoleConfig): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD') return next()

    const site = c.req.header('sec-fetch-site')
    const origin = c.req.header('origin')

    // No Origin: an older client or a non-browser POST. SameSite=Lax keeps
    // the console cookie off cross-site POSTs, which is the real protection
    // for authenticated forms. Still refuse an explicit cross-site hint.
    if (!origin) {
      if (site === 'cross-site') return refuse(c, 'cross-site request without an origin')
      return next()
    }

    // Chrome sends `Origin: null` for a same-origin form when the page sets
    // Referrer-Policy: no-referrer (and in some privacy modes). The browser's
    // Sec-Fetch-Site hint, or a same-origin Referer, still proves the context.
    if (origin === 'null') {
      if (site === 'same-origin' || site === 'same-site') return next()
      const referer = c.req.header('referer')
      if (referer) {
        try {
          if (originMatchesRequest(new URL(referer), c, consoleConfig.publicUrl)) return next()
        } catch {
          // Fall through to the refusal.
        }
      }
      return refuse(c, 'opaque origin without a same-origin hint')
    }

    let originUrl: URL
    try {
      originUrl = new URL(origin)
    } catch {
      return refuse(c, 'malformed origin')
    }
    if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') {
      return refuse(c, 'non-http origin')
    }

    // An Origin that matches this request is authoritative. Check it before
    // Sec-Fetch-Site: a proxy that rewrites Host can make the browser's site
    // hint look wrong, and a matching Origin is the stronger signal.
    if (originMatchesRequest(originUrl, c, consoleConfig.publicUrl)) return next()

    // Browsers set this header; page JavaScript cannot forge it. If the
    // browser says the form is same-origin, a proxy has rewritten Host.
    if (site === 'same-origin' || site === 'same-site') return next()

    // Some older browsers omit Sec-Fetch-Site; the Referer is the fallback.
    const referer = c.req.header('referer')
    if (referer) {
      try {
        if (new URL(referer).origin === originUrl.origin) return next()
      } catch {
        // Fall through to the refusal.
      }
    }

    return refuse(c, 'origin does not match the request host')
  }
}

function refuse(c: Context<AppEnv>, reason: string): Response {
  c.get('logger').warn(
    {
      reason,
      origin: c.req.header('origin'),
      host: c.req.header('host'),
      forwardedHost: c.req.header('x-forwarded-host'),
      forwardedProto: c.req.header('x-forwarded-proto'),
      site: c.req.header('sec-fetch-site') ?? null,
    },
    'console CSRF check refused a request',
  )
  return terse(403, 'Cross-site request refused.')
}

function originMatchesRequest(origin: URL, c: Context<AppEnv>, publicUrl: string | null): boolean {
  if (publicUrl && origin.origin === publicUrl) return true

  const forwardedProto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim()
  const protocols = new Set(
    [forwardedProto, origin.protocol.slice(0, -1), new URL(c.req.url).protocol.slice(0, -1)].filter(
      (value): value is string => Boolean(value),
    ),
  )

  const hosts = new Set<string>()
  for (const name of ['host', 'x-forwarded-host', 'x-forwarded-server']) {
    const raw = c.req.header(name)
    if (!raw) continue
    for (const part of raw.split(',')) {
      const value = part.trim()
      if (value) hosts.add(value)
    }
  }
  try {
    hosts.add(new URL(c.req.url).host)
  } catch {
    // c.req.url is always absolute in Hono, but keep the guard.
  }

  for (const host of hosts) {
    for (const protocol of protocols) {
      try {
        if (new URL(`${protocol}://${host}`).origin === origin.origin) return true
      } catch {
        // Malformed forwarded host; try the next one.
      }
    }
  }

  // RFC 7239: Forwarded: for=…;host=example.com;proto=https
  const forwarded = c.req.header('forwarded')
  if (forwarded) {
    for (const entry of forwarded.split(',')) {
      const match = /(?:^|;)\s*host=("[^"]+"|[^;]+)/i.exec(entry)
      if (!match?.[1]) continue
      const host = match[1].replace(/^"|"$/g, '')
      for (const protocol of protocols) {
        try {
          if (new URL(`${protocol}://${host}`).origin === origin.origin) return true
        } catch {
          // Try the next value.
        }
      }
    }
  }

  return false
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
