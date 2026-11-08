import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { loadConfig, type Config } from '../config.js'
import { silentLogger } from '../lib/logger.js'
import { DirectSender } from '../services/direct-send.js'
import { MediaStore } from '../services/media-store.js'
import { Outbox } from '../services/outbox.js'
import { SessionManager } from '../services/session-manager.js'
import { createApp } from './app.js'

const API_KEY = 'test-secret'
const AUTH = { authorization: `Bearer ${API_KEY}` }

let dir: string
let config: Config
let sessions: SessionManager
let outbox: Outbox
let app: ReturnType<typeof createApp>

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'wa-app-'))
  config = loadConfig(
    {
      NODE_ENV: 'test',
      WHATSAPP_API_KEY: API_KEY,
      WHATSAPP_AUTH_DIR: path.join(dir, 'sessions'),
      WHATSAPP_OUTBOX_DIR: path.join(dir, 'outbox'),
      WHATSAPP_MEDIA_DIR: path.join(dir, 'media'),
    },
    dir,
  )

  sessions = new SessionManager({ authDir: config.authDir, logger: silentLogger })
  outbox = new Outbox({ ...config.outbox, dir: config.outboxDir, logger: silentLogger }, sessions)
  outbox.start()

  app = createApp({
    config,
    logger: silentLogger,
    instanceId: 'test-instance',
    sessions,
    outbox,
    mediaStore: new MediaStore(config.mediaDir),
    directSender: new DirectSender({ sessions, outbox, logger: silentLogger }),
  })

  // A tenant with completed pairing credentials is "known" without
  // reconnecting its socket.
  mkdirSync(path.join(config.authDir, 'shop'), { recursive: true })
  writeFileSync(
    path.join(config.authDir, 'shop', 'creds.json'),
    JSON.stringify({ me: { id: '6281234567890:1@s.whatsapp.net' } }),
  )
})

afterEach(() => {
  outbox.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('health', () => {
  test('public liveness hides tenant session inventory', async () => {
    const response = await app.request('/health')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      status: 'ok',
      uptime: expect.any(Number),
    })
  })

  test('authenticated callers get the full health report', async () => {
    const response = await app.request('/health', { headers: AUTH })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      status: 'ok',
      instanceId: 'test-instance',
      authEnabled: true,
      sessionCount: 0,
      readyCount: 0,
      outbox: { pending: 0, sessionsWithPending: 0 },
    })
  })
})

describe('authentication', () => {
  test('rejects a missing key', async () => {
    const response = await app.request('/sessions/shop/status')
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ ok: false, error: 'Unauthorized' })
  })

  test('accepts x-api-key as well as Bearer', async () => {
    const response = await app.request('/sessions/shop/status', {
      headers: { 'x-api-key': API_KEY },
    })
    expect(response.status).toBe(200)
  })
})

describe('sessions', () => {
  test('rejects an unsafe session id', async () => {
    const response = await app.request('/sessions/toko%20a/status', { headers: AUTH })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      ok: false,
      error: 'Invalid sessionId. Use 1-64 chars of [a-zA-Z0-9_-].',
    })
  })

  test('reports a paired session waiting for boot restore', async () => {
    const response = await app.request('/sessions/shop/status', { headers: AUTH })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true,
      session: {
        sessionId: 'shop',
        engineType: 'baileys',
        status: 'initializing',
        lastReason: 'pending_restore',
        outbox: { pending: 0, failedLastDay: 0 },
      },
    })
  })

  test('returns 404 for an unknown session', async () => {
    const response = await app.request('/sessions/missing/status', { headers: AUTH })
    expect(response.status).toBe(404)
  })

  test('returns 404 for a media file that is not in the spool', async () => {
    const response = await app.request(`/sessions/shop/media/${'a'.repeat(32)}`, {
      headers: AUTH,
    })
    expect(response.status).toBe(404)
  })
})

describe('notifications', () => {
  const text = {
    sessionId: 'shop',
    phone: '6281234567890',
    kind: 'order.paid',
    text: 'Pesanan dibayar.',
    idempotencyKey: 'order:1:paid',
  }

  test('queues a text notification and deduplicates its key', async () => {
    const first = await app.request('/notify/text', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify(text),
    })
    expect(first.status).toBe(202)
    expect(await first.json()).toMatchObject({ ok: true, queued: true, duplicate: false })

    const second = await app.request('/notify/text', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify(text),
    })
    expect(second.status).toBe(202)
    expect(await second.json()).toMatchObject({ ok: true, queued: true, duplicate: true })
  })

  test('rejects a tenant that has not linked WhatsApp with 409', async () => {
    const response = await app.request('/notify/text', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ ...text, sessionId: 'not-linked' }),
    })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      ok: false,
      queued: false,
      error: 'not_connected',
    })
  })

  test('rejects an invalid body with a field-specific error', async () => {
    const response = await app.request('/notify/text', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ ...text, kind: 'Order Paid' }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      ok: false,
      error: expect.stringContaining('Invalid body: kind'),
    })
  })

  test('rejects malformed JSON', async () => {
    const response = await app.request('/notify/text', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: '{not json',
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ ok: false, error: 'Invalid JSON body.' })
  })

  test('accepts a small queued attachment', async () => {
    const response = await app.request('/notify/media', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        ...text,
        idempotencyKey: 'invoice:1',
        media: {
          data: 'https://example.com/invoice.pdf',
          mimetype: 'application/pdf',
          filename: 'invoice.pdf',
        },
      }),
    })
    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({
      ok: true,
      queued: true,
      duplicate: false,
    })
  })
})

describe('direct messages', () => {
  test('refuses to send while the session is not ready', async () => {
    const response = await app.request('/messages/send', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'shop',
        to: '6281234567890',
        text: 'Halo',
      }),
    })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      ok: false,
      error: 'Session is not connected or ready',
    })
  })
})

describe('fallback', () => {
  test('unknown routes answer a JSON 404', async () => {
    const response = await app.request('/nope', { headers: AUTH })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ ok: false, error: 'Not found' })
  })
})
