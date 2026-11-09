import { existsSync } from 'node:fs'
import path from 'node:path'

import { statusUrlFromInbound } from './lib/callbacks.js'

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent'

export interface TypingConfig {
  minMs: number
  maxMs: number
  msPerChar: number
  jitterRatio: number
}

export interface InboundConfig {
  /** Full callback template or base origin. Null disables forwarding. */
  urlTemplate: string | null
  statusUrlTemplate: string | null
  timeoutMs: number
  statusTimeoutMs: number
  /** Largest attachment the engine downloads before forwarding metadata only. */
  mediaMaxBytes: number
  /** Total bytes the inbound spool may hold before the oldest files are dropped. */
  mediaSpoolMaxBytes: number
  mediaTtlMs: number
}

export interface OutboxConfig {
  sendGapMs: number
  sendJitterMs: number
  hourlyCap: number
  maxAgeMs: number
  maxAttempts: number
}

export interface ConsoleConfig {
  enabled: boolean
  /** Bootstrap admin, created only when the database has no admins yet. */
  email: string | null
  password: string | null
  sessionTtlMs: number
  /**
   * The public console origin. Used to validate form posts when a reverse
   * proxy rewrites Host. Derived from WHATSAPP_DOMAIN when not set.
   */
  publicUrl: string | null
}

export type ApiKeySource = 'env' | 'generated' | 'none'

export interface Config {
  nodeEnv: 'development' | 'test' | 'production'
  isProduction: boolean
  host: string
  port: number
  logLevel: LogLevel
  /**
   * Shared secret. Empty only in development; production generates and
   * persists one on first boot when the environment value is missing.
   */
  apiKey: string
  /** Where `apiKey` came from. */
  apiKeySource: ApiKeySource
  /** File holding a generated bootstrap key, when apiKeySource is generated. */
  apiKeyFile: string | null
  /** SQLite database: settings, keys, admins, outbox, credentials, audit. */
  databasePath: string
  /** Attachment bytes stay on disk; their metadata is in SQLite. */
  mediaDir: string
  console: ConsoleConfig
  restoreOnBoot: boolean
  restoreDelayMs: number
  pairingTimeoutMs: number
  typing: TypingConfig | null
  inbound: InboundConfig
  outbox: OutboxConfig
  baileysLogLevel: LogLevel
}

const DEFAULT_TYPING: TypingConfig = {
  minMs: 1_200,
  maxMs: 8_000,
  msPerChar: 35,
  jitterRatio: 0.2,
}

const LOG_LEVELS = new Set<LogLevel>(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])

/**
 * Load `.env.local` then `.env` from the working directory. Node never
 * overrides a variable that already exists, so real environment variables and
 * `.env.local` win over `.env`.
 */
export function loadEnvFiles(cwd = process.cwd()): void {
  for (const file of ['.env.local', '.env']) {
    const fullPath = path.join(cwd, file)
    if (!existsSync(fullPath)) continue
    try {
      process.loadEnvFile(fullPath)
    } catch (error) {
      console.warn(`[config] could not load ${fullPath}: ${String(error)}`)
    }
  }
}

