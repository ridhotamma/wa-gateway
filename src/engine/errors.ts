/**
 * A send that can never succeed however often it is retried — the number is
 * not on WhatsApp, or is not a phone number at all. Queues should drop the
 * message instead of backing off.
 */
export class PermanentSendError extends Error {
  constructor(
    message: string,
    readonly code: 'not_on_whatsapp' | 'invalid_recipient' | 'unsafe_media',
  ) {
    super(message)
    this.name = 'PermanentSendError'
  }
}

/** A remote media URL that would make the daemon fetch a private address. */
export class UnsafeMediaUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeMediaUrlError'
  }
}
