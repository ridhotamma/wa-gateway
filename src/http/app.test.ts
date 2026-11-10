import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { loadConfig, type Config } from '../config.js'
import { openDatabase, type SqliteDatabase } from '../db/database.js'
import { SqliteWhatsAppAuthStore } from '../db/whatsapp-auth-store.js'
import { silentLogger } from '../lib/logger.js'
import { ApiKeyStore } from '../services/api-key-store.js'
import { AuditLog } from '../services/audit-log.js'
import { ConsoleAuthStore } from '../services/console-auth.js'
import { DirectSender } from '../services/direct-send.js'
import { MediaStore } from '../services/media-store.js'
import { Outbox } from '../services/outbox.js'
import { SessionManager } from '../services/session-manager.js'
import { SettingsStore, settingsFromConfig } from '../services/settings-store.js'
import { createApp } from './app.js'

const API_KEY = 'test-secret'
const AUTH = { authorization: `Bearer ${API_KEY}` }

let dir: string
let config: Config
let db: SqliteDatabase
let authStore: SqliteWhatsAppAuthStore
let sessions: SessionManager
let outbox: Outbox
let apiKeys: ApiKeyStore
let app: ReturnType<typeof createApp>

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'wa-app-'))
  config = loadConfig(
    {
      NODE_ENV: 'test',
      WHATSAPP_API_KEY: API_KEY,
      WHATSAPP_DATABASE_PATH: path.join(dir, 'gateway.db'),
      WHATSAPP_MEDIA_DIR: path.join(dir, 'media'),
      WHATSAPP_CONSOLE_EMAIL: 'admin@example.com',
      WHATSAPP_CONSOLE_PASSWORD: 'a-long-password',
    },
    dir,
  )

  db = openDatabase(':memory:')
  const settings = new SettingsStore(db, settingsFromConfig(config), silentLogger)
  const runtime = settings.get()
  authStore = new SqliteWhatsAppAuthStore(db)
  apiKeys = new ApiKeyStore(db)
  const auth = new ConsoleAuthStore(db, config.console.sessionTtlMs)
  const audit = new AuditLog(db)

  sessions = new SessionManager({ authStore, settings: runtime, logger: silentLogger })
  outbox = new Outbox({ db, settings: runtime, logger: silentLogger }, sessions)
  outbox.start()

  app = createApp({
    config,
    logger: silentLogger,
    instanceId: 'test-instance',
    settings,
    sessions,
    outbox,
    mediaStore: new MediaStore(config.mediaDir, db, runtime),
    directSender: new DirectSender({ sessions, outbox, logger: silentLogger }),
    apiKeys,
    auth,
    audit,
  })

  // A tenant with completed pairing credentials is "known" without
  // reconnecting its socket.
  authStore.ensureSession('shop')
  authStore.saveCreds('shop', JSON.stringify({ me: { id: '6281234567890:1@s.whatsapp.net' } }))
})

afterEach(async () => {
  await outbox.stop()
  db.close()
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

describe('API reference', () => {
  test('serves the OpenAPI document without an API key', async () => {
    const response = await app.request('/openapi.json')
    expect(response.status).toBe(200)

    const document = (await response.json()) as {
      openapi: string
      info: { title: string; version: string }
      paths: Record<string, unknown>
      components: { securitySchemes: Record<string, unknown> }
    }
    expect(document.openapi).toBe('3.0.0')
    expect(document.info).toMatchObject({ title: 'WhatsApp Gateway API', version: '1.1.0' })
    expect(document.components.securitySchemes).toMatchObject({
      apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' },
      bearerAuth: { type: 'http', scheme: 'bearer' },
    })

    for (const path of [
      '/health',
      '/sessions/{sessionId}/start',
      '/sessions/{sessionId}/status',
      '/sessions/{sessionId}/logout',
      '/sessions/{sessionId}/rename',
      '/sessions/{sessionId}/media/{mediaId}',
      '/notify/text',
      '/notify/media',
      '/notify/buttons',
      '/messages/send',
      '/messages/send-media',
      '/messages/send-buttons',
    ]) {
      expect(document.paths[path], path).toBeDefined()
    }
  })

  test('serves the Scalar API reference without an API key', async () => {
    const response = await app.request('/docs')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')

    const html = await response.text()
    expect(html).toContain('WhatsApp Gateway API')
    expect(html).toContain('/openapi.json')
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

  test('accepts a console-created key and rejects it after revoke', async () => {
    const created = apiKeys.create('checkout')
    const accepted = await app.request('/sessions/shop/status', {
      headers: { 'x-api-key': created.key },
    })
    expect(accepted.status).toBe(200)

    apiKeys.revoke(created.record.id)
    const rejected = await app.request('/sessions/shop/status', {
      headers: { 'x-api-key': created.key },
    })
    expect(rejected.status).toBe(401)
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
  test('unknown API routes answer a JSON 404', async () => {
    const response = await app.request('/nope', { headers: AUTH })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ ok: false, error: 'Not found' })
  })
})
