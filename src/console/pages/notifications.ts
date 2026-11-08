import type { ConsoleAdmin } from '../../services/console-auth.js'
import { listSessionRows } from '../data.js'
import { html, raw, type Html } from '../html.js'
import type { Flash } from '../layout.js'
import { shell } from '../layout.js'
import type { ConsoleDependencies } from '../types.js'
import { cardHead, emptyState, header, icon } from '../ui.js'

export interface NoticeFormValues {
  mode: 'text' | 'buttons' | 'media'
  delivery: 'direct' | 'queue'
  sessionId: string
  phone: string
  text: string
  footer: string
  buttonId1: string
  buttonText1: string
  buttonId2: string
  buttonText2: string
  buttonId3: string
  buttonText3: string
  mediaData: string
  mimetype: string
  filename: string
  caption: string
  kind: string
  idempotencyKey: string
}

export function noticeDefaults(): NoticeFormValues {
  return {
    mode: 'text',
    delivery: 'direct',
    sessionId: '',
    phone: '',
    text: '',
    footer: '',
    buttonId1: '',
    buttonText1: '',
    buttonId2: '',
    buttonText2: '',
    buttonId3: '',
    buttonText3: '',
    mediaData: '',
    mimetype: 'image/jpeg',
    filename: '',
    caption: '',
    kind: 'console.test',
    idempotencyKey: '',
  }
}

