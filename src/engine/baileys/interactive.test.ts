import { describe, expect, test } from 'vitest'

import { buildReplyButtonsMessage, replyButtonsRelayNodes } from './interactive.js'

describe('reply-button wire profile', () => {
  test('wraps buttons in the buttonsMessage carrier WhatsApp renders', () => {
    const message = buildReplyButtonsMessage({
      text: 'Place this order?',
      footer: 'Reply with a button',
      buttons: [
        { id: 'yes', text: 'Yes' },
        { id: 'no', text: 'No' },
      ],
    })

    const carrier = message.documentWithCaptionMessage?.message?.buttonsMessage
    expect(carrier?.contentText).toBe('Place this order?')
    expect(carrier?.footerText).toBe('Reply with a button')
    expect(carrier?.buttons?.map((button) => button.buttonId)).toEqual(['yes', 'no'])
    expect(carrier?.buttons?.map((button) => button.buttonText?.displayText)).toEqual(['Yes', 'No'])
    expect(message.messageContextInfo?.messageSecret).toHaveLength(32)
  })

  test('rejects more than WhatsApp\u2019s three-button limit', () => {
    expect(() =>
      buildReplyButtonsMessage({
        text: 'Pick one',
        buttons: [
          { id: 'a', text: 'A' },
          { id: 'b', text: 'B' },
          { id: 'c', text: 'C' },
          { id: 'd', text: 'D' },
        ],
      }),
    ).toThrow()
  })

  test('adds the business nodes the relay expects', () => {
    const [biz] = replyButtonsRelayNodes()
    expect(biz?.tag).toBe('biz')
    expect(biz?.attrs?.actual_actors).toBe('2')
    expect(biz?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tag: 'interactive' }),
        expect.objectContaining({ tag: 'quality_control' }),
      ]),
    )
  })
})
