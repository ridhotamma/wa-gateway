/**
 * Extract the inbound messages the chatbot may act on.
 *
 * The daemon is a notification client, not a chat archive: this drops the
 * socket's own noise — the seller's sent messages, groups, broadcasts, status
 * updates, newsletters — and returns direct text, captions, button replies,
 * and attachment metadata. The Baileys adapter downloads attachment bytes
 * separately; this module stays pure and socket-free so its filters can be
 * unit-tested without a network.
 */

import { normalizeMessageContent, type WAMessage, type proto } from 'baileys'
import { parseWaId } from '../identity/wa-id.js'
import type { IncomingMessage } from '../types.js'

const NON_DIRECT_SUFFIXES = ['@g.us', '@broadcast', '@newsletter'] as const

/** Button ids we issue, mapped to the words the rule brain already reads. */
const CHECKOUT_BUTTON_TEXT: Record<string, string> = {
  checkout_confirm: 'Ya',
  checkout_cancel: 'Batal',
}

export function isDirectChatJid(jid: string | null | undefined): jid is string {
  if (!jid) return false
  if (jid === 'status@broadcast') return false
  return !NON_DIRECT_SUFFIXES.some((suffix) => jid.endsWith(suffix))
}

interface ExtractedMedia {
  kind: 'image' | 'video' | 'audio' | 'document' | 'sticker'
  mimetype: string
  filename?: string
  sizeBytes: number
}

interface ExtractedBody {
  body: string
  hasMedia: boolean
  media?: ExtractedMedia
}

/** Proto lengths are `number | Long`; anything else is unknown, not zero. */
function byteLength(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  if (typeof value === 'object' && value !== null && 'toNumber' in value) {
    const converted = (value as { toNumber(): number }).toNumber()
    if (Number.isFinite(converted) && converted >= 0) return converted
  }
  return 0
}

/** A stored filename without a path: WhatsApp clients send both, sometimes. */
function fileName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const cleaned = value.trim().split(/[\\/]/).pop()?.slice(0, 200)
  return cleaned || undefined
}

/** The customer-readable text of a message, whichever shape WhatsApp used. */
export function extractMessageBody(
  content: proto.IMessage | null | undefined,
): ExtractedBody | null {
  const normalized = normalizeMessageContent(content)
  if (!normalized) return null

  const text = normalized.conversation ?? normalized.extendedTextMessage?.text ?? null
  if (text && text.trim()) return { body: text, hasMedia: false }

  const image = normalized.imageMessage
  if (image) {
    return {
      body: image.caption?.trim() ?? '',
      hasMedia: true,
      media: {
        kind: 'image',
        mimetype: image.mimetype?.trim() || 'image/jpeg',
        sizeBytes: byteLength(image.fileLength),
      },
    }
  }

  const video = normalized.videoMessage
  if (video) {
    return {
      body: video.caption?.trim() ?? '',
      hasMedia: true,
      media: {
        kind: 'video',
        mimetype: video.mimetype?.trim() || 'video/mp4',
        sizeBytes: byteLength(video.fileLength),
      },
    }
  }

  const audio = normalized.audioMessage
  if (audio) {
    return {
      body: '',
      hasMedia: true,
      media: {
        kind: 'audio',
        mimetype: audio.mimetype?.trim() || (audio.ptt ? 'audio/ogg' : 'audio/mp4'),
        sizeBytes: byteLength(audio.fileLength),
      },
    }
  }

  const document = normalized.documentMessage
  if (document) {
    return {
      body: document.caption?.trim() ?? '',
      hasMedia: true,
      media: {
        kind: 'document',
        mimetype: document.mimetype?.trim() || 'application/octet-stream',
        filename: fileName(document.fileName) ?? fileName(document.title),
        sizeBytes: byteLength(document.fileLength),
      },
    }
  }

  const sticker = normalized.stickerMessage
  if (sticker) {
    return {
      body: '',
      hasMedia: true,
      media: {
        kind: 'sticker',
        mimetype: sticker.mimetype?.trim() || 'image/webp',
        sizeBytes: byteLength(sticker.fileLength),
      },
    }
  }

  const selectedDisplay =
    normalized.buttonsResponseMessage?.selectedDisplayText ??
    normalized.templateButtonReplyMessage?.selectedDisplayText ??
    normalized.listResponseMessage?.title ??
    null
  const selectedId =
    normalized.buttonsResponseMessage?.selectedButtonId ??
    normalized.templateButtonReplyMessage?.selectedId ??
    normalized.listResponseMessage?.singleSelectReply?.selectedRowId ??
    null
  // Our own checkout ids survive a client that echoes the id but not the
  // visible label. Other ids pass through so future buttons can map them.
  const buttonReply = selectedDisplay ?? CHECKOUT_BUTTON_TEXT[selectedId ?? ''] ?? selectedId
  if (buttonReply && buttonReply.trim()) return { body: buttonReply, hasMedia: false }

  // Native flow / interactive replies carry JSON; forwarding it would only
  // feed the model machine noise, so it is dropped.
  return null
}

/**
 * One `WAMessage` → `IncomingMessage`, or null when the bot must ignore it.
 * `key.remoteJidAlt` is preferred when present: newer Baileys versions expose
 * the phone JID there for LID-addressed chats.
 */
export function extractInboundMessage(message: WAMessage): IncomingMessage | null {
  const key = message.key
  if (!key || key.fromMe) return null

  const chatId = key.remoteJidAlt ?? key.remoteJid
  if (!isDirectChatJid(chatId)) return null

  // Belt and braces: `remoteJidAlt` may itself be a group in malformed data.
  if (!isDirectChatJid(key.remoteJid)) return null

  const extracted = extractMessageBody(message.message)
  if (!extracted || (!extracted.hasMedia && !extracted.body.trim())) return null

  const parsed = parseWaId(chatId)
  if (!parsed.userPart) return null

  const timestamp = Number(message.messageTimestamp)
  if (!key.id) return null

  return {
    id: key.id,
    from: parsed.userPart,
    to: '',
    chatId,
    body: extracted.body.trim(),
    timestamp: Number.isFinite(timestamp) ? timestamp : Math.floor(Date.now() / 1000),
    isFromMe: false,
    hasMedia: extracted.hasMedia,
    ...(extracted.media && { media: extracted.media }),
  }
}