/**
 * Read and validate the process configuration once, at startup. Unknown or
 * malformed values fail fast: a daemon that starts with a bad hourly cap is
 * worse than one that refuses to start.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
): Config {
  const nodeEnv = readNodeEnv(env.NODE_ENV)
  const isProduction = nodeEnv === 'production'
  const apiKey = value(env.WHATSAPP_API_KEY) ?? ''

  const inboundUrl = value(env.WHATSAPP_INBOUND_URL)
  const typingEnabled = readBoolean(env, 'WHATSAPP_TYPING', true)
  const configuredDomain = value(env.WHATSAPP_DOMAIN)
  const derivedConsoleUrl = configuredDomain
    ? configuredDomain.includes('://')
      ? configuredDomain
      : `https://${configuredDomain}`
    : null

  return {
    nodeEnv,
    isProduction,
    host: value(env.HOST) ?? '0.0.0.0',
    port: readNumber(env, 'PORT', 3005, { min: 0, max: 65_535 }),
    logLevel: readLogLevel(env, 'WHATSAPP_LOG_LEVEL', value(env.LOG_LEVEL), 'info'),
    apiKey,
    apiKeySource: apiKey ? 'env' : 'none',
    apiKeyFile: null,
    databasePath: resolvePath(cwd, value(env.WHATSAPP_DATABASE_PATH), '.whatsapp-data/gateway.db'),
    mediaDir: resolvePath(cwd, value(env.WHATSAPP_MEDIA_DIR), '.whatsapp-data/media'),
    console: {
      enabled: readBoolean(env, 'WHATSAPP_CONSOLE_ENABLED', true),
      email: value(env.WHATSAPP_CONSOLE_EMAIL)?.toLowerCase() ?? null,
      password: value(env.WHATSAPP_CONSOLE_PASSWORD),
      sessionTtlMs:
        readNumber(env, 'WHATSAPP_CONSOLE_SESSION_HOURS', 24 * 7, { min: 1, max: 24 * 365 }) *
        60 *
        60_000,
      publicUrl: publicOrigin(
        value(env.WHATSAPP_CONSOLE_URL) ?? derivedConsoleUrl,
        'WHATSAPP_CONSOLE_URL',
      ),
    },
    restoreOnBoot: readBoolean(env, 'WHATSAPP_RESTORE', true),
    restoreDelayMs: readNumber(env, 'WHATSAPP_RESTORE_DELAY_MS', 1_500),
    pairingTimeoutMs: readNumber(env, 'WHATSAPP_PAIRING_TIMEOUT_MS', 180_000),
    typing: typingEnabled
      ? {
          minMs: readNumber(env, 'WHATSAPP_TYPING_MIN_MS', DEFAULT_TYPING.minMs),
          maxMs: readNumber(env, 'WHATSAPP_TYPING_MAX_MS', DEFAULT_TYPING.maxMs),
          msPerChar: readNumber(env, 'WHATSAPP_TYPING_MS_PER_CHAR', DEFAULT_TYPING.msPerChar),
          jitterRatio: readNumber(env, 'WHATSAPP_TYPING_JITTER_RATIO', DEFAULT_TYPING.jitterRatio, {
            max: 1,
          }),
        }
      : null,
    inbound: {
      urlTemplate: inboundUrl,
      statusUrlTemplate: value(env.WHATSAPP_STATUS_URL) ?? statusUrlFromInbound(inboundUrl),
      timeoutMs: readNumber(env, 'WHATSAPP_INBOUND_TIMEOUT_MS', 3_000),
      statusTimeoutMs: readNumber(env, 'WHATSAPP_STATUS_TIMEOUT_MS', 3_000),
      mediaMaxBytes: readNumber(env, 'WHATSAPP_INBOUND_MEDIA_MAX_BYTES', 16 * 1024 * 1024),
      mediaSpoolMaxBytes: readNumber(env, 'WHATSAPP_MEDIA_MAX_BYTES', 512 * 1024 * 1024),
      mediaTtlMs: readNumber(env, 'WHATSAPP_MEDIA_TTL_MS', 24 * 60 * 60_000),
    },
    outbox: {
      sendGapMs: readNumber(env, 'WHATSAPP_SEND_GAP_MS', 3_000),
      sendJitterMs: readNumber(env, 'WHATSAPP_SEND_JITTER_MS', 2_000),
      hourlyCap: readNumber(env, 'WHATSAPP_HOURLY_CAP', 120),
      maxAgeMs: readNumber(env, 'WHATSAPP_OUTBOX_MAX_AGE_MS', 24 * 60 * 60_000),
      maxAttempts: readNumber(env, 'WHATSAPP_OUTBOX_MAX_ATTEMPTS', 8),
    },
    baileysLogLevel: readLogLevel(env, 'WHATSAPP_BAILEYS_LOG_LEVEL', undefined, 'silent'),
  }
}

function value(raw: string | undefined): string | null {
  const trimmed = raw?.trim()
  return trimmed ? trimmed : null
}

function resolvePath(cwd: string, raw: string | null, fallback: string): string {
  return path.resolve(cwd, raw ?? fallback)
}

function publicOrigin(raw: string | null, name: string): string | null {
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('bad protocol')
    return url.origin
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL (got "${raw}").`)
  }
}

function readNodeEnv(raw: string | undefined): Config['nodeEnv'] {
  const normalized = raw?.trim().toLowerCase()
  if (!normalized) return 'development'
  if (normalized === 'production' || normalized === 'test' || normalized === 'development') {
    return normalized
  }
  throw new Error(`NODE_ENV must be development, test or production (got "${raw}").`)
}

function readNumber(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  options: { min?: number; max?: number } = {},
): number {
  const raw = value(env[name])
  if (raw === null) return fallback

  const parsed = Number(raw)
  const min = options.min ?? 0
  const max = options.max ?? Number.MAX_SAFE_INTEGER
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max} (got "${raw}").`)
  }
  return parsed
}

function readBoolean(
  env: Record<string, string | undefined>,
  name: string,
  fallback: boolean,
): boolean {
  const raw = value(env[name])?.toLowerCase()
  if (raw == null) return fallback
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true
  if (['0', 'false', 'no', 'off'].includes(raw)) return false
  throw new Error(`${name} must be true or false (got "${raw}").`)
}

function readLogLevel(
  env: Record<string, string | undefined>,
  name: string,
  override: string | null | undefined,
  fallback: LogLevel,
): LogLevel {
  const raw = (override ?? value(env[name]) ?? fallback).toLowerCase()
  if (!LOG_LEVELS.has(raw as LogLevel)) {
    throw new Error(`${name} must be one of ${[...LOG_LEVELS].join(', ')} (got "${raw}").`)
  }
  return raw as LogLevel
}
