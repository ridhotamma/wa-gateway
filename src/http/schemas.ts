import { z } from '@hono/zod-openapi'

/** Session ids become auth-file directory names — restrict to a safe alphabet. */
export const sessionIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)

export const mediaIdSchema = z.string().regex(/^[a-f0-9]{32}$/)

export const phoneSchema = z.string().trim().min(6).max(32)

/** Log label only, e.g. `order.paid` or `stock.out`. */
export const kindSchema = z
  .string()
  .regex(/^[a-z_]+(\.[a-z_]+)*$/)
  .max(64)

export const idempotencyKeySchema = z.string().min(1).max(200)

/** A plausible MIME type; rejects header/newline tricks before Baileys sees it. */
export const mimeSchema = z
  .string()
  .trim()
  .min(3)
  .max(255)
  .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i)

/**
 * Queued attachments should normally be URLs. Base64 is kept for small
 * images, but a multi-megabyte payload in a JSON outbox job makes startup and
 * retries expensive; direct sends remain available for large files.
 */
export const MAX_QUEUED_MEDIA_BASE64 = 1_500_000

export const mediaPayloadSchema = z
  .object({
    data: z.string().min(1).max(8_000_000).describe('Public HTTP(S) URL or base64 bytes.'),
    mimetype: mimeSchema.transform((value) => value.toLowerCase()),
    filename: z.string().trim().min(1).max(255).optional(),
    caption: z.string().trim().max(1_024).optional(),
  })
  .refine((media) => !/^https?:\/\//i.test(media.data) || media.data.length <= 4_096, {
    message: 'Media URL is too long.',
    path: ['data'],
  })
  .openapi('MediaPayload', {
    description:
      'Queued base64 payloads are limited to 1.5 MB; use a URL below that, or `/messages/send-media` for large direct sends.',
    example: {
      data: 'https://cdn.example.com/invoice.pdf',
      mimetype: 'application/pdf',
      filename: 'invoice.pdf',
      caption: 'Your invoice',
    },
  })

export const buttonPayloadSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    text: z.string().trim().min(1).max(20),
  })
  .openapi('Button')

export const buttonsPayloadSchema = z
  .object({
    // WhatsApp's interactive body/footer limits; fail fast instead of
    // accepting a job that Baileys could never render.
    text: z.string().trim().min(1).max(1_024),
    footer: z.string().trim().max(60).optional(),
    buttons: z.array(buttonPayloadSchema).min(1).max(3),
  })
  .openapi('ButtonsPayload', {
    example: {
      text: 'Confirm your order?',
      footer: 'Reply within 24 hours',
      buttons: [
        { id: 'confirm', text: 'Yes' },
        { id: 'cancel', text: 'No' },
      ],
    },
  })

export const textNotifySchema = z
  .object({
    sessionId: sessionIdSchema,
    phone: phoneSchema,
    kind: kindSchema,
    /** Rendered by the caller; the gateway never sees templates. */
    text: z.string().trim().min(1).max(4_096),
    idempotencyKey: idempotencyKeySchema,
    /** Show "typing…" before delivery; chatbot replies set this. */
    typing: z.boolean().optional(),
  })
  .openapi('TextNotification', {
    example: {
      sessionId: 'shop',
      phone: '6281234567890',
      kind: 'order.paid',
      text: 'Payment received. Your order is being prepared.',
      idempotencyKey: 'order-1234-paid',
      typing: true,
    },
  })

export const mediaNotifySchema = z
  .object({
    sessionId: sessionIdSchema,
    phone: phoneSchema,
    kind: kindSchema,
    text: z.string().trim().max(1_024).default(''),
    media: mediaPayloadSchema,
    idempotencyKey: idempotencyKeySchema,
  })
  .openapi('MediaNotification', {
    example: {
      sessionId: 'shop',
      phone: '6281234567890',
      kind: 'invoice.ready',
      idempotencyKey: 'invoice-1234',
      media: {
        data: 'https://cdn.example.com/invoice.pdf',
        mimetype: 'application/pdf',
        filename: 'invoice.pdf',
        caption: 'Your invoice',
      },
    },
  })

export const buttonsNotifySchema = z
  .object({
    sessionId: sessionIdSchema,
    phone: phoneSchema,
    kind: kindSchema,
    idempotencyKey: idempotencyKeySchema,
    message: buttonsPayloadSchema,
    /** Show "typing…" before the buttons appear; chatbot replies set this. */
    typing: z.boolean().optional(),
  })
  .openapi('ButtonsNotification', {
    example: {
      sessionId: 'shop',
      phone: '6281234567890',
      kind: 'order.confirm',
      idempotencyKey: 'order-1234-confirm',
      message: {
        text: 'Confirm your order?',
        footer: 'Reply within 24 hours',
        buttons: [
          { id: 'confirm', text: 'Yes' },
          { id: 'cancel', text: 'No' },
        ],
      },
    },
  })

export const messageSendSchema = z
  .object({
    sessionId: sessionIdSchema,
    to: phoneSchema,
    text: z.string().min(1).max(2_000),
  })
  .openapi('SendTextRequest', {
    example: { sessionId: 'shop', to: '6281234567890', text: 'Hello.' },
  })

export const messageSendMediaSchema = z
  .object({
    sessionId: sessionIdSchema,
    to: phoneSchema,
    media: mediaPayloadSchema,
    text: z.string().trim().max(1_024).default(''),
  })
  .openapi('SendMediaRequest', {
    example: {
      sessionId: 'shop',
      to: '6281234567890',
      text: 'Your invoice.',
      media: {
        data: 'https://cdn.example.com/invoice.pdf',
        mimetype: 'application/pdf',
        filename: 'invoice.pdf',
      },
    },
  })

export const messageSendButtonsSchema = z
  .object({
    sessionId: sessionIdSchema,
    to: phoneSchema,
    message: buttonsPayloadSchema,
  })
  .openapi('SendButtonsRequest', {
    example: {
      sessionId: 'shop',
      to: '6281234567890',
      message: {
        text: 'Confirm your order?',
        footer: 'Reply within 24 hours',
        buttons: [
          { id: 'confirm', text: 'Yes' },
          { id: 'cancel', text: 'No' },
        ],
      },
    },
  })

export const renameSchema = z
  .object({ to: sessionIdSchema })
  .openapi('RenameSessionRequest', { example: { to: 'new-shop' } })
