import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { openDatabase, type SqliteDatabase } from '../db/database.js'
import { MediaStore } from './media-store.js'
import type { RuntimeSettings } from './settings-store.js'

let dir: string
let db: SqliteDatabase

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'wa-media-'))
  db = openDatabase(':memory:')
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function runtime(ttlMs = 24 * 60 * 60_000, maxBytes = 512 * 1024 * 1024): RuntimeSettings {
  return {
    outbox: {
      sendGapMs: 0,
      sendJitterMs: 0,
      hourlyCap: 100,
      maxAgeMs: 60_000,
      maxAttempts: 3,
    },
    typing: null,
    inbound: {
      urlTemplate: null,
      statusUrlTemplate: null,
      timeoutMs: 1_000,
      statusTimeoutMs: 1_000,
      mediaMaxBytes: 1_000_000,
      mediaSpoolMaxBytes: maxBytes,
      mediaTtlMs: ttlMs,
    },
    session: { restoreOnBoot: false, restoreDelayMs: 0, pairingTimeoutMs: 60_000 },
  }
}

const meta = {
  kind: 'image' as const,
  mimetype: 'image/jpeg',
  filename: 'photo.jpg',
  sizeBytes: 4,
}

describe('MediaStore', () => {
  test('round-trips bytes without exposing the WhatsApp message id', async () => {
    const store = new MediaStore(dir, db, runtime())
    const saved = await store.save('shop', 'MSG1', meta, Buffer.from('jpeg'))

    expect(saved.id).toMatch(/^[a-f0-9]{32}$/)
    expect(saved.id).not.toContain('MSG1')
    const read = await store.read('shop', saved.id)
    expect(read?.data.toString()).toBe('jpeg')
    expect(read?.media).toMatchObject({
      kind: 'image',
      mimetype: 'image/jpeg',
      filename: 'photo.jpg',
      sizeBytes: 4,
    })

    const row = db.prepare('SELECT * FROM media_spool WHERE id = ?').get(saved.id) as Record<
      string,
      unknown
    >
    expect(row).toMatchObject({ session_id: 'shop', size_bytes: 4 })
    expect(row).not.toHaveProperty('data')

    const file = readFileSync(path.join(dir, 'shop', `${saved.id}.bin`), 'utf8')
    expect(file).toBe('jpeg')
  })

  test('rejects another session or a forged id', async () => {
    const store = new MediaStore(dir, db, runtime())
    const saved = await store.save('shop', 'MSG1', meta, Buffer.from('jpeg'))
    expect(await store.read('other', saved.id)).toBeNull()
    expect(await store.read('shop', '../MSG1')).toBeNull()
  })

  test('prunes files past the retention window', async () => {
    const store = new MediaStore(dir, db, runtime(0))
    const saved = await store.save('shop', 'MSG1', meta, Buffer.from('jpeg'))
    expect(await store.prune(Date.now() + 1_000)).toBeGreaterThan(0)
    expect(await store.read('shop', saved.id)).toBeNull()
    expect(
      db.prepare('SELECT count(*) AS count FROM media_spool').get() as { count: number },
    ).toEqual({ count: 0 })
  })

  test('trims the oldest files when the spool byte cap is exceeded', async () => {
    const store = new MediaStore(dir, db, runtime(24 * 60 * 60_000, 4))
    const oldest = await store.save('shop', 'OLD', meta, Buffer.from('aaaa'))
    const newest = await store.save('shop', 'NEW', meta, Buffer.from('bbbb'))

    const now = Date.now()
    db.prepare('UPDATE media_spool SET created_at = ? WHERE id = ?').run(now - 2_000, oldest.id)
    db.prepare('UPDATE media_spool SET created_at = ? WHERE id = ?').run(now - 1_000, newest.id)

    await store.prune(now)
    expect(await store.read('shop', oldest.id)).toBeNull()
    expect((await store.read('shop', newest.id))?.data.toString()).toBe('bbbb')
  })

  test('reports spool totals for the console', async () => {
    const store = new MediaStore(dir, db, runtime())
    await store.save('shop', 'MSG1', meta, Buffer.from('jpeg'))
    expect(store.stats()).toEqual({ files: 1, bytes: 4 })
  })
})
