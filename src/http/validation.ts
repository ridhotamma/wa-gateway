import { HttpError } from './errors.js'
import { mediaIdSchema, sessionIdSchema } from './schemas.js'

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
