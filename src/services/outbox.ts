import { createHash } from 'node:crypto'

import type { SqliteDatabase } from '../db/database.js'
import { PermanentSendError, type MessageResult } from '../engine/index.js'
import { silentLogger, type Logger } from '../lib/logger.js'
import { maskPhone } from '../lib/phone.js'
import type { RuntimeSettings } from './settings-store.js'

/**
 * Durable, per-session message queue, stored in SQLite.
 *
 * A notify call inserts one row and returns; the worker sends it once the
 * session is ready, retries transient failures, deduplicates by idempotency
 * key and paces sends per session. Rows are kept after completion so a repeat
 * webhook is recognised; personal data is scrubbed when a job settles.
 */

export interface OutboxMedia {
  /** Remote HTTP(S) URL or base64 bytes, matching `MediaInput.data`. */
  data: string
  mimetype: string
  filename?: string
  caption?: string
}

export interface OutboxButton {
  id: string
  text: string
}

export interface OutboxMessage {
  text: string
  media?: OutboxMedia
  buttons?: OutboxButton[]
  footer?: string
  /** Chatbot replies ask for a short "typing…" pause before delivery. */
  typing?: boolean
}

export interface OutboxSettlement {
  sessionId: string
  idempotencyKey: string
  kind: string
  status: 'sent' | 'failed'
  messageId?: string
  reason?: string
  at: number
}

export interface OutboxSender {
  /** Returns null while the session is not ready to send. */
  send(sessionId: string, to: string, message: OutboxMessage): Promise<MessageResult> | null
}

export interface OutboxOptions {
  db: SqliteDatabase
  /** Live runtime settings; the worker reads the current object on every tick. */
  settings: RuntimeSettings
  logger?: Logger
  /**
   * Called once per job with its final outcome. Never awaited and never
   * allowed to break the queue: a settlement that throws is logged.
   */
  onSettled?: (event: OutboxSettlement) => void | Promise<void>
}

export interface OutboxStats {
  pending: number
  failedLastDay: number
}

export interface OutboxTotals extends OutboxStats {
  sessionsWithPending: number
  doneLastDay: number
}

const DONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const FAILED_RETENTION_MS = 14 * 24 * 60 * 60 * 1000
const TICK_MS = 1_000

interface OutboxRow {
  id: string
  session_id: string
  idempotency_key: string | null
  kind: string
  status: 'pending' | 'done' | 'failed'
  to_phone: string
  text: string
  media_json: string | null
  buttons_json: string | null
  footer: string | null
  typing: number
  attempts: number
  next_attempt_at: number
  last_error: string | null
  message_id: string | null
  fail_reason: string | null
  created_at: number
  updated_at: number
  sent_at: number | null
  failed_at: number | null
}

interface OutboxJob {
  id: string
  sessionId: string
  idempotencyKey?: string
  kind: string
  to: string
  text: string
  media?: OutboxMedia
  buttons?: OutboxButton[]
  footer?: string
  typing?: boolean
  createdAt: number
  attempts: number
  nextAttemptAt: number
  lastError?: string
}

export class Outbox {
  private readonly inFlight = new Set<string>()
  private readonly nextSendAt = new Map<string, number>()
  private readonly sendLog = new Map<string, number[]>()
  private readonly log: Logger
  private timer: ReturnType<typeof setInterval> | null = null
  private pruneTimer: ReturnType<typeof setInterval> | null = null
  private ticking = false
  private stopped = false
  private readonly pending = new Set<Promise<unknown>>()

  constructor(
    private readonly options: OutboxOptions,
    private readonly sender: OutboxSender,
  ) {
    this.log = options.logger ?? silentLogger
  }

  start(): void {
    this.stopped = false
    this.prune()
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.pruneTimer = setInterval(() => this.prune(), 60 * 60 * 1000)
  }

