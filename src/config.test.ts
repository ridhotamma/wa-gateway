import { describe, expect, test } from 'vitest'

import { loadConfig } from './config.js'

describe('loadConfig', () => {
  test('uses safe development defaults', () => {
    const config = loadConfig({}, '/srv/wa-gateway')
    expect(config.nodeEnv).toBe('development')
    expect(config.port).toBe(3005)
    expect(config.authDir).toBe('/srv/wa-gateway/.whatsapp-sessions')
    expect(config.outboxDir).toBe('/srv/wa-gateway/.whatsapp-outbox')
    expect(config.mediaDir).toBe('/srv/wa-gateway/.whatsapp-media')
    expect(config.typing).not.toBeNull()
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
