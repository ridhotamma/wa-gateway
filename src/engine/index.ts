/**
 * The WhatsApp engine: transport only.
 *
 * What a message says is decided by the caller. This module owns the Baileys
 * socket, phone/JID normalization, reconnection policy and credential storage.
 */

export * from './types.js'
export * from './errors.js'
export * from './identity/wa-id.js'
export * from './baileys/baileys.adapter.js'
export * from './baileys/session-store.js'
export * from './baileys/messaging.js'
