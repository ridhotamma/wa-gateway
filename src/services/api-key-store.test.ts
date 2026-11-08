import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { openDatabase, type SqliteDatabase } from '../db/database.js'
import { ApiKeyStore } from './api-key-store.js'

let db: SqliteDatabase
let store: ApiKeyStore

beforeEach(() => {
  db = openDatabase(':memory:')
  store = new ApiKeyStore(db)
})

afterEach(() => {
  db.close()
})

describe('ApiKeyStore', () => {
  test('creates a key, returns the secret once, and stores only a hash', () => {
    const created = store.create('checkout')
    expect(created.key).toMatch(/^wa_[A-Za-z0-9_-]{40,}$/)
    expect(created.record.name).toBe('checkout')
    expect(created.record.prefix).toBe(created.key.slice(0, 11))
    expect(created.record.revokedAt).toBeNull()

    const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(created.record.id) as {
      hash: string
      name: string
    }
    expect(row.hash).not.toBe(created.key)
    expect(row.name).toBe('checkout')
  })

  test('verifies an active key and records its use', () => {
    const created = store.create('webhook')
    const verified = store.verify(created.key)
    expect(verified?.name).toBe('webhook')
    expect(verified?.lastUsedAt).not.toBeNull()
    expect(store.verify('wa_wrong')).toBeNull()
  })

  test('revokes a key immediately', () => {
    const created = store.create('checkout')
    expect(store.activeCount()).toBe(1)
    expect(store.revoke(created.record.id)).toBe(true)
    expect(store.activeCount()).toBe(0)
    expect(store.verify(created.key)).toBeNull()
    expect(store.revoke(created.record.id)).toBe(false)
  })

  test('loads active keys from SQLite on restart and keeps revoked ones out', () => {
    const keep = store.create('keep')
    const gone = store.create('gone')
    store.revoke(gone.record.id)

    const restarted = new ApiKeyStore(db)
    expect(restarted.activeCount()).toBe(1)
    expect(restarted.verify(keep.key)?.name).toBe('keep')
    expect(restarted.verify(gone.key)).toBeNull()
    expect(restarted.list().map((key) => key.name)).toEqual(['keep', 'gone'])
  })

  test('requires a name', () => {
    expect(() => store.create('   ')).toThrow('Give the key a name.')
  })
})
