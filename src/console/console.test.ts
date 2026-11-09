import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { loadConfig, type Config } from '../config.js'
import { openDatabase, type SqliteDatabase } from '../db/database.js'
import { SqliteWhatsAppAuthStore } from '../db/whatsapp-auth-store.js'
import { createApp } from '../http/app.js'
import { silentLogger } from '../lib/logger.js'
import { ApiKeyStore } from '../services/api-key-store.js'
import { AuditLog } from '../services/audit-log.js'
import { ConsoleAuthStore } from '../services/console-auth.js'
import { DirectSender } from '../services/direct-send.js'
import { MediaStore } from '../services/media-store.js'
import { Outbox } from '../services/outbox.js'
import { SessionManager } from '../services/session-manager.js'
import { SettingsStore, settingsFromConfig } from '../services/settings-store.js'

const EMAIL = 'admin@example.com'
const PASSWORD = 'a-long-password'
const API_KEY = 'env-secret'

let dir: string
let config: Config
let db: SqliteDatabase
let app: ReturnType<typeof createApp>
let settings: SettingsStore
let apiKeys: ApiKeyStore
let auth: ConsoleAuthStore
let authStore: SqliteWhatsAppAuthStore

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'wa-console-'))
  config = loadConfig(
    {
      NODE_ENV: 'test',
      WHATSAPP_API_KEY: API_KEY,
      WHATSAPP_DATABASE_PATH: path.join(dir, 'gateway.db'),
      WHATSAPP_MEDIA_DIR: path.join(dir, 'media'),
    },
    dir,
  )
  db = openDatabase(':memory:')
  settings = new SettingsStore(db, settingsFromConfig(config), silentLogger)
  apiKeys = new ApiKeyStore(db)
  auth = new ConsoleAuthStore(db, config.console.sessionTtlMs)
  authStore = new SqliteWhatsAppAuthStore(db)
  auth.createAdmin(EMAIL, PASSWORD)
  authStore.ensureSession('shop')
  authStore.saveCreds('shop', JSON.stringify({ me: { id: '6281234567890:1@s.whatsapp.net' } }))

  const sessions = new SessionManager({ authStore, settings: settings.get(), logger: silentLogger })
  const outbox = new Outbox({ db, settings: settings.get(), logger: silentLogger }, sessions)
  outbox.start()

  app = createApp({
    config,
    logger: silentLogger,
    instanceId: 'console-test',
    settings,
    sessions,
    outbox,
    mediaStore: new MediaStore(config.mediaDir, db, settings.get()),
    directSender: new DirectSender({ sessions, outbox, logger: silentLogger }),
    apiKeys,
    auth,
    audit: new AuditLog(db),
  })
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

async function signIn(): Promise<string> {
  const response = await app.request('/console/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ email: EMAIL, password: PASSWORD }),
  })
  expect(response.status).toBe(303)
  const cookie = response.headers.get('set-cookie')
  expect(cookie).toContain('wa_console=')
  return cookie!.split(';')[0]!
}

function form(values: Record<string, string>): string {
  return new URLSearchParams(values).toString()
}

