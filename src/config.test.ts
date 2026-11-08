import { describe, expect, test } from 'vitest'

import { loadConfig } from './config.js'

describe('loadConfig', () => {
  test('uses safe development defaults', () => {
    const config = loadConfig({}, '/srv/wa-gateway')
    expect(config.nodeEnv).toBe('development')
    expect(config.port).toBe(3005)
    expect(config.databasePath).toBe('/srv/wa-gateway/.whatsapp-data/gateway.db')
    expect(config.mediaDir).toBe('/srv/wa-gateway/.whatsapp-data/media')
    expect(config.typing).not.toBeNull()
    expect(config.console.enabled).toBe(true)
    expect(config.console.sessionTtlMs).toBe(7 * 24 * 60 * 60_000)
    expect(config.console.publicUrl).toBeNull()
  })

  test('derives the public console origin from WHATSAPP_DOMAIN', () => {
    expect(loadConfig({ WHATSAPP_DOMAIN: 'wa.example.com' }).console.publicUrl).toBe(
      'https://wa.example.com',
    )
    expect(
      loadConfig({
        WHATSAPP_DOMAIN: 'wa.example.com',
        WHATSAPP_CONSOLE_URL: 'http://localhost:3005/console?x=1',
      }).console.publicUrl,
    ).toBe('http://localhost:3005')
  })

  test('reads the console bootstrap admin', () => {
    const config = loadConfig({
      WHATSAPP_CONSOLE_EMAIL: 'Admin@Example.com',
      WHATSAPP_CONSOLE_PASSWORD: 'a-long-password',
      WHATSAPP_CONSOLE_SESSION_HOURS: '12',
    })
    expect(config.console.email).toBe('admin@example.com')
    expect(config.console.password).toBe('a-long-password')
    expect(config.console.sessionTtlMs).toBe(12 * 60 * 60_000)
  })

  test('refuses to start production without an API key', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(
      'WHATSAPP_API_KEY is required when NODE_ENV=production.',
    )
  })

  test('derives the status callback from the inbound one', () => {
    const config = loadConfig({
      WHATSAPP_INBOUND_URL: 'https://hook.test/store/{sessionId}/whatsapp',
    })
    expect(config.inbound.statusUrlTemplate).toBe(
      'https://hook.test/store/{sessionId}/whatsapp-status',
    )
  })

  test('rejects malformed numbers and booleans', () => {
    expect(() => loadConfig({ WHATSAPP_HOURLY_CAP: 'lots' })).toThrow(
      'WHATSAPP_HOURLY_CAP must be an integer',
    )
    expect(() => loadConfig({ WHATSAPP_TYPING: 'maybe' })).toThrow(
      'WHATSAPP_TYPING must be true or false',
    )
  })

  test('WHATSAPP_TYPING=false disables typing without changing callers', () => {
    expect(loadConfig({ WHATSAPP_TYPING: 'false' }).typing).toBeNull()
  })
})
