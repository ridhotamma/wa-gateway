import { describe, expect, test } from 'vitest'
import type { WAMessage } from 'baileys'

import { extractInboundMessage, extractMessageBody, isDirectChatJid } from './inbound.js'

function message(overrides: {
  remoteJid?: string | null
  remoteJidAlt?: string
  fromMe?: boolean
  id?: string
  message?: unknown
  timestamp?: number
}): WAMessage {
  return {
    key: {
      remoteJid: overrides.remoteJid ?? '6281212345678@s.whatsapp.net',
      ...(overrides.remoteJidAlt ? { remoteJidAlt: overrides.remoteJidAlt } : {}),
      fromMe: overrides.fromMe ?? false,
      id: overrides.id ?? 'MSG1',
    },
    message: overrides.message ?? { conversation: 'halo' },
    messageTimestamp: overrides.timestamp ?? 1_727_000_000,
  } as unknown as WAMessage
}

describe('jid filtering', () => {
  test('accepts direct chats only', () => {
    expect(isDirectChatJid('62812@s.whatsapp.net')).toBe(true)
    expect(isDirectChatJid('123@g.us')).toBe(false)
    expect(isDirectChatJid('status@broadcast')).toBe(false)
    expect(isDirectChatJid('123@newsletter')).toBe(false)
    expect(isDirectChatJid(null)).toBe(false)
  })
})

describe('body extraction', () => {
  test('reads plain text, extended text and captions', () => {
    expect(extractMessageBody({ conversation: 'halo' })).toEqual({
      body: 'halo',
      hasMedia: false,
    })
    expect(extractMessageBody({ extendedTextMessage: { text: 'cek stok' } })).toEqual({
      body: 'cek stok',
      hasMedia: false,
    })
    expect(
      extractMessageBody({
        imageMessage: {
          caption: 'ini yang mana?',
          mimetype: 'image/jpeg',
          fileLength: 1234,
        },
      }),
    ).toEqual({
      body: 'ini yang mana?',
      hasMedia: true,
      media: { kind: 'image', mimetype: 'image/jpeg', sizeBytes: 1234 },
    })
  })

  test('reads button and list replies', () => {
    expect(
      extractMessageBody({ buttonsResponseMessage: { selectedDisplayText: 'Lihat katalog' } }),
    ).toEqual({ body: 'Lihat katalog', hasMedia: false })
    expect(
      extractMessageBody({ buttonsResponseMessage: { selectedButtonId: 'checkout_confirm' } }),
    ).toEqual({ body: 'Ya', hasMedia: false })
    expect(
      extractMessageBody({ buttonsResponseMessage: { selectedButtonId: 'checkout_cancel' } }),
    ).toEqual({ body: 'Batal', hasMedia: false })
    expect(extractMessageBody({ listResponseMessage: { title: 'Lacak pesanan' } })).toEqual({
      body: 'Lacak pesanan',
      hasMedia: false,
    })
  })

  test('unwraps view-once media before extracting it', () => {
    expect(
      extractMessageBody({
        viewOnceMessageV2: { message: { imageMessage: { mimetype: 'image/jpeg' } } },
      }),
    ).toEqual({
      body: '',
      hasMedia: true,
      media: { kind: 'image', mimetype: 'image/jpeg', sizeBytes: 0 },
    })
  })

  test('keeps media without a caption and drops native flow payloads', () => {
    expect(
      extractMessageBody({
        imageMessage: { mimetype: 'image/jpeg', fileLength: 99 },
      }),
    ).toEqual({
      body: '',
      hasMedia: true,
      media: { kind: 'image', mimetype: 'image/jpeg', sizeBytes: 99 },
    })
    expect(
      extractMessageBody({
        documentMessage: {
          fileName: 'invoice.pdf',
          mimetype: 'application/pdf',
          fileLength: 2048,
          caption: 'Invoice',
        },
      }),
    ).toEqual({
      body: 'Invoice',
      hasMedia: true,
      media: {
        kind: 'document',
        mimetype: 'application/pdf',
        filename: 'invoice.pdf',
        sizeBytes: 2048,
      },
    })
    expect(extractMessageBody({ audioMessage: { mimetype: 'audio/ogg', ptt: true } })).toEqual({
      body: '',
      hasMedia: true,
      media: { kind: 'audio', mimetype: 'audio/ogg', sizeBytes: 0 },
    })
    expect(
      extractMessageBody({ interactiveResponseMessage: { nativeFlowResponseMessage: {} } }),
    ).toBeNull()
  })
})

describe('extractInboundMessage', () => {
  test('extracts a customer text message', () => {
    const inbound = extractInboundMessage(message({}))
    expect(inbound).toMatchObject({
      id: 'MSG1',
      from: '6281212345678',
      body: 'halo',
      isFromMe: false,
    })
  })

  test('prefers the alternative phone jid for LID chats', () => {
    const inbound = extractInboundMessage(
      message({ remoteJid: '99@lid', remoteJidAlt: '6281212345678@s.whatsapp.net' }),
    )
    expect(inbound?.from).toBe('6281212345678')
  })

  test('drops own, group, broadcast and empty messages', () => {
    expect(extractInboundMessage(message({ fromMe: true }))).toBeNull()
    expect(extractInboundMessage(message({ remoteJid: '123@g.us' }))).toBeNull()
    expect(extractInboundMessage(message({ remoteJid: 'status@broadcast' }))).toBeNull()
    expect(extractInboundMessage(message({ message: {} }))).toBeNull()
  })

  test('keeps a captionless photo as an inbound attachment', () => {
    const inbound = extractInboundMessage(
      message({ message: { imageMessage: { mimetype: 'image/jpeg', fileLength: 777 } } }),
    )
    expect(inbound).toMatchObject({
      id: 'MSG1',
      body: '',
      hasMedia: true,
      media: { kind: 'image', mimetype: 'image/jpeg', sizeBytes: 777 },
    })
  })
})
