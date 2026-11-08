/**
 * Reply-button sending for Baileys 7.
 *
 * Vanilla Baileys can read `buttonsResponseMessage` but has no outbound
 * interactive content. This module vendors the wire profile used by the
 * community `baileys` native-interactive fork
 * (`src/Utils/interactive-messages.ts` at revision 1441cf32): the
 * `buttonsMessage` carrier plus the `biz > interactive/native_flow` and
 * `quality_control` relay nodes WhatsApp expects. It is deliberately narrow —
 * up to three text reply buttons, no media header, no carousel — because that
 * is the shape the chatbot's yes/no prompts need.
 *
 * The profile is unofficial. WhatsApp may stop rendering it, and it carries
 * more ban risk than a plain text message. Callers must always render the
 * same options in the body text so the message still makes sense if a client
 * drops the buttons.
 */

import { randomBytes } from 'node:crypto'
import { proto } from 'baileys'
import type { BinaryNode } from 'baileys'
import type { ButtonsInput } from '../types.js'

/** WhatsApp's own reply-button limit. */
export const MAX_REPLY_BUTTONS = 3

export function buildReplyButtonsMessage(input: ButtonsInput): proto.IMessage {
  const text = input.text.trim()
  if (!text || text.length > 1_024) {
    throw new Error('A reply-button message needs body text of 1–1024 characters.')
  }
  const footer = input.footer?.trim()
  if (footer && footer.length > 60) {
    throw new Error('A reply-button footer cannot exceed 60 characters.')
  }
  if (input.buttons.length === 0 || input.buttons.length > MAX_REPLY_BUTTONS) {
    throw new Error(`A reply-button message needs 1–${MAX_REPLY_BUTTONS} buttons.`)
  }
  for (const button of input.buttons) {
    if (!button.id.trim() || button.id.length > 64) {
      throw new Error('Each reply button needs an id of 1–64 characters.')
    }
    if (!button.text.trim() || button.text.length > 20) {
      throw new Error('Each reply button label must be 1–20 characters.')
    }
  }

  return proto.Message.create({
    // Fresh opaque metadata mirrors the measured fork profile; these fields
    // are not a verified Signal-key digest, but clients expect them present.
    messageContextInfo: {
      messageSecret: randomBytes(32),
      deviceListMetadata: {
        recipientKeyHash: randomBytes(10),
        recipientTimestamp: Math.floor(Date.now() / 1000),
      },
      deviceListMetadataVersion: 2,
    },
    documentWithCaptionMessage: {
      message: {
        buttonsMessage: {
          contentText: text,
          ...(footer ? { footerText: footer } : {}),
          headerType: proto.Message.ButtonsMessage.HeaderType.EMPTY,
          buttons: input.buttons.map((button) => ({
            buttonId: button.id.trim(),
            buttonText: { displayText: button.text.trim() },
            type: proto.Message.ButtonsMessage.Button.Type.RESPONSE,
          })),
        },
      },
    },
  })
}

/**
 * The business nodes `sendMessage` normally builds from the high-level
 * content; `relayMessage` needs them handed over explicitly.
 */
export function replyButtonsRelayNodes(): BinaryNode[] {
  return [
    {
      tag: 'biz',
      attrs: {
        actual_actors: '2',
        host_storage: '2',
        privacy_mode_ts: Math.floor(Date.now() / 1000).toString(),
      },
      content: [
        {
          tag: 'interactive',
          attrs: { type: 'native_flow', v: '1' },
          content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }],
        },
        {
          tag: 'quality_control',
          attrs: {
            decision_id: randomBytes(20).toString('hex'),
            source_type: 'third_party',
          },
          content: [{ tag: 'decision_source', attrs: { value: 'df' } }],
        },
      ],
    },
  ]
}
