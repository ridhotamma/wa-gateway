import type { Context } from 'hono'
import type { ZodType } from 'zod'

import { HttpError } from './errors.js'
import { mediaIdSchema, sessionIdSchema } from './schemas.js'

/** Parse and validate a JSON body, throwing a 400 with a useful field name. */
export async function parseBody<T>(c: Context, schema: ZodType<T>): Promise<T> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    throw new HttpError(400, 'Invalid JSON body.')
  }

  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const field = issue?.path.join('.') || '(root)'
    throw new HttpError(400, `Invalid body: ${field} ${issue?.message ?? ''}`.trim())
  }
  return parsed.data
}

export function parseSessionId(raw: string): string {
  const parsed = sessionIdSchema.safeParse(raw)
  if (!parsed.success) {
    throw new HttpError(400, 'Invalid sessionId. Use 1-64 chars of [a-zA-Z0-9_-].')
  }
  return parsed.data
}

export function parseMediaId(raw: string): string {
  const parsed = mediaIdSchema.safeParse(raw)
  if (!parsed.success) throw new HttpError(400, 'Invalid media id.')
  return parsed.data
}
