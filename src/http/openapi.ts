import { z } from '@hono/zod-openapi'

import { mediaIdSchema, sessionIdSchema } from './schemas.js'

/**
 * OpenAPI response schemas and shared parameter metadata.
 *
 * Request schemas live in `schemas.ts` and are reused directly by the routes,
 * so the documented bodies and the runtime validators cannot drift apart.
 */

export const engineStatusSchema = z
  .enum(['disconnected', 'initializing', 'qr_ready', 'authenticating', 'ready', 'failed'])
  .openapi('EngineStatus')

export const sessionIdParamSchema = sessionIdSchema.openapi({
  param: { name: 'sessionId', in: 'path' },
  description: 'Tenant slug: 1–64 characters of `[a-zA-Z0-9_-]`.',
  example: 'shop',
})

export const mediaIdParamSchema = mediaIdSchema.openapi({
  param: { name: 'mediaId', in: 'path' },
  description: 'Spooled inbound attachment id (32 lowercase hex characters).',
  example: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
})

export const errorResponseSchema = z
  .object({
    ok: z.literal(false),
    error: z.string(),
    code: z.string().optional(),
    queued: z.boolean().optional(),
  })
  .openapi('ApiError', {
    description: 'A rejected request. `code` appears on permanent send failures.',
    example: { ok: false, error: 'Session is not connected or ready' },
  })

export const outboxStatsSchema = z
  .object({
    pending: z.number().int().nonnegative(),
    failedLastDay: z.number().int().nonnegative(),
  })
  .openapi('OutboxStats')

export const outboxTotalsSchema = z
  .object({
    pending: z.number().int().nonnegative(),
    sessionsWithPending: z.number().int().nonnegative(),
    failedLastDay: z.number().int().nonnegative(),
    doneLastDay: z.number().int().nonnegative(),
  })
  .openapi('OutboxTotals')

export const sessionSummarySchema = z
  .object({
    sessionId: sessionIdSchema,
    status: engineStatusSchema,
    reason: z.string().optional(),
  })
  .openapi('SessionSummary')

export const sessionViewSchema = z
  .object({
    sessionId: sessionIdSchema,
    engineType: z.literal('baileys'),
    status: engineStatusSchema,
    qrDataUrl: z
      .string()
      .optional()
      .openapi({ description: 'PNG data URL while `status` is `qr_ready`.' }),
    lastReason: z.string().optional(),
  })
  .openapi('SessionView')

export const sessionStatusSchema = z
  .object({
    ok: z.literal(true),
    session: sessionViewSchema.extend({ outbox: outboxStatsSchema }),
  })
  .openapi('SessionStatusResponse')

export const healthResponseSchema = z
  .object({
    status: z.literal('ok'),
    uptime: z.number().describe('Process uptime in seconds.'),
    instanceId: z.string().optional().describe('Present for authenticated callers.'),
    authEnabled: z.boolean().optional(),
    sessionCount: z.number().int().nonnegative().optional(),
    readyCount: z.number().int().nonnegative().optional(),
    outbox: outboxTotalsSchema.optional(),
    sessions: z.array(sessionSummarySchema).optional(),
  })
  .openapi('Health', {
    description:
      'Public callers receive `status` and `uptime` only. Authenticated callers also receive the inventory.',
  })

export const startSessionResponseSchema = z
  .object({
    ok: z.literal(true),
    session: sessionViewSchema,
  })
  .openapi('StartSessionResponse')

export const queuedResponseSchema = z
  .object({
    ok: z.literal(true),
    queued: z.literal(true),
    jobId: z.string(),
    duplicate: z.boolean().describe('True when the idempotency key was already queued.'),
  })
  .openapi('QueuedNotification', {
    example: { ok: true, queued: true, jobId: '1f0c…', duplicate: false },
  })

export const messageResultSchema = z
  .object({
    id: z.string(),
    timestamp: z.number().int().describe('Unix timestamp in seconds.'),
  })
  .openapi('MessageResult')

export const sendMessageResponseSchema = z
  .object({
    ok: z.literal(true),
    result: messageResultSchema,
  })
  .openapi('SendMessageResponse', {
    example: { ok: true, result: { id: '3EB0…', timestamp: 1710000000 } },
  })

export const okResponseSchema = z.object({ ok: z.literal(true) }).openapi('OkResponse')

export const binaryResponseSchema = z.string().openapi({
  description: 'Raw attachment bytes.',
  format: 'binary',
})

/** Build a standard JSON error response for an OpenAPI route. */
export function errorResponse(description: string, example?: z.infer<typeof errorResponseSchema>) {
  return {
    description,
    content: {
      'application/json': {
        schema: errorResponseSchema,
        ...(example ? { example } : {}),
      },
    },
  }
}

/** Security requirements accepted by every protected endpoint. */
export const API_SECURITY: Array<Record<string, string[]>> = [{ apiKey: [] }, { bearerAuth: [] }]
