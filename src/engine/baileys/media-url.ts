/**
 * Outbound media URL guard.
 *
 * Baileys fetches a remote attachment from whatever URL a caller supplies.
 * The daemon is an authenticated internal service, but a compromised app or a
 * mistaken template must not be able to make it probe loopback, private
 * networks or cloud metadata endpoints. This blocks literal private addresses
 * and also resolves hostnames so DNS tricks cannot bypass the check.
 *
 * Redirects are followed by the fetch inside Baileys, so this is not a full
 * SSRF sandbox. It closes the practical hole without adding an HTTP proxy.
 */

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { UnsafeMediaUrlError } from '../errors.js'

const MAX_MEDIA_URL_LENGTH = 4_096

function privateIpv4(address: string): boolean {
  const [a, b] = address.split('.').map(Number)
  if (a === undefined || b === undefined) return true
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  )
}

function privateIpv6(address: string): boolean {
  const lower = address.toLowerCase()
  if (lower === '::' || lower === '::1') return true
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true
  if (/^fe[89ab]/.test(lower)) return true
  if (lower.startsWith('::ffff:')) return privateIpv4(lower.slice('::ffff:'.length))
  return false
}

function privateAddress(address: string): boolean {
  if (isIP(address) === 4) return privateIpv4(address)
  if (isIP(address) === 6) return privateIpv6(address)
  return true
}

function privateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host === 'metadata.google.internal'
  )
}

/** Validate a remote attachment URL before handing it to Baileys. */
export async function assertSafeMediaUrl(raw: string): Promise<string> {
  if (raw.length > MAX_MEDIA_URL_LENGTH) {
    throw new UnsafeMediaUrlError('Media URL is too long.')
  }

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new UnsafeMediaUrlError('Media URL is invalid.')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new UnsafeMediaUrlError('Media URL must use HTTP or HTTPS.')
  }
  if (url.protocol === 'http:' && process.env.NODE_ENV === 'production') {
    throw new UnsafeMediaUrlError('Media URL must use HTTPS in production.')
  }
  if (!url.hostname) throw new UnsafeMediaUrlError('Media URL has no host.')
  if (url.username || url.password) {
    throw new UnsafeMediaUrlError('Media URL must not contain credentials.')
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (privateHostname(hostname)) {
    throw new UnsafeMediaUrlError('Media URL points at a private host.')
  }
  if (isIP(hostname)) {
    if (privateAddress(hostname)) {
      throw new UnsafeMediaUrlError('Media URL points at a private address.')
    }
    return raw
  }

  let resolved: Array<{ address: string }>
  try {
    resolved = await lookup(hostname, { all: true, verbatim: true })
  } catch (error) {
    // A temporary resolver outage should be retried, not treated as a
    // permanently unsafe URL.
    throw new Error(`Media URL host could not be resolved: ${(error as Error).message}`)
  }
  if (resolved.length === 0 || resolved.some((entry) => privateAddress(entry.address))) {
    throw new UnsafeMediaUrlError('Media URL resolves to a private address.')
  }

  return raw
}