describe('console auth', () => {
  test('redirects an anonymous visitor to sign in', async () => {
    const response = await app.request('/console')
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/console/login')
  })

  test('shows the sign-in page', async () => {
    const response = await app.request('/console/login')
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Sign in')
  })

  test('rejects a wrong password and accepts the right one', async () => {
    const wrong = await app.request('/console/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ email: EMAIL, password: 'wrong-password' }),
    })
    expect(wrong.status).toBe(401)

    const cookie = await signIn()
    const dashboard = await app.request('/console', { headers: { cookie } })
    expect(dashboard.status).toBe(200)
    expect(await dashboard.text()).toContain('Overview')
  })

  test('refuses a cross-site form post', async () => {
    const response = await app.request('/console/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://evil.example',
        host: 'localhost',
      },
      body: form({ email: EMAIL, password: PASSWORD }),
    })
    expect(response.status).toBe(403)
  })

  test('accepts a public Origin forwarded by a reverse proxy', async () => {
    const response = await app.request('/console/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://wa.example.com',
        host: 'gateway:3005',
        'x-forwarded-host': 'wa.example.com',
        'x-forwarded-proto': 'https',
        'sec-fetch-site': 'same-origin',
      },
      body: form({ email: EMAIL, password: PASSWORD }),
    })
    expect(response.status).toBe(303)
    expect(response.headers.get('set-cookie')).toContain('wa_console=')
  })

  test('accepts the configured public origin when the proxy hides every host hint', async () => {
    config.console.publicUrl = 'https://wa.example.com'
    const response = await app.request('/console/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://wa.example.com',
        host: 'gateway:3005',
      },
      body: form({ email: EMAIL, password: PASSWORD }),
    })
    expect(response.status).toBe(303)
  })

  test('accepts same-origin posts when a proxy rewrote Host without forwarding it', async () => {
    const response = await app.request('/console/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://wa.example.com',
        host: 'gateway:3005',
        'sec-fetch-site': 'same-origin',
      },
      body: form({ email: EMAIL, password: PASSWORD }),
    })
    expect(response.status).toBe(303)
  })

  test('accepts an opaque origin from a same-origin form', async () => {
    // Chrome sends Origin: null when Referrer-Policy is no-referrer.
    const response = await app.request('/console/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'null',
        host: 'localhost:3005',
        'sec-fetch-site': 'same-origin',
      },
      body: form({ email: EMAIL, password: PASSWORD }),
    })
    expect(response.status).toBe(303)
  })

  test('refuses an opaque origin with a cross-site hint', async () => {
    const response = await app.request('/console/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'null',
        host: 'localhost:3005',
        'sec-fetch-site': 'cross-site',
      },
      body: form({ email: EMAIL, password: PASSWORD }),
    })
    expect(response.status).toBe(403)
  })

  test('refuses a genuinely cross-site origin', async () => {
    const response = await app.request('/console/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://evil.example',
        host: 'localhost:3005',
        'sec-fetch-site': 'cross-site',
      },
      body: form({ email: EMAIL, password: PASSWORD }),
    })
    expect(response.status).toBe(403)
  })

  test('signs out and clears the cookie', async () => {
    const cookie = await signIn()
    const response = await app.request('/console/logout', {
      method: 'POST',
      headers: { cookie },
    })
    expect(response.status).toBe(303)
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0')

    const dashboard = await app.request('/console', { headers: { cookie } })
    expect(dashboard.status).toBe(303)
  })

  test('creates the first admin through setup', async () => {
    db.prepare('DELETE FROM console_admins').run()

    const root = await app.request('/console')
    expect(root.status).toBe(303)
    expect(root.headers.get('location')).toBe('/console/setup')

    const setup = await app.request('/console/setup')
    expect(setup.status).toBe(200)
    expect(await setup.text()).toContain('Create the first admin')

    const created = await app.request('/console/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({
        email: 'owner@example.com',
        password: 'another-long-password',
        confirm: 'another-long-password',
      }),
    })
    expect(created.status).toBe(303)
    const cookie = created.headers.get('set-cookie')!.split(';')[0]!

    const dashboard = await app.request('/console', { headers: { cookie } })
    expect(dashboard.status).toBe(200)
    expect(auth.countAdmins()).toBe(1)
    expect(auth.findAdminByEmail('owner@example.com')).not.toBeNull()
  })

  test('sends a new admin to the bootstrap API key after setup', async () => {
    db.prepare('DELETE FROM console_admins').run()
    config.apiKey = 'wa_generated_bootstrap_key_1234567890'
    config.apiKeySource = 'generated'
    config.apiKeyFile = '/data/bootstrap-api-key'

    const created = await app.request('/console/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({
        email: 'owner@example.com',
        password: 'another-long-password',
        confirm: 'another-long-password',
      }),
    })

    expect(created.status).toBe(303)
    expect(created.headers.get('location')).toMatch(/^\/console\/api-keys\?ok=/)
  })
})

