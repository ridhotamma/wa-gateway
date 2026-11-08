import { describe, expect, test } from 'vitest'
import type { WASocket } from 'baileys'

import { PermanentSendError } from '../errors.js'
import { sendBaileysButtons, sendBaileysMedia, sendBaileysPresence } from './messaging.js'

describe('sendBaileysButtons', () => {
  test('relays the button carrier with the business nodes', async () => {
    const relayed: Array<{
      jid: string
      message: Record<string, unknown>
      options: Record<string, unknown>
    }> = []
    const sock = {
      user: { id: '628999999999:1@s.whatsapp.net' },
      onWhatsApp: async () => [{ exists: true, jid: '6281234567890@s.whatsapp.net' }],
      relayMessage: async (
        jid: string,
        message: Record<string, unknown>,
        options: Record<string, unknown>,
      ) => {
        relayed.push({ jid, message, options })
        return 'relay-id'
      },
    } as unknown as WASocket

    const result = await sendBaileysButtons(sock, '6281234567890', {
      text: 'Place this order?',
      buttons: [
        { id: 'yes', text: 'Yes' },
        { id: 'no', text: 'No' },
      ],
    })

    expect(result).toMatchObject({ id: 'relay-id', body: 'Place this order?' })
    expect(relayed).toHaveLength(1)
    const [call] = relayed
    expect(call?.jid).toBe('6281234567890@s.whatsapp.net')
    const message = call?.message as {
      documentWithCaptionMessage?: {
        message?: { buttonsMessage?: { contentText?: string; buttons?: unknown[] } }
      }
    }
    expect(message.documentWithCaptionMessage?.message?.buttonsMessage?.contentText).toBe(
      'Place this order?',
    )
    expect(message.documentWithCaptionMessage?.message?.buttonsMessage?.buttons).toHaveLength(2)
    expect(call?.options.additionalNodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ tag: 'biz' })]),
    )
  })
})

describe('sendBaileysPresence', () => {
  test('sends the chat state to the resolved JID', async () => {
    const presence: Array<{ state: string; jid: string }> = []
    const sock = {
      onWhatsApp: async () => [{ exists: true, jid: '6281234567890@s.whatsapp.net' }],
      sendPresenceUpdate: async (state: string, jid: string) => {
        presence.push({ state, jid })
      },
    } as unknown as WASocket

    await sendBaileysPresence(sock, '6281234567890', 'composing')
    await sendBaileysPresence(sock, '6281234567890', 'paused')

    expect(presence).toEqual([
      { state: 'composing', jid: '6281234567890@s.whatsapp.net' },
      { state: 'paused', jid: '6281234567890@s.whatsapp.net' },
    ])
  })

  test('rejects a number that is not on WhatsApp before emitting presence', async () => {
    let sent = false
    const sock = {
      onWhatsApp: async () => [],
      sendPresenceUpdate: async () => {
        sent = true
      },
    } as unknown as WASocket

    let error: unknown
    try {
      await sendBaileysPresence(sock, '6281111111111', 'composing')
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(PermanentSendError)
    expect(sent).toBe(false)
  })
})

describe('sendBaileysMedia', () => {
  test('rejects an unsafe URL before looking up the recipient', async () => {
    let lookedUp = false
    const sock = {
      onWhatsApp: async () => {
        lookedUp = true
        return [{ exists: true, jid: '6281234567890@s.whatsapp.net' }]
      },
    } as unknown as WASocket

    let error: unknown
    try {
      await sendBaileysMedia(sock, '6281234567890', {
        data: 'http://169.254.169.254/latest/meta-data',
        mimetype: 'image/jpeg',
      })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(PermanentSendError)
    expect((error as PermanentSendError).code).toBe('unsafe_media')
    expect(lookedUp).toBe(false)
  })
})
