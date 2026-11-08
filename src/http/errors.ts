import type { ContentfulStatusCode } from 'hono/utils/http-status'

/** An error that maps directly to an HTTP response. */
export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    message: string,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}
