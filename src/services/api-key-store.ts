import { createHash, randomBytes, randomUUID } from 'node:crypto'

import type { SqliteDatabase } from '../db/database.js'

export interface ApiKeyRecord {
  id: string
  name: string
  prefix: string
  hash: string
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}

export type PublicApiKey = Omit<ApiKeyRecord, 'hash'>

interface ApiKeyRow {
  id: string
  name: string
  prefix: string
  hash: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}

function toRecord(row: ApiKeyRow): ApiKeyRecord {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    hash: row.hash,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  }
}

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

/**
 * API keys live in SQLite as SHA-256 hashes; the plaintext is returned once
 * at creation and never stored. The environment key is a separate, permanent
 * bootstrap credential handled by the HTTP auth middleware.
 */
export class ApiKeyStore {
  private readonly active = new Map<string, ApiKeyRecord>()

  constructor(private readonly db: SqliteDatabase) {
    this.load()
  }

  create(name: string): { key: string; record: PublicApiKey } {
    const clean = name.trim().slice(0, 80)
    if (!clean) throw new Error('Give the key a name.')

    const key = `wa_${randomBytes(32).toString('base64url')}`
    const record: ApiKeyRecord = {
      id: randomUUID(),
      name: clean,
      prefix: key.slice(0, 11),
      hash: hashKey(key),
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      revokedAt: null,
    }

    this.db
      .prepare(
        `INSERT INTO api_keys (id, name, prefix, hash, created_at, last_used_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .run(record.id, record.name, record.prefix, record.hash, record.createdAt)

    this.active.set(record.hash, record)
    return { key, record: publicRecord(record) }
  }

  /** Returns the matching active record, or null. Updates last-used time. */
  verify(key: string): ApiKeyRecord | null {
    if (!key) return null
    const record = this.active.get(hashKey(key))
    if (!record) return null

    const now = Date.now()
    const last = record.lastUsedAt ? Date.parse(record.lastUsedAt) : 0
    if (now - last > 60_000) {
      const stamp = new Date(now).toISOString()
      this.db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(stamp, record.id)
      record.lastUsedAt = stamp
    }
    return record
  }

  revoke(id: string): boolean {
    const record = [...this.active.values()].find((item) => item.id === id)
    if (!record) return false

    const stamp = new Date().toISOString()
    this.db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?').run(stamp, id)
    this.active.delete(record.hash)
    record.revokedAt = stamp
    return true
  }

  list(): PublicApiKey[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, prefix, hash, created_at, last_used_at, revoked_at
         FROM api_keys
         ORDER BY CASE WHEN revoked_at IS NULL THEN 0 ELSE 1 END, created_at DESC`,
      )
      .all() as ApiKeyRow[]
    return rows.map((row) => publicRecord(toRecord(row)))
  }

  activeCount(): number {
    return this.active.size
  }

  private load(): void {
    const rows = this.db
      .prepare(
        `SELECT id, name, prefix, hash, created_at, last_used_at, revoked_at
         FROM api_keys WHERE revoked_at IS NULL`,
      )
      .all() as ApiKeyRow[]
    for (const row of rows) {
      const record = toRecord(row)
      this.active.set(record.hash, record)
    }
  }
}

function publicRecord(record: ApiKeyRecord): PublicApiKey {
  const { hash: _hash, ...rest } = record
  return rest
}
