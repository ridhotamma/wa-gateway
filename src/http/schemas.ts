import { z } from 'zod'

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
    data: z.string().min(1).max(8_000_000),
    mimetype: mimeSchema.transform((value) => value.toLowerCase()),
    filename: z.string().trim().min(1).max(255).optional(),
    caption: z.string().trim().max(1_024).optional(),
  })
  .refine((media) => !/^https?:\/\//i.test(media.data) || media.data.length <= 4_096, {
    message: 'Media URL is too long.',
    path: ['data'],
  })

export const buttonPayloadSchema = z.object({
  id: z.string().trim().min(1).max(64),
  text: z.string().trim().min(1).max(20),
})

export const buttonsPayloadSchema = z.object({
  // WhatsApp's interactive body/footer limits; fail fast instead of
  // accepting a job that Baileys could never render.
  text: z.string().trim().min(1).max(1_024),
  footer: z.string().trim().max(60).optional(),
  buttons: z.array(buttonPayloadSchema).min(1).max(3),
})

export const textNotifySchema = z.object({
  sessionId: sessionIdSchema,
  phone: phoneSchema,
  kind: kindSchema,
  /** Rendered by the caller; the gateway never sees templates. */
  text: z.string().trim().min(1).max(4_096),
  idempotencyKey: idempotencyKeySchema,
  /** Show "typing…" before delivery; chatbot replies set this. */
  typing: z.boolean().optional(),
})

export const mediaNotifySchema = z.object({
  sessionId: sessionIdSchema,
  phone: phoneSchema,
  kind: kindSchema,
  text: z.string().trim().max(1_024).default(''),
  media: mediaPayloadSchema,
  idempotencyKey: idempotencyKeySchema,
})

export const buttonsNotifySchema = z.object({
  sessionId: sessionIdSchema,
  phone: phoneSchema,
  kind: kindSchema,
  idempotencyKey: idempotencyKeySchema,
  message: buttonsPayloadSchema,
  /** Show "typing…" before the buttons appear; chatbot replies set this. */
  typing: z.boolean().optional(),
})

export const messageSendSchema = z.object({
  sessionId: sessionIdSchema,
  to: phoneSchema,
  text: z.string().min(1).max(2_000),
})

export const messageSendMediaSchema = z.object({
  sessionId: sessionIdSchema,
  to: phoneSchema,
  media: mediaPayloadSchema,
  text: z.string().trim().max(1_024).default(''),
})

export const messageSendButtonsSchema = z.object({
  sessionId: sessionIdSchema,
  to: phoneSchema,
  message: buttonsPayloadSchema,
})

export const renameSchema = z.object({ to: sessionIdSchema })
