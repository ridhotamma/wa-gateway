/** Tagged-template HTML with escaping by default. Wrap trusted markup in `raw()` or nest `html` results. */

export class Html {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value
  }
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export const escape = (value: unknown): string =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]!)

export const raw = (value: string): Html => new Html(value)

function render(value: unknown): string {
  if (value instanceof Html) return value.value
  if (Array.isArray(value)) return value.map(render).join('')
  if (value === null || value === undefined || value === false) return ''
  return escape(value)
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0]!
  values.forEach((v, i) => (out += render(v) + strings[i + 1]!))
  return new Html(out)
}

export function page(
  body: Html | string,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  const text = String(body)
  return new Response(text, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(Buffer.byteLength(text)),
      'cache-control': 'no-store',
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      // Keep the referrer same-origin. `no-referrer` makes Chrome send
      // `Origin: null` on same-origin form POSTs, which breaks CSRF checks
      // behind a console that has no secret-bearing URLs anyway.
      'referrer-policy': 'same-origin',
      'permissions-policy': 'camera=(), microphone=(), geolocation=()',
      ...headers,
    },
  })
}
