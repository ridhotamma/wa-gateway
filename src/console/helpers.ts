import type { Context } from 'hono'

import type { EngineStatus } from '../engine/index.js'
import type { Html } from './html.js'
import type { Flash } from './layout.js'
import { badge } from './ui.js'

export function flashFrom(c: Context): Flash {
  const ok = c.req.query('ok')
  if (ok) return { tone: 'success', text: ok }
  const err = c.req.query('err')
  if (err) return { tone: 'critical', text: err }
  const warn = c.req.query('warn')
  if (warn) return { tone: 'warning', text: warn }
  return null
}

export function redirectFlash(
  c: Context,
  path: string,
  tone: 'success' | 'critical' | 'warning' | 'info',
  text: string,
): Response {
  const key = tone === 'success' ? 'ok' : tone === 'warning' ? 'warn' : 'err'
  const separator = path.includes('?') ? '&' : '?'
  return c.redirect(`${path}${separator}${key}=${encodeURIComponent(text)}`, 303)
}

export function formString(
  body: Record<string, string | File>,
  name: string,
  fallback = '',
): string {
  const value = body[name]
  return typeof value === 'string' ? value : fallback
}

export function formNumber(
  body: Record<string, string | File>,
  name: string,
  fallback: number,
  options: { min?: number; max?: number } = {},
): number {
  const raw = formString(body, name).trim()
  if (!raw) return fallback
  const value = Number(raw)
  const min = options.min ?? 0
  const max = options.max ?? Number.MAX_SAFE_INTEGER
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}.`)
  }
  return value
}

export function formInteger(
  body: Record<string, string | File>,
  name: string,
  fallback: number,
  options: { min?: number; max?: number } = {},
): number {
  const value = formNumber(body, name, fallback, options)
  if (!Number.isInteger(value)) throw new Error(`${name} must be a whole number.`)
  return value
}

export function formBool(
  body: Record<string, string | File>,
  name: string,
  fallback = false,
): boolean {
  const value = body[name]
  if (value === undefined) return fallback
  return value === 'on' || value === 'true' || value === '1'
}

export function optionalText(value: string): string | null {
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

export function engineBadge(status: string | null | undefined): Html {
  const tone =
    status === 'ready'
      ? 'success'
      : status === 'failed'
        ? 'critical'
        : status === 'qr_ready'
          ? 'attention'
          : status
            ? 'info'
            : ''
  return badge(status ? status.replaceAll('_', ' ') : 'not connected', tone)
}

export function engineStatusTone(status: EngineStatus | null | undefined): string {
  if (status === 'ready') return 'success'
  if (status === 'failed') return 'critical'
  if (status === 'qr_ready') return 'attention'
  return 'info'
}

export function when(iso: string | null | undefined): string {
  if (!iso) return '—'
  return iso.slice(0, 16).replace('T', ' ')
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—'
  const diff = Date.now() - Date.parse(iso)
  if (!Number.isFinite(diff) || diff < 0) return when(iso)
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${unit === 0 ? Math.round(value) : value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`
}

export function sessionPath(sessionId: string): string {
  return `/console/sessions/${encodeURIComponent(sessionId)}`
}
