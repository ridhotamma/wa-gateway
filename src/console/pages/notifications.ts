import type { ConsoleAdmin } from '../../services/console-auth.js'
import { listSessionRows } from '../data.js'
import { html, raw, type Html } from '../html.js'
import type { Flash } from '../layout.js'
import { shell } from '../layout.js'
import type { ConsoleDependencies } from '../types.js'
import { MAX_UPLOAD_BYTES, MIME_BY_EXTENSION } from '../media.js'
import { emptyState, header, icon } from '../ui.js'

export interface NoticeFormValues {
  mode: 'text' | 'buttons' | 'media'
  mediaSource: 'upload' | 'url'
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
    mediaSource: 'upload',
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
    mimetype: '',
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
  const segment = (name: string, current: string, options: Array<[string, string]>) =>
    html`<div class="segmented" role="radiogroup">
      ${options.map(
        ([value, label]) =>
          html`<label
            ><input
              type="radio"
              name="${name}"
              value="${value}"
              ${current === value ? html`checked` : ''}
            /><span>${label}</span></label
          >`,
      )}
    </div>`
  const button = (n: 1 | 2 | 3, id: string, label: string) =>
    html`<div class="fields">
      <label
        >Button ${n} id<input
          name="buttonId${n}"
          value="${values[`buttonId${n}`]}"
          class="mono"
          placeholder="${id}"
      /></label>
      <label
        >Button ${n} label<input
          name="buttonText${n}"
          value="${values[`buttonText${n}`]}"
          maxlength="20"
          placeholder="${label}"
      /></label>
    </div>`