describe('console pages', () => {
  test('renders sessions, settings, keys and activity', async () => {
    const cookie = await signIn()
    for (const path of [
      '/console/sessions',
      '/console/settings',
      '/console/api-keys',
      '/console/activity',
      '/console/security',
    ]) {
      const response = await app.request(path, { headers: { cookie } })
      expect(response.status, path).toBe(200)
    }
  })

  test('renders a stored session and its pairing page', async () => {
    const cookie = await signIn()
    const list = await app.request('/console/sessions', { headers: { cookie } })
    expect(await list.text()).toContain('shop')

    const detail = await app.request('/console/sessions/shop', { headers: { cookie } })
    expect(detail.status).toBe(200)
    const body = await detail.text()
    expect(body).toContain('Log out session')
    expect(body).toContain('Scan to link WhatsApp')

    const state = await app.request('/console/sessions/shop/state', { headers: { cookie } })
    expect(state.status).toBe(200)
    expect(await state.json()).toMatchObject({
      ok: true,
      status: 'disconnected',
      outbox: { pending: 0 },
    })
  })

  test('creates an API key, uses it, and revokes it', async () => {
    const cookie = await signIn()
    const created = await app.request('/console/api-keys', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ name: 'checkout service' }),
    })
    expect(created.status).toBe(200)
    const html = await created.text()
    expect(html).toContain('Copy this key now')
    const key = /wa_[A-Za-z0-9_-]{40,}/.exec(html)?.[0]
    expect(key).toBeTruthy()

    const accepted = await app.request('/sessions/shop/status', {
      headers: { 'x-api-key': key! },
    })
    expect(accepted.status).toBe(200)

    const record = apiKeys.list().find((item) => item.name === 'checkout service')!
    const revoked = await app.request(`/console/api-keys/${record.id}/revoke`, {
      method: 'POST',
      headers: { cookie },
    })
    expect(revoked.status).toBe(303)

    const rejected = await app.request('/sessions/shop/status', {
      headers: { 'x-api-key': key! },
    })
    expect(rejected.status).toBe(401)
  })

  test('shows the generated bootstrap key to a signed-in admin', async () => {
    const cookie = await signIn()
    config.apiKey = 'wa_generated_bootstrap_key_1234567890'
    config.apiKeySource = 'generated'
    config.apiKeyFile = '/data/bootstrap-api-key'

    const response = await app.request('/console/api-keys', { headers: { cookie } })
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('Bootstrap API key')
    expect(body).toContain('wa_generated_bootstrap_key_1234567890')
    expect(body).toContain('/data/bootstrap-api-key')
  })

  test('saves settings and applies them without a restart', async () => {
    const cookie = await signIn()
    const response = await app.request('/console/settings', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: settingsForm({ outboxSendGap: '2.5', outboxHourlyCap: '90' }),
    })
    expect(response.status).toBe(303)
    expect(settings.get().outbox.sendGapMs).toBe(2_500)
    expect(settings.get().outbox.hourlyCap).toBe(90)
  })

  test('rejects invalid settings without applying them', async () => {
    const cookie = await signIn()
    const before = settings.get().outbox.hourlyCap
    const response = await app.request('/console/settings', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: settingsForm({ outboxHourlyCap: '-1' }),
    })
    expect(response.status).toBe(400)
    expect(settings.get().outbox.hourlyCap).toBe(before)
  })

  test('resets runtime settings to the environment defaults', async () => {
    const cookie = await signIn()
    const saved = await app.request('/console/settings', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: settingsForm({ outboxHourlyCap: '5' }),
    })
    expect(saved.status).toBe(303)
    expect(settings.get().outbox.hourlyCap).toBe(5)

    const reset = await app.request('/console/settings/reset', {
      method: 'POST',
      headers: { cookie },
    })
    expect(reset.status).toBe(303)
    expect(settings.get().outbox.hourlyCap).toBe(120)
  })

  test('returns 404 for an unknown console page', async () => {
    const cookie = await signIn()
    const response = await app.request('/console/nope', { headers: { cookie } })
    expect(response.status).toBe(404)
  })

  test('can be disabled without affecting the API', async () => {
    config.console.enabled = false
    const consoleResponse = await app.request('/console')
    expect(consoleResponse.status).toBe(404)

    const health = await app.request('/health')
    expect(health.status).toBe(200)
  })
})

function settingsForm(overrides: Record<string, string> = {}): string {
  return form({
    outboxSendGap: '3',
    outboxSendJitter: '2',
    outboxHourlyCap: '120',
    outboxMaxAgeHours: '24',
    outboxMaxAttempts: '8',
    typingEnabled: 'on',
    typingMin: '1.2',
    typingMax: '8',
    typingMsPerChar: '35',
    typingJitter: '0.2',
    inboundUrl: 'https://hook.test/store/{sessionId}/whatsapp',
    statusUrl: 'https://hook.test/store/{sessionId}/whatsapp-status',
    inboundTimeout: '3',
    statusTimeout: '3',
    mediaMaxMb: '16',
    mediaSpoolMaxMb: '512',
    mediaTtlHours: '24',
    restoreOnBoot: 'on',
    restoreDelay: '1.5',
    pairingTimeout: '3',
    ...overrides,
  })
}
