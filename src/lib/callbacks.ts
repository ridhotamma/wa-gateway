/**
 * Callback URL helpers.
 *
 * A deployment can either provide a full template containing `{sessionId}`
 * (the tenant slug) or just a base origin. With a base origin we append the
 * platform's standard callback path:
 *
 *   https://hook.example.com  ->  https://hook.example.com/store/<slug>/whatsapp
 */

export type CallbackEndpoint = 'whatsapp' | 'whatsapp-status'

export function webhookUrlFor(
  template: string,
  sessionId: string,
  endpoint: CallbackEndpoint,
): string | null {
  const trimmed = template.trim()
  if (!trimmed) return null

  if (trimmed.includes('{sessionId}')) {
    return trimmed.replaceAll('{sessionId}', encodeURIComponent(sessionId))
  }

  return `${trimmed.replace(/\/+$/, '')}/store/${encodeURIComponent(sessionId)}/${endpoint}`
}

/**
 * Derive the send-status callback from the inbound one, so a deployment that
 * already forwards inbound needs no extra variable:
 *
 *   .../store/{slug}/whatsapp  ->  .../store/{slug}/whatsapp-status
 *
 * A base origin passes through untouched; `webhookUrlFor` appends the path.
 */
export function statusUrlFromInbound(inboundTemplate: string | null | undefined): string | null {
  const trimmed = inboundTemplate?.trim()
  if (!trimmed) return null
  return trimmed.replace(/\/whatsapp\/?$/, '/whatsapp-status')
}
