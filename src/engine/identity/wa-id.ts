/**
 * Engine-neutral WhatsApp identity handling.
 * Ported & adapted from OpenWA (https://github.com/rmyndharis/OpenWA).
 *
 * Handles normalizing phone numbers, formatting JIDs, and de-normalizing
 * IDs across WhatsApp dialects (@s.whatsapp.net, @c.us, @lid, @g.us).
 */

export type WaIdKind = 'user' | 'group' | 'lid' | 'status' | 'newsletter' | 'broadcast' | 'unknown'

const DOMAIN_KINDS = new Map<string, WaIdKind>([
  ['c.us', 'user'],
  ['s.whatsapp.net', 'user'],
  ['lid', 'lid'],
  ['hosted', 'user'],
  ['hosted.lid', 'lid'],
  ['g.us', 'group'],
  ['newsletter', 'newsletter'],
  ['broadcast', 'broadcast'],
])

export interface ParsedWaId {
  kind: WaIdKind
  /** Local part without device suffix or domain (e.g. digits or group id) */
  userPart: string
  /** The multi-device suffix (:N), when present */
  device?: string
  /** The original JID */
  raw: string
}

/**
 * Parse any WhatsApp JID or phone number into a structured object.
 */
export function parseWaId(jid: string): ParsedWaId {
  if (!jid || typeof jid !== 'string') {
    return { kind: 'unknown', userPart: '', raw: jid || '' }
  }

  const trimmed = jid.trim()
  const atIndex = trimmed.indexOf('@')

  if (atIndex === -1) {
    const digits = normalizePhoneNumber(trimmed)
    return {
      kind: 'user',
      userPart: digits,
      raw: trimmed,
    }
  }

  const localPart = trimmed.slice(0, atIndex)
  const domain = trimmed.slice(atIndex + 1).toLowerCase()
  const kind = DOMAIN_KINDS.get(domain) ?? 'unknown'

  const colonIndex = localPart.indexOf(':')
  if (colonIndex !== -1) {
    return {
      kind,
      userPart: localPart.slice(0, colonIndex),
      device: localPart.slice(colonIndex + 1),
      raw: trimmed,
    }
  }

  return {
    kind,
    userPart: localPart,
    raw: trimmed,
  }
}

/**
 * Normalizes an Indonesian or international phone number into standard E.164 digits without '+' or punctuation.
 * e.g. "08123456789" -> "628123456789"
 *      "+62 812-3456-789" -> "628123456789"
 *      "628123456789" -> "628123456789"
 */
export function normalizePhoneNumber(phone: string, defaultCountryCode = '62'): string {
  if (!phone) return ''

  // Strip all non-digit characters
  let digits = phone.replace(/\D/g, '')

  if (!digits) return ''

  // If starts with 0, replace leading 0 with defaultCountryCode (e.g. 62)
  if (digits.startsWith('0')) {
    digits = defaultCountryCode + digits.slice(1)
  }

  return digits
}

/**
 * Formats a phone number or raw JID into Baileys protocol JID: `<phone>@s.whatsapp.net`.
 */
export function toBaileysJid(target: string): string {
  const parsed = parseWaId(target)
  if (parsed.kind === 'group') {
    return `${parsed.userPart}@g.us`
  }
  if (parsed.kind === 'lid') {
    return `${parsed.userPart}@lid`
  }
  const digits = normalizePhoneNumber(parsed.userPart)
  return `${digits}@s.whatsapp.net`
}

/**
 * Formats a phone number or raw JID into standard web JID: `<phone>@c.us`.
 */
export function toStandardJid(target: string): string {
  const parsed = parseWaId(target)
  if (parsed.kind === 'group') {
    return `${parsed.userPart}@g.us`
  }
  if (parsed.kind === 'lid') {
    return `${parsed.userPart}@lid`
  }
  const digits = normalizePhoneNumber(parsed.userPart)
  return `${digits}@c.us`
}

/**
 * Returns whether a JID is a WhatsApp group.
 */
export function isGroupJid(jid: string): boolean {
  return parseWaId(jid).kind === 'group'
}
