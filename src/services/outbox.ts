import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { PermanentSendError, type MessageResult } from '../engine/index.js'
import { silentLogger, type Logger } from '../lib/logger.js'
import { maskPhone } from '../lib/phone.js'

/**
 * Durable, per-session message queue.
 *
 * Why it exists: callers (checkout, payment/shipping webhooks) must never
 * block on WhatsApp, and a notification sent while a session is reconnecting
 * used to be rejected and lost. Now a notify call only writes a file; this
 * worker sends it once the session is ready, retrying transient failures and
 * pacing sends so a seller's number doesn't look like a spam bot.
 *
 * Layout under the outbox dir (a volume in production):
 *   pending/<sessionId>/<jobId>.json  full job, includes phone + text
 *   done/<sessionId>/<jobId>.json     idempotency marker only, no PII
 *   failed/<sessionId>/<jobId>.json   masked recipient + error, no text
 * jobId is a hash of the caller's idempotency key, so a webhook delivered
 * twice (or a paid event raised by two code paths) sends one message.
 */

export interface OutboxJob {
  id: string
  sessionId: string
  kind: string
  /** The caller's key. Optional: jobs written before it was kept lack it. */
  idempotencyKey?: string
  to: string
  text: string
  /** An attachment queued alongside the text; absent for a text-only job. */
  media?: OutboxMedia
  /** Reply buttons queued alongside the text; absent for a text-only job. */
  buttons?: OutboxButton[]
  /** Optional line below the buttons. */
  footer?: string
  /** Show "typing…" for a moment before this reply is sent. */
  typing?: boolean
  createdAt: number
  attempts: number
  nextAttemptAt: number
  lastError?: string
}

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

/**
 * A job's final outcome, for whoever queued it: `sent` with the WhatsApp
 * message id, or `failed` (including expiry and retry exhaustion) with why.
 */
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
  dir: string
  /** Minimum gap between two sends of one session (ms), plus random jitter. */
  sendGapMs: number
  sendJitterMs: number
  /** Max sends per session per rolling hour, queue and direct sends combined. */
  hourlyCap: number
  /** Jobs older than this are dropped: a day-old "paid" message is noise. */
  maxAgeMs: number
  maxAttempts: number
  /** Service logger; tests may omit it. */
  logger?: Logger
  /**
   * Called once per job with its final outcome, for the platform's message
   * log. Never awaited and never allowed to break the queue: a settlement
   * that throws is logged and forgotten.
   */
  onSettled?: (event: OutboxSettlement) => void | Promise<void>
}

const DONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const FAILED_RETENTION_MS = 14 * 24 * 60 * 60 * 1000
const TICK_MS = 1_000

type Bucket = 'pending' | 'done' | 'failed'

