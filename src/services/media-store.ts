/**
 * Short-lived inbound attachment spool.
 *
 * Baileys downloads customer media through the authenticated socket. The
 * webhook runs on a different host and cannot call `downloadMediaMessage`, so
 * the daemon writes the bytes here and forwards only an opaque id. Metadata
 * lives in SQLite; the bytes stay on disk (a 16 MB file belongs in object
 * storage, not in the database that is backed up every few hours).
 *
 * Files are owner-only (0600), keys are hashes rather than message ids, and no
 * phone number is written to the metadata. A total-byte cap trims the oldest
 * files first.
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { SqliteDatabase } from '../db/database.js'
import type { IncomingMediaKind } from '../engine/index.js'
import type { RuntimeSettings } from './settings-store.js'

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

export interface MediaStoreStats {
  files: number
  bytes: number
}

interface MediaRow {
  id: string
  session_id: string
  kind: IncomingMediaKind
  mimetype: string
  filename: string | null
  size_bytes: number
  relative_path: string
  created_at: number
}

const SESSION_ID = /^[a-zA-Z0-9_-]{1,64}$/
const MEDIA_ID = /^[a-f0-9]{32}$/

export class MediaStore {
  constructor(
    private readonly dir: string,
    private readonly db: SqliteDatabase,
    private readonly settings: RuntimeSettings,
  ) {}

  async save(
    sessionId: string,
    messageId: string,
    meta: InboundMediaMeta,
    data: Buffer,
  ): Promise<StoredInboundMedia> {
    if (!SESSION_ID.test(sessionId)) throw new Error('Invalid session id for media spool.')

    const id = createHash('sha256').update(`${sessionId}\0${messageId}`).digest('hex').slice(0, 32)
    const relativePath = path.join(sessionId, `${id}.bin`)
    const fullPath = path.join(this.dir, relativePath)
    await mkdir(path.dirname(fullPath), { recursive: true, mode: 0o700 })
    await writeAtomic(fullPath, data)

    const savedAt = Date.now()
    const expiresAt = savedAt + this.settings.inbound.mediaTtlMs
    this.db
      .prepare(
        `INSERT INTO media_spool
          (id, session_id, message_id, kind, mimetype, filename, size_bytes,
           relative_path, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           mimetype = excluded.mimetype,
           filename = excluded.filename,
           size_bytes = excluded.size_bytes,
           relative_path = excluded.relative_path,
           created_at = excluded.created_at,
           expires_at = excluded.expires_at`,
      )
      .run(
        id,
        sessionId,
        messageId,
        meta.kind,
        meta.mimetype,
        meta.filename ?? null,
        data.byteLength,
        relativePath,
        savedAt,
        expiresAt,
      )

    return {
      id,
      sessionId,
      kind: meta.kind,
      mimetype: meta.mimetype,
      ...(meta.filename ? { filename: meta.filename } : {}),
      sizeBytes: data.byteLength,
      savedAt,
    }
  }

  async read(
    sessionId: string,
    id: string,
  ): Promise<{ media: StoredInboundMedia; data: Buffer } | null> {
    if (!SESSION_ID.test(sessionId) || !MEDIA_ID.test(id)) return null

    const row = this.db
      .prepare('SELECT * FROM media_spool WHERE id = ? AND session_id = ?')
      .get(id, sessionId) as MediaRow | undefined
    if (!row) return null

    try {
      const data = await readFile(path.join(this.dir, row.relative_path))
      return {
        media: {
          id: row.id,
          sessionId: row.session_id,
          kind: row.kind,
          mimetype: row.mimetype,
          ...(row.filename ? { filename: row.filename } : {}),
          sizeBytes: row.size_bytes || data.byteLength,
          savedAt: row.created_at,
        },
        data,
      }
    } catch {
      return null
    }
  }

  /**
   * Remove expired rows/files, then trim the oldest remaining files until the
   * spool is under its byte cap.
   */
  async prune(now = Date.now()): Promise<number> {
    let removed = 0
    const ttl = this.settings.inbound.mediaTtlMs
    const expired = this.db
      .prepare('SELECT * FROM media_spool WHERE created_at + ? <= ?')
      .all(ttl, now) as MediaRow[]
    for (const row of expired) {
      await rm(path.join(this.dir, row.relative_path), { force: true }).catch(() => {})
      this.db.prepare('DELETE FROM media_spool WHERE id = ?').run(row.id)
      removed += 1
    }

    const total = this.db
      .prepare('SELECT coalesce(sum(size_bytes), 0) AS bytes FROM media_spool')
      .get() as { bytes: number }
    let bytes = total.bytes
    const maxBytes = this.settings.inbound.mediaSpoolMaxBytes
    if (bytes > maxBytes) {
      const oldest = this.db
        .prepare('SELECT * FROM media_spool ORDER BY created_at ASC')
        .all() as MediaRow[]
      for (const row of oldest) {
        if (bytes <= maxBytes) break
        await rm(path.join(this.dir, row.relative_path), { force: true }).catch(() => {})
        this.db.prepare('DELETE FROM media_spool WHERE id = ?').run(row.id)
        bytes -= row.size_bytes
        removed += 1
      }
    }

    return removed
  }

  stats(): MediaStoreStats {
    const row = this.db
      .prepare('SELECT count(*) AS files, coalesce(sum(size_bytes), 0) AS bytes FROM media_spool')
      .get() as { files: number; bytes: number }
    return { files: row.files, bytes: row.bytes }
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