  /** Stop timers and wait for sends already in flight to finish their DB write. */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    if (this.pruneTimer) clearInterval(this.pruneTimer)
    this.timer = null
    this.pruneTimer = null
    await Promise.allSettled([...this.pending])
  }

  /** Queue a message. Returns the job id and whether the key was seen before. */
  enqueue(input: {
    sessionId: string
    idempotencyKey: string
    kind: string
    to: string
    text: string
    media?: OutboxMedia
    buttons?: OutboxButton[]
    footer?: string
    typing?: boolean
  }): { jobId: string; duplicate: boolean } {
    const id = createHash('sha256')
      .update(`${input.sessionId}\0${input.idempotencyKey}`)
      .digest('hex')
      .slice(0, 32)
    const now = Date.now()

    const result = this.options.db
      .prepare(
        `INSERT OR IGNORE INTO outbox_jobs
          (id, session_id, idempotency_key, kind, status, to_phone, text,
           media_json, buttons_json, footer, typing, attempts, next_attempt_at,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(
        id,
        input.sessionId,
        input.idempotencyKey,
        input.kind,
        input.to,
        input.text,
        input.media ? JSON.stringify(input.media) : null,
        input.buttons?.length ? JSON.stringify(input.buttons) : null,
        input.footer ?? null,
        input.typing ? 1 : 0,
        now,
        now,
        now,
      )

    return { jobId: id, duplicate: result.changes === 0 }
  }

  /**
   * Reserve a send slot for a direct (non-queued) send, e.g. the admin's test
   * message. Shares the session's hourly budget with the queue.
   */
  reserveDirectSend(sessionId: string): { ok: true } | { ok: false; retryAfterMs: number } {
    const wait = this.waitMs(sessionId)
    if (wait > 0) return { ok: false, retryAfterMs: wait }
    this.recordSend(sessionId)
    return { ok: true }
  }

  stats(sessionId: string): OutboxStats {
    const pending = this.options.db
      .prepare(
        "SELECT count(*) AS count FROM outbox_jobs WHERE session_id = ? AND status = 'pending'",
      )
      .get(sessionId) as { count: number }
    const failed = this.options.db
      .prepare(
        `SELECT count(*) AS count FROM outbox_jobs
         WHERE session_id = ? AND status = 'failed' AND failed_at >= ?`,
      )
      .get(sessionId, Date.now() - 24 * 60 * 60 * 1000) as { count: number }
    return { pending: pending.count, failedLastDay: failed.count }
  }

  totals(): OutboxTotals {
    const pending = this.options.db
      .prepare(
        `SELECT count(*) AS count, count(DISTINCT session_id) AS sessions
         FROM outbox_jobs WHERE status = 'pending'`,
      )
      .get() as { count: number; sessions: number }
    const since = Date.now() - 24 * 60 * 60 * 1000
    const failed = this.options.db
      .prepare(
        "SELECT count(*) AS count FROM outbox_jobs WHERE status = 'failed' AND failed_at >= ?",
      )
      .get(since) as { count: number }
    const done = this.options.db
      .prepare("SELECT count(*) AS count FROM outbox_jobs WHERE status = 'done' AND sent_at >= ?")
      .get(since) as { count: number }

    return {
      pending: pending.count,
      sessionsWithPending: pending.sessions,
      failedLastDay: failed.count,
      doneLastDay: done.count,
    }
  }

  /** Follows a tenant slug rename; the session id is the slug. */
  renameSession(from: string, to: string): void {
    this.options.db
      .prepare('UPDATE outbox_jobs SET session_id = ?, updated_at = ? WHERE session_id = ?')
      .run(to, Date.now(), from)
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.ticking) return
    this.ticking = true
    try {
      const now = Date.now()
      const settings = this.options.settings.outbox
      const rows = this.options.db
        .prepare(
          `SELECT * FROM outbox_jobs WHERE status = 'pending'
           ORDER BY created_at ASC LIMIT 1000`,
        )
        .all() as OutboxRow[]

      const bySession = new Map<string, OutboxRow[]>()
      for (const row of rows) {
        const list = bySession.get(row.session_id) ?? []
        list.push(row)
        bySession.set(row.session_id, list)
      }

      for (const [sessionId, list] of bySession) {
        if (this.inFlight.has(sessionId)) continue

        // Expire before sending: a stale job must not use the rate budget.
        const live: OutboxRow[] = []
        for (const row of list) {
          if (now - row.created_at > settings.maxAgeMs) {
            this.fail(row, 'expired')
          } else {
            live.push(row)
          }
        }
        if (live.length === 0) continue

        const row = live.find((job) => job.next_attempt_at <= now)
        if (!row || this.waitMs(sessionId) > 0) continue

        const job = toJob(row)
        let sending: Promise<MessageResult> | null
        try {
          sending = this.sender.send(sessionId, job.to, messageFromJob(job))
        } catch (error) {
          this.onFailure(job, error)
          continue
        }
        if (!sending) continue

        this.inFlight.add(sessionId)
        this.recordSend(sessionId)
        const task = sending
          .then((result) => {
            this.onSent(job, result)
          })
          .catch((error: unknown) => {
            this.onFailure(job, error)
          })
          .finally(() => {
            this.inFlight.delete(sessionId)
            this.pending.delete(task)
          })
        this.pending.add(task)
      }
    } catch (error) {
      this.log.error({ err: error }, 'outbox tick failed')
    } finally {
      this.ticking = false
    }
  }

  private onSent(job: OutboxJob, result: MessageResult): void {
    const now = Date.now()
    this.options.db
      .prepare(
        `UPDATE outbox_jobs
         SET status = 'done', message_id = ?, sent_at = ?, updated_at = ?,
             to_phone = '', text = '', media_json = NULL, buttons_json = NULL, footer = NULL
         WHERE id = ?`,
      )
      .run(result.id, now, now, job.id)
    this.settle(job, { status: 'sent', messageId: result.id })
  }

  private onFailure(job: OutboxJob, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    const attempts = job.attempts + 1
    const maxAttempts = this.options.settings.outbox.maxAttempts

    if (error instanceof PermanentSendError || attempts >= maxAttempts) {
      this.fail(job, error instanceof PermanentSendError ? error.code : message, attempts)
      return
    }

    // 30s, 1m, 2m, 4m ... capped at 1h.
    const backoff = Math.min(60 * 60_000, 30_000 * 2 ** (attempts - 1))
    this.options.db
      .prepare(
        `UPDATE outbox_jobs
         SET attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(attempts, Date.now() + backoff, message, Date.now(), job.id)
  }

  private fail(row: OutboxRow | OutboxJob, reason: string, attempts?: number): void {
    const now = Date.now()
    const stored = isOutboxRow(row)
    const id = row.id
    const sessionId = stored ? row.session_id : row.sessionId
    const kind = row.kind
    const phone = stored ? row.to_phone : row.to
    const jobAttempts = attempts ?? row.attempts

    this.options.db
      .prepare(
        `UPDATE outbox_jobs
         SET status = 'failed', to_phone = ?, text = '', media_json = NULL,
             buttons_json = NULL, footer = NULL, fail_reason = ?, failed_at = ?,
             attempts = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(maskPhone(phone), reason, now, jobAttempts, now, id)

    this.log.warn({ kind, sessionId, to: maskPhone(phone), reason }, 'dropped outbox job')

    const idempotencyKey = stored ? row.idempotency_key : row.idempotencyKey
    if (idempotencyKey) {
      this.settle(
        {
          id,
          sessionId,
          idempotencyKey,
          kind,
          to: phone,
          text: '',
          createdAt: stored ? row.created_at : row.createdAt,
          attempts: jobAttempts,
          nextAttemptAt: now,
        },
        { status: 'failed', reason },
      )
    }
  }

  /** Tell the queuer how the job ended; the queue never waits on the answer. */
  private settle(
    job: OutboxJob,
    outcome: { status: 'sent' | 'failed'; messageId?: string; reason?: string },
  ): void {
    const onSettled = this.options.onSettled
    if (!onSettled || !job.idempotencyKey) return
    try {
      void Promise.resolve(
        onSettled({
          sessionId: job.sessionId,
          idempotencyKey: job.idempotencyKey,
          kind: job.kind,
          status: outcome.status,
          ...(outcome.messageId ? { messageId: outcome.messageId } : {}),
          ...(outcome.reason ? { reason: outcome.reason } : {}),
          at: Date.now(),
        }),
      ).catch((error: unknown) => {
        this.log.warn({ err: error }, 'outbox settlement callback failed')
      })
    } catch (error) {
      this.log.warn({ err: error }, 'outbox settlement callback failed')
    }
  }

  private waitMs(sessionId: string): number {
    const now = Date.now()
    const gapWait = (this.nextSendAt.get(sessionId) ?? 0) - now
    const hourAgo = now - 60 * 60_000
    const log = (this.sendLog.get(sessionId) ?? []).filter((time) => time > hourAgo)
    this.sendLog.set(sessionId, log)
    const cap = this.options.settings.outbox.hourlyCap
    const capWait = cap <= 0 ? 60 * 60_000 : log.length >= cap ? log[0]! - hourAgo : 0
    return Math.max(0, gapWait, capWait)
  }

  private recordSend(sessionId: string): void {
    const now = Date.now()
    const settings = this.options.settings.outbox
    const jitter = Math.random() * settings.sendJitterMs
    this.nextSendAt.set(sessionId, now + settings.sendGapMs + jitter)
    const log = this.sendLog.get(sessionId) ?? []
    log.push(now)
    this.sendLog.set(sessionId, log)
  }

  private prune(): void {
    const now = Date.now()
    this.options.db
      .prepare("DELETE FROM outbox_jobs WHERE status = 'done' AND sent_at < ?")
      .run(now - DONE_RETENTION_MS)
    this.options.db
      .prepare("DELETE FROM outbox_jobs WHERE status = 'failed' AND failed_at < ?")
      .run(now - FAILED_RETENTION_MS)
  }
}

function isOutboxRow(row: OutboxRow | OutboxJob): row is OutboxRow {
  return 'session_id' in row
}

function toJob(row: OutboxRow): OutboxJob {
  return {
    id: row.id,
    sessionId: row.session_id,
    ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
    kind: row.kind,
    to: row.to_phone,
    text: row.text,
    ...(row.media_json ? { media: JSON.parse(row.media_json) as OutboxMedia } : {}),
    ...(row.buttons_json ? { buttons: JSON.parse(row.buttons_json) as OutboxButton[] } : {}),
    ...(row.footer ? { footer: row.footer } : {}),
    ...(row.typing ? { typing: true } : {}),
    createdAt: row.created_at,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    ...(row.last_error ? { lastError: row.last_error } : {}),
  }
}

function messageFromJob(job: OutboxJob): OutboxMessage {
  return {
    text: job.text,
    ...(job.media ? { media: job.media } : {}),
    ...(job.buttons?.length ? { buttons: job.buttons } : {}),
    ...(job.footer ? { footer: job.footer } : {}),
    ...(job.typing ? { typing: true } : {}),
  }
}