export class Outbox {
  private readonly jobs = new Map<string, OutboxJob[]>()
  private readonly inFlight = new Set<string>()
  private readonly nextSendAt = new Map<string, number>()
  private readonly sendLog = new Map<string, number[]>()
  private readonly log: Logger
  private timer: ReturnType<typeof setInterval> | null = null
  private pruneTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly options: OutboxOptions,
    private readonly sender: OutboxSender,
  ) {
    this.log = options.logger ?? silentLogger
  }

  start(): void {
    for (const bucket of ['pending', 'done', 'failed'] as const) {
      mkdirSync(path.join(this.options.dir, bucket), { recursive: true })
    }
    this.load()
    this.prune()
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.pruneTimer = setInterval(() => this.prune(), 60 * 60 * 1000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.pruneTimer) clearInterval(this.pruneTimer)
    this.timer = null
    this.pruneTimer = null
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

    const known =
      this.jobs.get(input.sessionId)?.some((j) => j.id === id) ||
      existsSync(this.file('done', input.sessionId, id)) ||
      existsSync(this.file('failed', input.sessionId, id))
    if (known) return { jobId: id, duplicate: true }

    const now = Date.now()
    const job: OutboxJob = {
      id,
      sessionId: input.sessionId,
      kind: input.kind,
      idempotencyKey: input.idempotencyKey,
      to: input.to,
      text: input.text,
      ...(input.media ? { media: input.media } : {}),
      ...(input.buttons?.length ? { buttons: input.buttons } : {}),
      ...(input.footer ? { footer: input.footer } : {}),
      ...(input.typing ? { typing: true } : {}),
      createdAt: now,
      attempts: 0,
      nextAttemptAt: now,
    }
    this.write('pending', job.sessionId, id, job)
    const list = this.jobs.get(job.sessionId) ?? []
    list.push(job)
    this.jobs.set(job.sessionId, list)
    return { jobId: id, duplicate: false }
  }

  /**
   * Reserve a send slot for a direct (non-queued) send, e.g. the admin's
   * test message. Returns the wait in ms when the session is rate limited.
   */
  reserveDirectSend(sessionId: string): { ok: true } | { ok: false; retryAfterMs: number } {
    const wait = this.waitMs(sessionId)
    if (wait > 0) return { ok: false, retryAfterMs: wait }
    this.recordSend(sessionId)
    return { ok: true }
  }

  stats(sessionId: string): { pending: number; failedLastDay: number } {
    const pending = this.jobs.get(sessionId)?.length ?? 0
    const failedDir = path.join(this.options.dir, 'failed', sessionId)
    let failedLastDay = 0
    if (existsSync(failedDir)) {
      const since = Date.now() - 24 * 60 * 60 * 1000
      for (const name of readdirSync(failedDir)) {
        try {
          if (statSync(path.join(failedDir, name)).mtimeMs >= since) failedLastDay += 1
        } catch {
          // Pruned meanwhile.
        }
      }
    }
    return { pending, failedLastDay }
  }

  totals(): { pending: number; sessionsWithPending: number } {
    let pending = 0
    for (const list of this.jobs.values()) pending += list.length
    return { pending, sessionsWithPending: this.jobs.size }
  }

  /** Follows a tenant slug rename: pending jobs and markers move along. */
  renameSession(from: string, to: string): void {
    for (const bucket of ['pending', 'done', 'failed'] as const) {
      const src = path.join(this.options.dir, bucket, from)
      if (existsSync(src)) renameSync(src, path.join(this.options.dir, bucket, to))
    }
    const list = this.jobs.get(from)
    if (list) {
      for (const job of list) job.sessionId = to
      this.jobs.delete(from)
      this.jobs.set(to, list)
    }
  }

  private async tick(): Promise<void> {
    const now = Date.now()
    for (const [sessionId, list] of this.jobs) {
      if (list.length === 0 || this.inFlight.has(sessionId)) continue

      // Expire before sending: a stale job must not use up the rate budget.
      while (list[0] && now - list[0].createdAt > this.options.maxAgeMs) {
        this.fail(list.shift()!, 'expired')
      }
      if (list.length === 0) {
        this.jobs.delete(sessionId)
        continue
      }
      const job = list.find((j) => j.nextAttemptAt <= now)
      if (!job || this.waitMs(sessionId) > 0) continue

      const sending = this.sender.send(sessionId, job.to, {
        text: job.text,
        ...(job.media ? { media: job.media } : {}),
        ...(job.buttons?.length ? { buttons: job.buttons } : {}),
        ...(job.footer ? { footer: job.footer } : {}),
        ...(job.typing ? { typing: true } : {}),
      })
      if (!sending) continue // session not ready: wait, not an attempt

      this.inFlight.add(sessionId)
      this.recordSend(sessionId)
      void sending
        .then((result) => {
          this.remove(job)
          this.write('done', sessionId, job.id, {
            id: job.id,
            kind: job.kind,
            messageId: result.id,
            sentAt: Date.now(),
          })
          this.delete('pending', sessionId, job.id)
          this.settle(job, { status: 'sent', messageId: result.id })
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          job.attempts += 1
          job.lastError = message
          if (err instanceof PermanentSendError || job.attempts >= this.options.maxAttempts) {
            this.remove(job)
            this.fail(job, err instanceof PermanentSendError ? err.code : message)
            return
          }
          // 30s, 1m, 2m, 4m ... capped at 1h.
          const backoff = Math.min(60 * 60_000, 30_000 * 2 ** (job.attempts - 1))
          job.nextAttemptAt = Date.now() + backoff
          this.write('pending', sessionId, job.id, job)
        })
        .finally(() => {
          this.inFlight.delete(sessionId)
          if (this.jobs.get(sessionId)?.length === 0) this.jobs.delete(sessionId)
        })
    }
  }

  private waitMs(sessionId: string): number {
    const now = Date.now()
    const gapWait = (this.nextSendAt.get(sessionId) ?? 0) - now
    const hourAgo = now - 60 * 60_000
    const log = (this.sendLog.get(sessionId) ?? []).filter((t) => t > hourAgo)
    this.sendLog.set(sessionId, log)
    const capWait = log.length >= this.options.hourlyCap ? log[0]! - hourAgo : 0
    return Math.max(0, gapWait, capWait)
  }

  private recordSend(sessionId: string): void {
    const now = Date.now()
    const jitter = Math.random() * this.options.sendJitterMs
    this.nextSendAt.set(sessionId, now + this.options.sendGapMs + jitter)
    const log = this.sendLog.get(sessionId) ?? []
    log.push(now)
    this.sendLog.set(sessionId, log)
  }

  private fail(job: OutboxJob, reason: string): void {
    this.write('failed', job.sessionId, job.id, {
      id: job.id,
      kind: job.kind,
      to: maskPhone(job.to),
      attempts: job.attempts,
      reason,
      createdAt: job.createdAt,
      failedAt: Date.now(),
    })
    this.delete('pending', job.sessionId, job.id)
    this.log.warn(
      { kind: job.kind, sessionId: job.sessionId, to: maskPhone(job.to), reason },
      'dropped outbox job',
    )
    this.settle(job, { status: 'failed', reason })
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

  private remove(job: OutboxJob): void {
    const list = this.jobs.get(job.sessionId)
    if (!list) return
    const index = list.indexOf(job)
    if (index !== -1) list.splice(index, 1)
  }

  private load(): void {
    const pendingDir = path.join(this.options.dir, 'pending')
    let loaded = 0
    for (const sessionId of readdirSync(pendingDir)) {
      const dir = path.join(pendingDir, sessionId)
      const list: OutboxJob[] = []
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.json')) continue
        try {
          list.push(JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as OutboxJob)
        } catch {
          this.log.warn({ sessionId, file: name }, 'skipping unreadable outbox job')
        }
      }
      if (list.length > 0) {
        list.sort((a, b) => a.createdAt - b.createdAt)
        this.jobs.set(sessionId, list)
        loaded += list.length
      }
    }
    if (loaded > 0) this.log.info({ count: loaded }, 'resumed pending outbox messages')
  }

  private prune(): void {
    const now = Date.now()
    for (const [bucket, retention] of [
      ['done', DONE_RETENTION_MS],
      ['failed', FAILED_RETENTION_MS],
    ] as const) {
      const root = path.join(this.options.dir, bucket)
      if (!existsSync(root)) continue
      for (const sessionId of readdirSync(root)) {
        const dir = path.join(root, sessionId)
        for (const name of readdirSync(dir)) {
          const file = path.join(dir, name)
          try {
            if (now - statSync(file).mtimeMs > retention) rmSync(file, { force: true })
          } catch {
            // Raced with another prune/rename.
          }
        }
      }
    }
  }

  private file(bucket: Bucket, sessionId: string, id: string): string {
    return path.join(this.options.dir, bucket, sessionId, `${id}.json`)
  }

  /** Write-then-rename so a crash mid-write never leaves a torn job file. */
  private write(bucket: Bucket, sessionId: string, id: string, data: unknown): void {
    const target = this.file(bucket, sessionId, id)
    mkdirSync(path.dirname(target), { recursive: true })
    const tmp = `${target}.tmp`
    writeFileSync(tmp, JSON.stringify(data))
    renameSync(tmp, target)
  }

  private delete(bucket: Bucket, sessionId: string, id: string): void {
    rmSync(this.file(bucket, sessionId, id), { force: true })
  }
}