export function renderNotifications(
  deps: ConsoleDependencies,
  admin: ConsoleAdmin,
  flash: Flash,
  values: NoticeFormValues = noticeDefaults(),
): Html {
  const sessions = listSessionRows(deps)

  return shell(
    'Notifications',
    { section: 'notifications', admin: admin.email },
    html`
      ${header('Notifications')}
      ${
        sessions.length === 0
          ? html`<div class="card">
              ${emptyState(
                'No session to send from',
                'Pair a WhatsApp number first, then come back to test a notification.',
                html`<a class="btn primary" href="/console/sessions">Pair a session</a>`,
              )}
            </div>`
          : html`
              <div class="card">
                ${cardHead('Send a message')}
                <p class="hint">
                  Direct sends happen immediately and need a ready session. Queued sends are written
                  to SQLite, paced by the outbox, and retried.
                </p>
                <form method="post" action="/console/notifications">
                  <div class="fields">
                    <label
                      >Session<select name="sessionId" required>
                        <option value="">Choose a session</option>
                        ${sessions.map(
                          (session) =>
                            html`<option
                              value="${session.sessionId}"
                              ${session.sessionId === values.sessionId ? html`selected` : ''}
                            >
                              ${session.sessionId} · ${session.status}
                            </option>`,
                        )}
                      </select></label
                    >
                    <label
                      >Delivery<select name="delivery" id="notice-delivery">
                        <option
                          value="direct"
                          ${values.delivery === 'direct' ? html`selected` : ''}
                        >
                          Send now
                        </option>
                        <option value="queue" ${values.delivery === 'queue' ? html`selected` : ''}>
                          Queue and retry
                        </option>
                      </select></label
                    >
                    <label
                      >Message type<select name="mode" id="notice-mode">
                        <option value="text" ${values.mode === 'text' ? html`selected` : ''}>
                          Text
                        </option>
                        <option value="buttons" ${values.mode === 'buttons' ? html`selected` : ''}>
                          Text + reply buttons
                        </option>
                        <option value="media" ${values.mode === 'media' ? html`selected` : ''}>
                          Media
                        </option>
                      </select></label
                    >
                  </div>

                  <div class="fields">
                    <label
                      >Phone number<input
                        name="phone"
                        value="${values.phone}"
                        placeholder="6281234567890"
                        required
                        autocomplete="off"
                    /></label>
                  </div>

                  <label
                    >Message body<textarea
                      name="text"
                      rows="4"
                      placeholder="Halo kak, pesanan sudah siap."
                    >
${values.text}</textarea
                    ><small
                      >For buttons this is the body above the buttons (1–1024 characters).</small
                    ></label
                  >

                  <div id="notice-media" class="stack-fields">
                    <label
                      >Media URL or base64<textarea
                        name="mediaData"
                        rows="4"
                        class="mono"
                        placeholder="https://example.com/invoice.pdf"
                      >
${values.mediaData}</textarea
                      ><small
                        >A URL is best. Base64 up to 1.5 MB when queued; direct sends accept larger
                        payloads.</small
                      ></label
                    >
                    <div class="fields">
                      <label>MIME type<input name="mimetype" value="${values.mimetype}" /></label>
                      <label
                        >Filename<input
                          name="filename"
                          value="${values.filename}"
                          placeholder="invoice.pdf"
                      /></label>
                      <label
                        >Caption<input
                          name="caption"
                          value="${values.caption}"
                          placeholder="Optional caption"
                      /></label>
                    </div>
                  </div>

                  <div id="notice-buttons" class="stack-fields">
                    <label
                      >Footer<input
                        name="footer"
                        value="${values.footer}"
                        maxlength="60"
                        placeholder="Optional line below the buttons"
                    /></label>
                    <div class="fields">
                      <label
                        >Button 1 id<input
                          name="buttonId1"
                          value="${values.buttonId1}"
                          placeholder="yes"
                      /></label>
                      <label
                        >Button 1 label<input
                          name="buttonText1"
                          value="${values.buttonText1}"
                          maxlength="20"
                          placeholder="Ya"
                      /></label>
                    </div>
                    <div class="fields">
                      <label
                        >Button 2 id<input
                          name="buttonId2"
                          value="${values.buttonId2}"
                          placeholder="no"
                      /></label>
                      <label
                        >Button 2 label<input
                          name="buttonText2"
                          value="${values.buttonText2}"
                          maxlength="20"
                          placeholder="Batal"
                      /></label>
                    </div>
                    <div class="fields">
                      <label
                        >Button 3 id<input
                          name="buttonId3"
                          value="${values.buttonId3}"
                          placeholder="later"
                      /></label>
                      <label
                        >Button 3 label<input
                          name="buttonText3"
                          value="${values.buttonText3}"
                          maxlength="20"
                          placeholder="Nanti"
                      /></label>
                    </div>
                    <p class="hint">
                      Up to three buttons. WhatsApp requires a body; the same options should be
                      clear in the text too.
                    </p>
                  </div>

                  <div id="notice-queue" class="stack-fields">
                    <div class="fields">
                      <label
                        >Kind<input name="kind" value="${values.kind}" placeholder="order.paid"
                      /></label>
                      <label
                        >Idempotency key<input
                          name="idempotencyKey"
                          value="${values.idempotencyKey}"
                          placeholder="order:123:paid"
                      /></label>
                    </div>
                  </div>

                  <div class="foot">
                    <button class="primary" type="submit">${icon('lightning')}Send message</button>
                  </div>
                </form>
              </div>
              <script>
                ${raw(noticeScript(values.mode, values.delivery))}
              </script>
            `
      }
    `,
    flash,
  )
}

function noticeScript(mode: string, delivery: string): string {
  return `
(() => {
  const modeEl = document.getElementById('notice-mode')
  const deliveryEl = document.getElementById('notice-delivery')
  const media = document.getElementById('notice-media')
  const buttons = document.getElementById('notice-buttons')
  const queue = document.getElementById('notice-queue')
  function sync() {
    const mode = modeEl ? modeEl.value : ${JSON.stringify(mode)}
    const how = deliveryEl ? deliveryEl.value : ${JSON.stringify(delivery)}
    if (media) media.hidden = mode !== 'media'
    if (buttons) buttons.hidden = mode !== 'buttons'
    if (queue) queue.hidden = how !== 'queue'
  }
  modeEl?.addEventListener('change', sync)
  deliveryEl?.addEventListener('change', sync)
  sync()
})()
`
}
