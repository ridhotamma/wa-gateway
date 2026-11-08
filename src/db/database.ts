import { chmodSync, mkdirSync } from 'node:fs'
import path from 'node:path'

import Database from 'better-sqlite3'

import { SCHEMA_V1, SCHEMA_VERSION } from './schema.js'

export type SqliteDatabase = Database.Database

/**
 * Open (or create) the gateway database. WAL keeps readers (the console) from
 * blocking the outbox writer; `busy_timeout` covers the rare checkpoint.
 */
export function openDatabase(filePath: string): SqliteDatabase {
  if (filePath !== ':memory:') {
    mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  }

  const db = new Database(filePath)
  if (filePath !== ':memory:') {
    // The database holds credentials and key hashes: keep it owner-only, like
    // a password file.
    try {
      chmodSync(filePath, 0o600)
    } catch {
      // Best effort on filesystems without POSIX permissions.
    }
  }
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  migrate(db)
  return db
}

function migrate(db: SqliteDatabase): void {
  const version = db.pragma('user_version', { simple: true }) as number
  if (version >= SCHEMA_VERSION) return

  db.exec('BEGIN')
  try {
    if (version < 1) db.exec(SCHEMA_V1)
    db.pragma(`user_version = ${SCHEMA_VERSION}`)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** Run `fn` in a transaction; better-sqlite3 is synchronous. */
export function transaction<T>(db: SqliteDatabase, fn: () => T): T {
  return db.transaction(fn)()
}
