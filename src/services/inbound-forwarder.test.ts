import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { IncomingMessage } from '../engine/index.js'

import { openDatabase, type SqliteDatabase } from '../db/database.js'
import { webhookUrlFor } from '../lib/callbacks.js'
import { createInboundForwarder } from './inbound-forwarder.js'
import { MediaStore } from './media-store.js'
import type { RuntimeSettings } from './settings-store.js'

let dir: string
let db: SqliteDatabase
let store: MediaStore
let settings: RuntimeSettings

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'wa-forward-'))
  db = openDatabase(':memory:')
  settings = runtimeSettings()
  store = new MediaStore(dir, db, settings)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function runtimeSettings(): RuntimeSettings {
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
      urlTemplate: 'https://hook.test/store/{sessionId}/whatsapp',
      statusUrlTemplate: null,
      timeoutMs: 3_000,
      statusTimeoutMs: 3_000,
      mediaMaxBytes: 1_000_000,
      mediaSpoolMaxBytes: 1_000_000,
      mediaTtlMs: 60_000,
    },
    session: { restoreOnBoot: false, restoreDelayMs: 0, pairingTimeoutMs: 60_000 },
  }
}

const message = (overrides: Partial<IncomingMessage> = {}): IncomingMessage => ({
  id: 'MSG1',
  from: '6281234567890',
  to: '',
  chatId: '6281234567890@s.whatsapp.net',
  body: 'My receipt',
  timestamp: 1_727_000_000,
  isFromMe: false,
  ...overrides,
})

describe('inbound forwarding', () => {
  test('expands the tenant template or appends the standard path', () => {
    expect(
      webhookUrlFor('https://hook.test/store/{sessionId}/whatsapp', 'toko-a', 'whatsapp'),
    ).toBe('https://hook.test/store/toko-a/whatsapp')
    expect(webhookUrlFor('https://hook.test/', 'toko-a', 'whatsapp')).toBe(
      'https://hook.test/store/toko-a/whatsapp',
    )
  })

  test('spools media and forwards only its opaque id', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    try {
      const forward = createInboundForwarder({
        settings,
        apiKey: 'secret',
        mediaStore: store,
      })
      await forward(
        'toko-a',
        message({
          hasMedia: true,
          media: {
            kind: 'image',
            mimetype: 'image/jpeg',
            filename: 'receipt.jpg',
            sizeBytes: 4,
            data: Buffer.from('jpeg'),
          },
        }),
      )
    } finally {
      globalThis.fetch = realFetch
    }

    const media = bodies[0]?.media as { id: string; mimetype: string; data?: unknown } | undefined
    expect(media?.mimetype).toBe('image/jpeg')
    expect(media?.id).toMatch(/^[a-f0-9]{32}$/)
    expect(media?.data).toBeUndefined()
    expect((await store.read('toko-a', media!.id))?.data.toString()).toBe('jpeg')
  })
})
