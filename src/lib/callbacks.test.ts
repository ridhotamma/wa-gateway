import { describe, expect, test } from 'vitest'

import { statusUrlFromInbound, webhookUrlFor } from './callbacks.js'

describe('webhookUrlFor', () => {
  test('uses a full template, encoding the session id', () => {
    expect(
      webhookUrlFor('https://hook.test/store/{sessionId}/whatsapp', 'toko a', 'whatsapp'),
    ).toBe('https://hook.test/store/toko%20a/whatsapp')

    expect(
      webhookUrlFor(
        'https://hook.test/store/{sessionId}/whatsapp-status',
        'toko a',
        'whatsapp-status',
      ),
    ).toBe('https://hook.test/store/toko%20a/whatsapp-status')
  })

  test('appends the standard callback path to a base origin', () => {
    expect(webhookUrlFor('https://hook.test/', 'shop', 'whatsapp')).toBe(
      'https://hook.test/store/shop/whatsapp',
    )
    expect(webhookUrlFor('https://hook.test', 'shop', 'whatsapp-status')).toBe(
      'https://hook.test/store/shop/whatsapp-status',
    )
  })

  test('empty is disabled', () => {
    expect(webhookUrlFor('  ', 'shop', 'whatsapp')).toBeNull()
  })
})

describe('statusUrlFromInbound', () => {
  test('is the inbound URL sibling', () => {
    expect(statusUrlFromInbound('https://hook.test/store/{sessionId}/whatsapp')).toBe(
      'https://hook.test/store/{sessionId}/whatsapp-status',
    )
  })

  test('a base origin passes through for webhookUrlFor to complete', () => {
    expect(statusUrlFromInbound('https://hook.test')).toBe('https://hook.test')
  })

  test('nothing inbound means no status URL', () => {
    expect(statusUrlFromInbound(null)).toBeNull()
    expect(statusUrlFromInbound('')).toBeNull()
  })
})
