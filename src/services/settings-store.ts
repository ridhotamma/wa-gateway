import { z } from 'zod'

import type { Config, InboundConfig, OutboxConfig, TypingConfig } from '../config.js'
import type { SqliteDatabase } from '../db/database.js'
import { silentLogger, type Logger } from '../lib/logger.js'

export interface SessionDefaults {
  restoreOnBoot: boolean
  restoreDelayMs: number
  pairingTimeoutMs: number
}

/**
 * The runtime settings the console can edit without a restart. Deployment
 * values (port, database path, bootstrap secrets) stay in the environment;
 * everything an operator tunes while the gateway is running lives here and in
 * SQLite, so it survives a restart and a redeploy.
 */
export interface RuntimeSettings {
  outbox: OutboxConfig
  typing: TypingConfig | null
  inbound: InboundConfig
  session: SessionDefaults
}

const typingSchema = z.object({
  minMs: z
    .number()
    .int()
    .min(0)
    .max(10 * 60_000),
  maxMs: z
    .number()
    .int()
    .min(0)
    .max(10 * 60_000),
  msPerChar: z.number().int().min(0).max(10_000),
  jitterRatio: z.number().min(0).max(1),
})

const inboundSchema = z.object({
  urlTemplate: z.string().trim().max(2_048).nullable(),
  statusUrlTemplate: z.string().trim().max(2_048).nullable(),
  timeoutMs: z.number().int().min(100).max(120_000),
  statusTimeoutMs: z.number().int().min(100).max(120_000),
  mediaMaxBytes: z
    .number()
    .int()
    .min(0)
    .max(1024 ** 3),
  mediaSpoolMaxBytes: z
    .number()
    .int()
    .min(0)
    .max(1024 ** 4),
  mediaTtlMs: z
    .number()
    .int()
    .min(0)
    .max(90 * 24 * 60 * 60_000),
})

const outboxSchema = z.object({
  sendGapMs: z
    .number()
    .int()
    .min(0)
    .max(60 * 60_000),
  sendJitterMs: z
    .number()
    .int()
    .min(0)
    .max(60 * 60_000),
  hourlyCap: z.number().int().min(0).max(100_000),
  maxAgeMs: z
    .number()
    .int()
    .min(0)
    .max(30 * 24 * 60 * 60_000),
  maxAttempts: z.number().int().min(1).max(100),
})

const sessionSchema = z.object({
  restoreOnBoot: z.boolean(),
  restoreDelayMs: z
    .number()
    .int()
    .min(0)
    .max(10 * 60_000),
  pairingTimeoutMs: z
    .number()
    .int()
    .min(10_000)
    .max(60 * 60_000),
})

export const runtimeSettingsSchema = z.object({
  outbox: outboxSchema,
  typing: typingSchema.nullable(),
  inbound: inboundSchema,
  session: sessionSchema,
})

const SETTINGS_KEY = 'runtime'

export function settingsFromConfig(config: Config): RuntimeSettings {
  return {
    outbox: { ...config.outbox },
    typing: config.typing ? { ...config.typing } : null,
    inbound: { ...config.inbound },
    session: {
      restoreOnBoot: config.restoreOnBoot,
      restoreDelayMs: config.restoreDelayMs,
      pairingTimeoutMs: config.pairingTimeoutMs,
    },
  }
}

/**
 * Loads the one `runtime` settings row, seeding it from the environment on
 * first boot. The object identity never changes: services hold a reference and
 * see an update immediately after `save`.
 */
export class SettingsStore {
  private current: RuntimeSettings
  private readonly log: Logger

  constructor(
    private readonly db: SqliteDatabase,
    defaults: RuntimeSettings,
    logger?: Logger,
  ) {
    this.log = logger ?? silentLogger
    this.current = structuredClone(defaults)
    this.load(defaults)
  }

  get(): RuntimeSettings {
    return this.current
  }

  save(next: RuntimeSettings): RuntimeSettings {
    let parsed: RuntimeSettings
    try {
      parsed = runtimeSettingsSchema.parse(next)
    } catch (error) {
      if (error instanceof z.ZodError) {
        const issue = error.issues[0]
        const field = issue?.path.join('.') || 'settings'
        throw new Error(`Invalid ${field}: ${issue?.message ?? 'check the values'}`)
      }
      throw error
    }
    this.apply(parsed)
    this.persist()
    return this.current
  }

  private load(defaults: RuntimeSettings): void {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTINGS_KEY) as
      { value: string } | undefined

    if (!row) {
      this.apply(structuredClone(defaults))
      this.persist()
      return
    }

    try {
      this.apply(runtimeSettingsSchema.parse(JSON.parse(row.value)))
    } catch (error) {
      this.log.warn(
        { err: error },
        'stored runtime settings are invalid; falling back to environment defaults',
      )
      this.apply(structuredClone(defaults))
      this.persist()
    }
  }

  private apply(next: RuntimeSettings): void {
    // Mutate in place: services keep a reference to this object.
    Object.assign(this.current.outbox, next.outbox)
    Object.assign(this.current.inbound, next.inbound)
    Object.assign(this.current.session, next.session)
    this.current.typing = next.typing ? { ...next.typing } : null
  }

  private persist(): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(SETTINGS_KEY, JSON.stringify(this.current), new Date().toISOString())
  }
}
