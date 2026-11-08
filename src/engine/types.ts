/**
 * Engine contracts & interfaces for WhatsApp.
 * Extracted and streamlined from OpenWA (https://github.com/rmyndharis/OpenWA).
 */

export type EngineStatus =
  'disconnected' | 'initializing' | 'qr_ready' | 'authenticating' | 'ready' | 'failed'

export interface MessageResult {
  id: string
  timestamp: number
  body?: string
}

/**
 * The chat-state values needed to look like a person composing a reply.
 * WhatsApp clears `composing` on its own after a while, so senders should
 * follow it with `paused` once the message is ready.
 */
export type PresenceState = 'composing' | 'paused'

export interface MediaInput {
  mimetype: string
  /** Buffer, base64 string, or remote HTTP URL */
  data: Buffer | string
  filename?: string
  caption?: string
}

export interface ButtonsInput {
  /** Body text shown above the buttons. */
  text: string
  /** Optional footer below the buttons. */
  footer?: string
  /** WhatsApp allows at most three reply buttons. */
  buttons: InteractiveButton[]
}

export interface InteractiveButton {
  /** Stable id echoed back by WhatsApp when the customer taps it. */
  id: string
  /** Label shown on the button. */
  text: string
}

export type IncomingMediaKind = 'image' | 'video' | 'audio' | 'document' | 'sticker'

/**
 * A customer attachment as it crosses the daemon boundary.
 *
 * `data` is filled by the Baileys adapter after `downloadMediaMessage`; the
 * pure extraction step only knows the metadata. The daemon spools the bytes
 * before forwarding, so this never has to travel as JSON.
 */
export interface IncomingMedia {
  kind: IncomingMediaKind
  mimetype: string
  filename?: string
  sizeBytes: number
  /** Downloaded bytes, absent when extraction is pure or download failed. */
  data?: Buffer
}

export interface IncomingMessage {
  id: string
  from: string
  to: string
  chatId: string
  body?: string
  timestamp: number
  isFromMe: boolean
  hasMedia?: boolean
  media?: IncomingMedia
}

export interface EngineEventCallbacks {
  /** Triggered whenever connection status transitions */
  onStatusChange?: (status: EngineStatus, reason?: string) => void
  /** Triggered when a new QR code is ready for scanning */
  onQrCode?: (qr: string, qrDataUrl?: string) => void
  /** Triggered on incoming WhatsApp messages */
  onMessage?: (msg: IncomingMessage) => void
  /** Triggered on fatal or recoverable errors */
  onError?: (err: Error) => void
}

export interface WhatsAppEngine {
  /** Start socket connection and initialize session */
  initialize(callbacks: EngineEventCallbacks): Promise<void>

  /** Disconnect without clearing auth session */
  disconnect(): Promise<void>

  /** Log out and clear saved credentials */
  logout(): Promise<void>

  /** Check current engine status */
  getStatus(): EngineStatus

  /** Active liveness probe */
  probeLiveness?(): Promise<boolean>

  /** Send plain text message */
  sendTextMessage(to: string, text: string): Promise<MessageResult>

  /** Send media (image, document, video, audio) */
  sendMediaMessage(to: string, media: MediaInput): Promise<MessageResult>

  /** Send a message with up to three tappable reply buttons. */
  sendButtonsMessage(to: string, buttons: ButtonsInput): Promise<MessageResult>

  /** Show or clear the "typing…" indicator in a chat. */
  sendPresenceUpdate(to: string, state: PresenceState): Promise<void>
}
