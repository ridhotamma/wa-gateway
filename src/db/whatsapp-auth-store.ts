import { BufferJSON } from 'baileys'

import type {
  AuthKeyEntry,
  StoredSessionInfo,
  WhatsAppAuthStore,
} from '../engine/baileys/auth-state.js'
import type { SqliteDatabase } from './database.js'

interface SessionRow {
  session_id: string
  creds_json: string | null
  created_at: string
  updated_at: string
  last_status: string | null
  last_status_reason: string | null
  last_connected_at: string | null
}

function pairedFromCreds(raw: string | null): boolean {
  if (!raw) return false
  try {
    const creds = JSON.parse(raw, BufferJSON.reviver) as { me?: { id?: unknown } }
    return typeof creds.me?.id === 'string' && creds.me.id !== ''
  } catch {
    return false
  }
}

function toInfo(row: SessionRow): StoredSessionInfo {
  return {
    sessionId: row.session_id,
    paired: pairedFromCreds(row.creds_json),
    status: row.last_status,
    reason: row.last_status_reason,
    lastConnectedAt: row.last_connected_at,
    updatedAt: row.updated_at,
  }
}

/** SQLite-backed Baileys credential and signal-key storage. */
export class SqliteWhatsAppAuthStore implements WhatsAppAuthStore {
  constructor(private readonly db: SqliteDatabase) {}

  ensureSession(sessionId: string): void {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO whatsapp_sessions (session_id, created_at, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO NOTHING`,
      )
      .run(sessionId, now, now)
  }

  loadCreds(sessionId: string): string | null {
    const row = this.db
      .prepare('SELECT creds_json FROM whatsapp_sessions WHERE session_id = ?')
      .get(sessionId) as { creds_json: string | null } | undefined
    return row?.creds_json ?? null
  }

  saveCreds(sessionId: string, json: string): void {
    const now = new Date().toISOString()
    this.ensureSession(sessionId)
    this.db
      .prepare('UPDATE whatsapp_sessions SET creds_json = ?, updated_at = ? WHERE session_id = ?')
      .run(json, now, sessionId)
  }

  loadKeys(sessionId: string, category: string, ids: string[]): Record<string, string | null> {
    if (ids.length === 0) return {}
    const rows = this.db
      .prepare(
        `SELECT key_id, value_json FROM whatsapp_auth_keys
         WHERE session_id = ? AND category = ?`,
      )
      .all(sessionId, category) as Array<{ key_id: string; value_json: string }>

    const wanted = new Set(ids)
    const result: Record<string, string | null> = {}
    for (const row of rows) {
      if (wanted.has(row.key_id)) result[row.key_id] = row.value_json
    }
    return result
  }

  saveKeys(sessionId: string, entries: AuthKeyEntry[]): void {
    this.ensureSession(sessionId)
    const upsert = this.db.prepare(
      `INSERT INTO whatsapp_auth_keys (session_id, category, key_id, value_json)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id, category, key_id)
       DO UPDATE SET value_json = excluded.value_json`,
    )
    const remove = this.db.prepare(
      'DELETE FROM whatsapp_auth_keys WHERE session_id = ? AND category = ? AND key_id = ?',
    )

    this.db.transaction(() => {
      for (const entry of entries) {
        if (entry.value === null) {
          remove.run(sessionId, entry.category, entry.id)
        } else {
          upsert.run(sessionId, entry.category, entry.id, entry.value)
        }
      }
      this.db
        .prepare('UPDATE whatsapp_sessions SET updated_at = ? WHERE session_id = ?')
        .run(new Date().toISOString(), sessionId)
    })()
  }

  hasSession(sessionId: string): boolean {
    const row = this.db
      .prepare('SELECT 1 AS ok FROM whatsapp_sessions WHERE session_id = ?')
      .get(sessionId) as { ok: number } | undefined
    return Boolean(row)
  }

  hasPairedCreds(sessionId: string): boolean {
    return pairedFromCreds(this.loadCreds(sessionId))
  }

  clearSession(sessionId: string): void {
    this.db.prepare('DELETE FROM whatsapp_sessions WHERE session_id = ?').run(sessionId)
  }

  renameSession(from: string, to: string): void {
    this.db
      .prepare('UPDATE whatsapp_sessions SET session_id = ?, updated_at = ? WHERE session_id = ?')
      .run(to, new Date().toISOString(), from)
  }

  listSessionIds(): string[] {
    const rows = this.db
      .prepare('SELECT session_id FROM whatsapp_sessions ORDER BY session_id')
      .all() as Array<{ session_id: string }>
    return rows.map((row) => row.session_id)
  }

  listSessions(): StoredSessionInfo[] {
    const rows = this.db
      .prepare('SELECT * FROM whatsapp_sessions ORDER BY updated_at DESC')
      .all() as SessionRow[]
    return rows.map(toInfo)
  }

  setStatus(sessionId: string, status: string, reason?: string): void {
    const now = new Date().toISOString()
    this.ensureSession(sessionId)
    this.db
      .prepare(
        `UPDATE whatsapp_sessions
         SET last_status = ?, last_status_reason = ?, updated_at = ?,
             last_connected_at = CASE WHEN ? = 'ready' THEN ? ELSE last_connected_at END
         WHERE session_id = ?`,
      )
      .run(status, reason ?? null, now, status, now, sessionId)
  }

  getStatus(sessionId: string): {
    status: string | null
    reason: string | null
    lastConnectedAt: string | null
  } | null {
    const row = this.db
      .prepare(
        `SELECT last_status, last_status_reason, last_connected_at
         FROM whatsapp_sessions WHERE session_id = ?`,
      )
      .get(sessionId) as
      | {
          last_status: string | null
          last_status_reason: string | null
          last_connected_at: string | null
        }
      | undefined
    if (!row) return null
    return {
      status: row.last_status,
      reason: row.last_status_reason,
      lastConnectedAt: row.last_connected_at,
    }
  }
}