  return shell(
    'Notifications',
    { section: 'notifications', admin: admin.email },
    html`
      ${header('Notifications', {
        description: 'Send a test message from one of your sessions.',
      })}
      ${
        sessions.length === 0
          ? html`<div class="card">
              ${emptyState(
                'No session to send from',
                'Pair a WhatsApp number first, then come back to test a notification.',
                html`<a class="btn primary" href="/console/sessions"
                  >${icon('plus')}Pair a session</a
                >`,
                'lightning',
              )}
            </div>`
          : html`
              <div class="narrow">
                <form
                  method="post"
                  action="/console/notifications"
                  enctype="multipart/form-data"
                  class="card"
                  id="notice-form"
                >
                  <section class="form-block">
                    <h3 class="form-block-title">Recipient</h3>
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
                                ${session.sessionId} · ${session.status.replaceAll('_', ' ')}
                              </option>`,
                          )}
                        </select></label
                      >
                      <label
                        >Phone number<input
                          name="phone"
                          value="${values.phone}"
                          placeholder="6281234567890"
                          inputmode="tel"
                          required
                          autocomplete="off"
                      /></label>
                    </div>
                  </section>

                  <section class="form-block">
                    <h3 class="form-block-title">Message</h3>
                    <div class="field-group">
                      <span class="field-label">Type</span>
                      ${segment('mode', values.mode, [
                        ['text', 'Text'],
                        ['buttons', 'Reply buttons'],
                        ['media', 'Media'],
                      ])}
                    </div>

                    <div id="notice-media" class="stack-fields">
                      <div class="field-group">
                        <span class="field-label">Source</span>
                        ${segment('mediaSource', values.mediaSource, [
                          ['upload', 'Upload file'],
                          ['url', 'URL or base64'],
                        ])}
                      </div>

                      <div id="media-upload" class="field-group">
                        <label class="dropzone" id="media-dropzone">
                          <input type="file" name="mediaFile" id="media-file" />
                          <span class="dropzone-icon">${icon('upload-simple', 20)}</span>
                          <span class="dropzone-text">
                            <b id="media-file-name">Choose a file or drop it here</b>
                            <span id="media-file-meta"
                              >Image, video, audio or document up to 7 MB. Queued uploads up to
                              about 1 MB.</span
                            >
                          </span>
                        </label>
                        <small class="help error" id="media-file-error" hidden></small>
                      </div>

                      <div id="media-url">
                        <label
                          >Media URL or base64<textarea
                            name="mediaData"
                            id="media-data"
                            rows="3"
                            class="mono"
                            placeholder="https://example.com/invoice.pdf"
                          >
${values.mediaData}</textarea
                          ><small>A URL is best for large files.</small></label
                        >
                      </div>

                      <div class="fields">
                        <label
                          >MIME type<input
                            name="mimetype"
                            id="media-mimetype"
                            value="${values.mimetype}"
                            class="mono"
                            placeholder="Detected automatically"
                            autocomplete="off"
                        /></label>
                        <label
                          >Filename<input
                            name="filename"
                            id="media-filename"
                            value="${values.filename}"
                            placeholder="invoice.pdf"
                            autocomplete="off"
                        /></label>
                      </div>
                      <label
                        >Caption<input
                          name="caption"
                          value="${values.caption}"
                          placeholder="Optional caption"
                      /></label>
                    </div>

                    <label
                      >Message body<textarea
                        name="text"
                        rows="4"
                        placeholder="Halo kak, pesanan sudah siap."
                      >
${values.text}</textarea
                      ><small id="notice-text-help"
                        >For buttons this is the body above the buttons (1–1024 characters).</small
                      ></label
                    >

                    <div id="notice-buttons" class="stack-fields">
                      ${button(1, 'yes', 'Ya')} ${button(2, 'no', 'Batal')}
                      ${button(3, 'later', 'Nanti')}
                      <label
                        >Footer<input
                          name="footer"
                          value="${values.footer}"
                          maxlength="60"
                          placeholder="Optional line below the buttons"
                        /><small
                          >Up to three buttons. Make the same options clear in the body too.</small
                        ></label
                      >
                    </div>
                  </section>

                  <section class="form-block">
                    <h3 class="form-block-title">Delivery</h3>
                    <div class="field-group">
                      ${segment('delivery', values.delivery, [
                        ['direct', 'Send now'],
                        ['queue', 'Queue and retry'],
                      ])}
                      <small class="help"
                        >Send now needs a ready session. Queued messages are stored, paced by the
                        outbox and retried.</small
                      >
                    </div>
                    <div id="notice-queue" class="fields">
                      <label
                        >Kind<input
                          name="kind"
                          value="${values.kind}"
                          class="mono"
                          placeholder="order.paid"
                      /></label>
                      <label
                        >Idempotency key<input
                          name="idempotencyKey"
                          value="${values.idempotencyKey}"
                          class="mono"
                          placeholder="order:123:paid"
                      /></label>
                    </div>
                    <div class="foot">
                      <button class="primary" type="submit">
                        ${icon('lightning')}Send message
                      </button>
                    </div>
                  </section>
                </form>
              </div>
              <script>
                ${raw(noticeScript())}
              </script>
            `
      }
    `,
    flash,
  )
}

function noticeScript(): string {
  return `
(() => {
  const form = document.getElementById('notice-form')
  if (!form) return
  const $ = (id) => document.getElementById(id)
  const media = $('notice-media')
  const buttons = $('notice-buttons')
  const queue = $('notice-queue')
  const textHelp = $('notice-text-help')
  const upload = $('media-upload')
  const url = $('media-url')
  const fileInput = $('media-file')
  const zone = $('media-dropzone')
  const fileName = $('media-file-name')
  const fileMeta = $('media-file-meta')
  const fileError = $('media-file-error')
  const dataInput = $('media-data')
  const mimeInput = $('media-mimetype')
  const nameInput = $('media-filename')
  const MAX = ${MAX_UPLOAD_BYTES}
  const BY_EXT = ${JSON.stringify(MIME_BY_EXTENSION)}
  const emptyName = fileName.textContent
  const emptyMeta = fileMeta.textContent
  const picked = (name) => form.querySelector('input[name="' + name + '"]:checked')?.value

  function guess(name) {
    let path = name || ''
    try { path = new URL(path).pathname } catch {}
    const ext = /\\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase()
    return ext ? BY_EXT[ext] || '' : ''
  }
  // Fill a field only when it is empty or still holds a value we filled in.
  function autofill(input, value) {
    if (!input) return
    if (input.value && input.dataset.auto !== input.value) return
    input.value = value || ''
    input.dataset.auto = input.value
  }
  function size(n) {
    return n < 1024 * 1024 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1024 / 1024).toFixed(1) + ' MB'
  }
  function showFile() {
    const file = fileInput.files && fileInput.files[0]
    fileError.hidden = true
    if (!file) {
      zone.classList.remove('has-file')
      fileName.textContent = emptyName
      fileMeta.textContent = emptyMeta
      return
    }
    if (file.size > MAX) {
      fileInput.value = ''
      showFile()
      fileError.textContent = file.name + ' is ' + size(file.size) + '. Uploads are limited to 7 MB; use a URL instead.'
      fileError.hidden = false
      return
    }
    const type = file.type || guess(file.name)
    zone.classList.add('has-file')
    fileName.textContent = file.name
    fileMeta.textContent = size(file.size) + ' · ' + (type || 'unknown type') + ' · click to replace'
    autofill(mimeInput, type)
    autofill(nameInput, file.name)
  }
  function sync() {
    const mode = picked('mode') || 'text'
    const source = picked('mediaSource') || 'upload'
    media.hidden = mode !== 'media'
    buttons.hidden = mode !== 'buttons'
    textHelp.hidden = mode !== 'buttons'
    queue.hidden = picked('delivery') !== 'queue'
    upload.hidden = source !== 'upload'
    url.hidden = source !== 'url'
  }

  fileInput.addEventListener('change', showFile)
  dataInput.addEventListener('input', () => {
    const value = dataInput.value.trim()
    if (/^https?:\\/\\//i.test(value)) {
      autofill(mimeInput, guess(value))
      try { autofill(nameInput, decodeURIComponent(new URL(value).pathname.split('/').pop() || '')) } catch {}
    }
  })
  for (const type of ['dragenter', 'dragover']) zone.addEventListener(type, () => zone.classList.add('is-dragover'))
  for (const type of ['dragleave', 'drop']) zone.addEventListener(type, () => zone.classList.remove('is-dragover'))
  form.addEventListener('change', sync)
  sync()
  showFile()
})()
`
}
