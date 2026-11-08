import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { loadConfig } from '../config.js'
import { openDatabase, type SqliteDatabase } from '../db/database.js'
import { SettingsStore, settingsFromConfig } from './settings-store.js'

let db: SqliteDatabase

beforeEach(() => {
  db = openDatabase(':memory:')
})

afterEach(() => {
  db.close()
})

const defaults = () => settingsFromConfig(loadConfig({}, '/tmp/wa-gateway'))

describe('SettingsStore', () => {
  test('seeds SQLite from the environment defaults', () => {
    const store = new SettingsStore(db, defaults())
    const row = db.prepare("SELECT value FROM settings WHERE key = 'runtime'").get() as {
      value: string
    }
    expect(JSON.parse(row.value)).toMatchObject({
      outbox: { hourlyCap: 120 },
      inbound: { timeoutMs: 3_000 },
    })
    expect(store.get().outbox.hourlyCap).toBe(120)
  })

  test('saves and reloads the runtime settings', () => {
    const store = new SettingsStore(db, defaults())
    const next = structuredClone(store.get())
    next.outbox.hourlyCap = 42
    next.typing = null
    store.save(next)

    const restarted = new SettingsStore(db, defaults())
    expect(restarted.get().outbox.hourlyCap).toBe(42)
    expect(restarted.get().typing).toBeNull()
  })

  test('mutates the existing object so services see changes immediately', () => {
    const store = new SettingsStore(db, defaults())
    const reference = store.get()
    const next = structuredClone(reference)
    next.inbound.urlTemplate = 'https://hook.test/store/{sessionId}/whatsapp'
    next.session.restoreOnBoot = false
    store.save(next)

    expect(reference.inbound.urlTemplate).toBe('https://hook.test/store/{sessionId}/whatsapp')
    expect(reference.session.restoreOnBoot).toBe(false)
  })

  test('rejects invalid settings without changing the current ones', () => {
    const store = new SettingsStore(db, defaults())
    const next = structuredClone(store.get())
    next.outbox.hourlyCap = -1
    expect(() => store.save(next)).toThrow()
    expect(store.get().outbox.hourlyCap).toBe(120)
  })

  test('falls back to defaults when the stored JSON is invalid', () => {
    db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('runtime', '{\"outbox\":{}}', 'now')",
    ).run()
    const store = new SettingsStore(db, defaults())
    expect(store.get().outbox.hourlyCap).toBe(120)
    const row = db.prepare("SELECT value FROM settings WHERE key = 'runtime'").get() as {
      value: string
    }
    expect(JSON.parse(row.value).outbox.hourlyCap).toBe(120)
  })
})
