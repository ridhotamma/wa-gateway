/**
 * Short-lived inbound attachment spool.
 *
 * Baileys downloads customer media through the authenticated socket. The
 * webhook runs on a different host and cannot call `downloadMediaMessage`, so
 * the daemon writes the bytes here and forwards only an opaque id. The
 * webhook fetches the file over the authenticated `/sessions/:id/media/:id`
 * route, stores it in its own object storage, and the daemon prunes the spool
 * after 24 hours.
 *
 * The directory is a volume in production. Files are owner-only (0600), the
 * keys are hashes rather than message ids, and no phone number is written to
 * the metadata — a stale spool is still customer data, so keep the retention
 * short. A total-byte cap trims the oldest files first.
 *
 * Every operation is async: a 16 MB document must not block the socket loop.
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { IncomingMediaKind } from '../engine/index.js'

export interface InboundMediaMeta {
  kind: IncomingMediaKind
  mimetype: string
  filename?: string
  sizeBytes: number
}

export interface StoredInboundMedia extends InboundMediaMeta {
  /** Opaque id the webhook asks for; not the WhatsApp message id. */
  id: string
  sessionId: string
  savedAt: number
}

interface StoredMeta extends StoredInboundMedia {
  messageId: string
}

const SESSION_ID = /^[a-zA-Z0-9_-]{1,64}$/
const MEDIA_ID = /^[a-f0-9]{32}$/
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024

function metaFileName(id: string): string {
  return `${id}.json`
}

function bytesFileName(id: string): string {
  return `${id}.bin`
}

export class MediaStore {
  constructor(
    private readonly dir: string,
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly maxBytes = DEFAULT_MAX_BYTES,
  ) {}

  async save(
    sessionId: string,
    messageId: string,
    meta: InboundMediaMeta,
    data: Buffer,
  ): Promise<StoredInboundMedia> {
    if (!SESSION_ID.test(sessionId)) throw new Error('Invalid session id for media spool.')
    const id = createHash('sha256').update(`${sessionId}\0${messageId}`).digest('hex').slice(0, 32)
    const sessionDir = path.join(this.dir, sessionId)
    await mkdir(sessionDir, { recursive: true, mode: 0o700 })

    const stored: StoredMeta = {
      id,
      sessionId,
      messageId,
      kind: meta.kind,
      mimetype: meta.mimetype,
      ...(meta.filename ? { filename: meta.filename } : {}),
      sizeBytes: data.byteLength,
      savedAt: Date.now(),
    }
    await writeAtomic(path.join(sessionDir, bytesFileName(id)), data)
    await writeAtomic(
      path.join(sessionDir, metaFileName(id)),
      Buffer.from(JSON.stringify(stored), 'utf8'),
    )

    return {
      id,
      sessionId,
      kind: stored.kind,
      mimetype: stored.mimetype,
      ...(stored.filename ? { filename: stored.filename } : {}),
      sizeBytes: stored.sizeBytes,
      savedAt: stored.savedAt,
    }
  }

  async read(
    sessionId: string,
    id: string,
  ): Promise<{ media: StoredInboundMedia; data: Buffer } | null> {
    if (!SESSION_ID.test(sessionId) || !MEDIA_ID.test(id)) return null
    const sessionDir = path.join(this.dir, sessionId)

    try {
      const stored = JSON.parse(
        await readFile(path.join(sessionDir, metaFileName(id)), 'utf8'),
      ) as StoredMeta
      if (stored.id !== id || stored.sessionId !== sessionId) return null
      const data = await readFile(path.join(sessionDir, bytesFileName(id)))
      return {
        media: {
          id: stored.id,
          sessionId: stored.sessionId,
          kind: stored.kind,
          mimetype: stored.mimetype,
          ...(stored.filename ? { filename: stored.filename } : {}),
          sizeBytes: stored.sizeBytes || data.byteLength,
          savedAt: stored.savedAt,
        },
        data,
      }
    } catch {
      return null
    }
  }

  /**
   * Remove expired files, then trim the oldest remaining files until the
   * spool is under its byte cap. The cap is the backstop against a customer
   * filling the host's disk with attachments inside one retention window.
   */
  async prune(now = Date.now()): Promise<number> {
    let sessions
    try {
      sessions = await readdir(this.dir, { withFileTypes: true })
    } catch {
      return 0
    }

    let removed = 0
    const remaining: Array<{ full: string; sizeBytes: number; mtimeMs: number }> = []
    for (const session of sessions) {
      if (!session.isDirectory() || !SESSION_ID.test(session.name)) continue
      const sessionDir = path.join(this.dir, session.name)
      let files: string[]
      try {
        files = await readdir(sessionDir)
      } catch {
        continue
      }
      for (const file of files) {
        const full = path.join(sessionDir, file)
        try {
          const info = await stat(full)
          if (now - info.mtimeMs > this.ttlMs) {
            await rm(full, { force: true })
            removed += 1
          } else if (file.endsWith('.bin')) {
            remaining.push({ full, sizeBytes: info.size, mtimeMs: info.mtimeMs })
          }
        } catch {
          // Pruned or replaced meanwhile.
        }
      }
    }

    let totalBytes = remaining.reduce((sum, file) => sum + file.sizeBytes, 0)
    if (totalBytes > this.maxBytes) {
      remaining.sort((a, b) => a.mtimeMs - b.mtimeMs)
      for (const file of remaining) {
        if (totalBytes <= this.maxBytes) break
        await rm(file.full, { force: true }).catch(() => {})
        await rm(file.full.replace(/\.bin$/, '.json'), { force: true }).catch(() => {})
        totalBytes -= file.sizeBytes
        removed += 1
      }
    }
    return removed
  }
}

/** Write a spool file atomically so a reader never sees half a photo. */
async function writeAtomic(target: string, data: Buffer): Promise<void> {
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, data, { mode: 0o600 })
    await rename(temp, target)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}
