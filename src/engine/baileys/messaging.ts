import { generateWAMessageFromContent, type AnyMessageContent, type WASocket } from 'baileys'
import { PermanentSendError, UnsafeMediaUrlError } from '../errors.js'
import {
  type ButtonsInput,
  type MediaInput,
  type MessageResult,
  type PresenceState,
} from '../types.js'
import { parseWaId, toBaileysJid } from '../identity/wa-id.js'
import { buildReplyButtonsMessage, replyButtonsRelayNodes } from './interactive.js'
import { assertSafeMediaUrl } from './media-url.js'

// E.164 allows 15 digits; anything shorter than 8 cannot be a real
// subscriber number (country code included).
const MIN_PHONE_DIGITS = 8
const MAX_PHONE_DIGITS = 15

const RECIPIENT_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const RECIPIENT_CACHE_MAX = 5_000
const recipientCache = new Map<string, { jid: string | null; at: number }>()

/**
 * Resolves the JID to send to, confirming a phone number is actually on
 * WhatsApp first. Baileys "sends" to a non-existent number without an error,
 * so without this check a typo'd customer phone fails silently forever.
 * Groups and LIDs are addresses WhatsApp already issued — sent as-is.
 */
async function resolveRecipient(sock: WASocket, target: string): Promise<string> {
  const parsed = parseWaId(target)
  if (parsed.kind !== 'user') return toBaileysJid(target)

  const jid = toBaileysJid(target)
  const digits = jid.split('@')[0] ?? ''
  if (digits.length < MIN_PHONE_DIGITS || digits.length > MAX_PHONE_DIGITS) {
    throw new PermanentSendError(`"${target}" is not a valid phone number.`, 'invalid_recipient')
  }

  const cached = recipientCache.get(digits)
  if (cached && Date.now() - cached.at < RECIPIENT_CACHE_TTL_MS) {
    if (!cached.jid) throw notOnWhatsApp(digits)
    return cached.jid
  }

  const [result] = (await sock.onWhatsApp(jid)) ?? []
  const resolved = result?.exists ? result.jid || jid : null

  if (recipientCache.size >= RECIPIENT_CACHE_MAX) {
    // Map iterates in insertion order: drop the oldest entry.
    const oldest = recipientCache.keys().next().value
    if (oldest !== undefined) recipientCache.delete(oldest)
  }
  recipientCache.set(digits, { jid: resolved, at: Date.now() })

  if (!resolved) throw notOnWhatsApp(digits)
  return resolved
}

function notOnWhatsApp(digits: string): PermanentSendError {
  // Last 4 digits only: this message ends up in logs and API responses.
  return new PermanentSendError(
    `Number ending ${digits.slice(-4)} is not registered on WhatsApp.`,
    'not_on_whatsapp',
  )
}

/** A display filename for WhatsApp: no path segments, no control characters. */
function mediaFilename(name: string | undefined, fallback: string): string {
  const clean = name
    ?.split(/[\\/]/)
    .pop()
    ?.replace(/[\u0000-\u001f\u007f]+/g, '')
    .trim()
    .slice(0, 200)
  return clean || fallback
}

/**
 * Send text message through active Baileys socket.
 */
export async function sendBaileysText(
  sock: WASocket,
  target: string,
  text: string,
): Promise<MessageResult> {
  const jid = await resolveRecipient(sock, target)
  const sent = await sock.sendMessage(jid, { text })

  return {
    id: sent?.key?.id ?? '',
    timestamp:
      typeof sent?.messageTimestamp === 'number'
        ? sent.messageTimestamp
        : Math.floor(Date.now() / 1000),
    body: text,
  }
}

/**
 * Show or clear the "typing…" indicator in a chat. Resolving the recipient
 * first reuses the send path's "is this number on WhatsApp" guard, so presence
 * never goes to a typo'd number that a later text send would reject.
 */
export async function sendBaileysPresence(
  sock: WASocket,
  target: string,
  state: PresenceState,
): Promise<void> {
  const jid = await resolveRecipient(sock, target)
  await sock.sendPresenceUpdate(state, jid)
}

/**
 * Send media message through active Baileys socket.
 */
export async function sendBaileysMedia(
  sock: WASocket,
  target: string,
  media: MediaInput,
): Promise<MessageResult> {
  let mediaPayload: Buffer | { url: string }
  if (typeof media.data !== 'string') {
    mediaPayload = media.data
  } else if (/^https?:\/\//i.test(media.data)) {
    try {
      mediaPayload = { url: await assertSafeMediaUrl(media.data) }
    } catch (error) {
      if (error instanceof UnsafeMediaUrlError) {
        throw new PermanentSendError(error.message, 'unsafe_media')
      }
      throw error
    }
  } else if (media.data.startsWith('data:')) {
    const comma = media.data.indexOf(',')
    if (comma < 0) throw new PermanentSendError('Media data URL is malformed.', 'unsafe_media')
    mediaPayload = Buffer.from(media.data.slice(comma + 1), 'base64')
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(media.data)) {
    throw new PermanentSendError('Media URL must use HTTP or HTTPS.', 'unsafe_media')
  } else {
    mediaPayload = Buffer.from(media.data, 'base64')
  }
  if (Buffer.isBuffer(mediaPayload) && mediaPayload.length === 0) {
    throw new PermanentSendError('Media payload is empty.', 'unsafe_media')
  }

  const jid = await resolveRecipient(sock, target)

  let content: AnyMessageContent
  const mimetype = media.mimetype.toLowerCase()
  if (mimetype.startsWith('image/')) {
    content = {
      image: mediaPayload,
      caption: media.caption,
    }
  } else if (mimetype.startsWith('video/')) {
    content = {
      video: mediaPayload,
      caption: media.caption,
    }
  } else if (mimetype.startsWith('audio/')) {
    content = {
      audio: mediaPayload,
      mimetype,
    }
  } else {
    content = {
      document: mediaPayload,
      mimetype,
      fileName: mediaFilename(media.filename, 'document'),
      caption: media.caption,
    }
  }

  const sent = await sock.sendMessage(jid, content, { mediaUploadTimeoutMs: 60_000 })

  return {
    id: sent?.key?.id ?? '',
    timestamp:
      typeof sent?.messageTimestamp === 'number'
        ? sent.messageTimestamp
        : Math.floor(Date.now() / 1000),
    body: media.caption,
  }
}

/**
 * Send a reply-button message through the vendored native-flow profile.
 *
 * `relayMessage` is the low-level path because stock `sendMessage` has no
 * outbound interactive content type. The returned message id comes from the
 * relay; callers settle their outbox job with it.
 */
export async function sendBaileysButtons(
  sock: WASocket,
  target: string,
  input: ButtonsInput,
): Promise<MessageResult> {
  const jid = await resolveRecipient(sock, target)
  const content = buildReplyButtonsMessage(input)
  const full = generateWAMessageFromContent(jid, content, {
    userJid: sock.user?.id ?? jid,
  })

  const relayedId = await sock.relayMessage(jid, full.message ?? content, {
    messageId: full.key.id ?? undefined,
    additionalNodes: replyButtonsRelayNodes(),
  })

  return {
    id: relayedId || full.key.id || '',
    timestamp:
      typeof full.messageTimestamp === 'number'
        ? full.messageTimestamp
        : Math.floor(Date.now() / 1000),
    body: input.text,
  }
}
