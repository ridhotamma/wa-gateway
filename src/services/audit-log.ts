import type { SqliteDatabase } from '../db/database.js'

export interface AuditEntry {
  id: number
  at: string
  actor: string
  action: string
  detail: string | null
}

interface AuditRow {
  id: number
  at: string
  actor: string
  action: string
  detail: string | null
}

/** A short, human-readable history of console operations. */
export class AuditLog {
  constructor(private readonly db: SqliteDatabase) {}

  record(actor: string, action: string, detail?: string | null): void {
    this.db
      .prepare('INSERT INTO audit_log (at, actor, action, detail) VALUES (?, ?, ?, ?)')
      .run(new Date().toISOString(), actor, action, detail ?? null)
  }

  recent(limit = 30): AuditEntry[] {
    const rows = this.db
      .prepare('SELECT id, at, actor, action, detail FROM audit_log ORDER BY id DESC LIMIT ?')
      .all(limit) as AuditRow[]
    return rows
  }

  prune(keep = 5_000): void {
    this.db
      .prepare(
        `DELETE FROM audit_log WHERE id NOT IN (
           SELECT id FROM audit_log ORDER BY id DESC LIMIT ?
         )`,
      )
      .run(keep)
  }
}
