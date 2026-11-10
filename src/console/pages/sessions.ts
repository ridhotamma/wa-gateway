import type { ConsoleAdmin } from '../../services/console-auth.js'
import { html, raw, type Html } from '../html.js'
import { listSessionRows } from '../data.js'
import { engineBadge, sessionPath, timeAgo, when } from '../helpers.js'
import type { Flash } from '../layout.js'
import { shell } from '../layout.js'
import type { ConsoleDependencies } from '../types.js'
import { badge, cardHead, emptyState, header, icon, stat } from '../ui.js'

export function renderSessions(deps: ConsoleDependencies, admin: ConsoleAdmin, flash: Flash): Html {
  const sessions = listSessionRows(deps)

  return shell(
    'Sessions',
    { section: 'sessions', admin: admin.email },
    html`
      ${header('Sessions', {
        description: 'Each session is one linked WhatsApp number, named by its tenant slug.',
      })}

      <div class="stack">
        <div class="card">
          ${cardHead('Pair a session')}
          <p class="hint">Starting a session shows a QR code to scan from WhatsApp.</p>
          <form method="post" action="/console/sessions" class="inline-form">
            <label
              >Session id<input
                name="sessionId"
                class="mono"
                placeholder="shop"
                pattern="[a-zA-Z0-9_-]{1,64}"
                required
                autocomplete="off"
            /></label>
            <button class="primary" type="submit">${icon('plus')}Start pairing</button>
          </form>
        </div>

        <div class="card flush">
          ${cardHead('All sessions', badge(String(sessions.length)))}
          ${
            sessions.length === 0
              ? emptyState(
                  'No sessions yet',
                  'Pair a number above to get started.',
                  undefined,
                  'users',
                )
              : html`<table class="stacked">
                  <thead>
                    <tr>
                      <th>Session</th>
                      <th>Status</th>
                      <th>Paired</th>
                      <th class="num">Queued</th>
                      <th>Last connected</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    ${sessions.map(
                      (session) =>
                        html`<tr>
                          <td>
                            <a class="mono cell-title" href="${sessionPath(session.sessionId)}"
                              >${session.sessionId}</a
                            >
                          </td>
                          <td data-label="Status">
                            ${engineBadge(session.status)}${session.active ? html` <span class="badge info dot">live</span>` : ''}
                          </td>
                          <td data-label="Paired">${session.paired ? 'Yes' : 'No'}</td>
                          <td class="num" data-label="Queued">${session.outbox.pending}</td>
                          <td class="nowrap subdued" data-label="Last connected">
                            ${timeAgo(session.lastConnectedAt)}
                          </td>
                          <td class="actions">
                            <div class="row-actions">
                              <a class="btn small" href="${sessionPath(session.sessionId)}">Open</a>
                              <form
                                method="post"
                                action="/console/sessions/${encodeURIComponent(session.sessionId)}/logout"
                                class="inline"
                                data-confirm="Log out ${session.sessionId}? The seller will need to scan a new QR code."
                                data-confirm-label="Log out"
                                data-confirm-tone="critical"
                              >
                                <button class="critical small">Log out</button>
                              </form>
                            </div>
                          </td>
                        </tr>`,
                    )}
                  </tbody>
                </table>`
          }
        </div>
      </div>
    `,
    flash,
  )
}

export function renderSession(
  deps: ConsoleDependencies,
  admin: ConsoleAdmin,
  sessionId: string,
  flash: Flash,
): Html {
  const live = deps.sessions.getSession(sessionId)
  const stored = deps.sessions.listStoredSessions().find((row) => row.sessionId === sessionId)
  const status = live?.status ?? 'disconnected'
  const reason = live?.lastStatusReason ?? stored?.reason ?? null
  const stats = deps.outbox.stats(sessionId)
  const qr = live?.qrDataUrl

  return shell(
    sessionId,
    { section: 'sessions', admin: admin.email },
    html`
      ${header(sessionId, {
        back: '/console/sessions',
        mono: true,
        meta: html`<span id="live-status-badge">${engineBadge(status)}</span>`,
        actions: html`<form
          method="post"
          action="/console/sessions/${encodeURIComponent(sessionId)}/start"
          class="inline"
        >
          <button class="primary" type="submit">
            ${icon('lightning')}${stored?.paired ? 'Reconnect' : 'Start pairing'}
          </button>
        </form>`,
      })}

      <div class="stats">
        ${stat('Queued', stats.pending, { id: 'live-pending' })}
        ${stat('Failed · 24h', stats.failedLastDay, { id: 'live-failed' })}
        ${stat('Last connected', when(stored?.lastConnectedAt), { small: true })}
        ${stat('Paired', stored?.paired ? 'Yes' : 'No', { small: true })}
      </div>

      <div class="grid">
        <div class="col">
          <div class="card" id="qr-card" ${qr ? '' : html`hidden`}>
            ${cardHead('Scan to link WhatsApp')}
            <ol class="steps">
              <li>Open WhatsApp on the seller's phone.</li>
              <li>Go to <b>Linked devices</b> → <b>Link a device</b>.</li>
              <li>Scan this code. It refreshes automatically.</li>
            </ol>
            <div class="qr">
              <img
                id="qr-image"
                ${qr ? html`src="${qr}"` : ''}
                alt="WhatsApp pairing QR code"
                width="260"
                height="260"
              />
            </div>
            <p class="subdued" style="margin:0;text-align:center;font-size:12.5px">
              Nothing after a few minutes? Start pairing again.
            </p>
          </div>

          <div class="card">
            ${cardHead('Connection')}
            <ul class="list">
              <li>
                <span>Status</span
                ><span id="live-status" style="text-transform:capitalize"
                  >${status.replaceAll('_', ' ')}</span
                >
              </li>
              <li><span>Reason</span><span id="live-reason">${reason ?? '—'}</span></li>
              <li><span>Updated</span><span>${when(stored?.updatedAt)}</span></li>
            </ul>
          </div>
        </div>

        <div class="col">
          <div class="card">
            ${cardHead('Rename session')}
            <p class="hint">Moves credentials and queued messages. No re-scan needed.</p>
            <form method="post" action="/console/sessions/${encodeURIComponent(sessionId)}/rename">
              <label
                >New session id<input
                  name="to"
                  class="mono"
                  value="${sessionId}"
                  pattern="[a-zA-Z0-9_-]{1,64}"
                  required
              /></label>
              <div class="foot"><button type="submit">Rename</button></div>
            </form>
          </div>

          <div class="card danger">
            ${cardHead('Danger zone')}
            <p class="hint">
              Logging out removes this session's credentials. The seller must scan a new QR code.
            </p>
            <form
              method="post"
              action="/console/sessions/${encodeURIComponent(sessionId)}/logout"
              data-confirm="Log out ${sessionId}? The seller will need to scan a new QR code."
              data-confirm-label="Log out"
              data-confirm-tone="critical"
            >
              <button class="critical">${icon('sign-out')}Log out session</button>
            </form>
          </div>
        </div>
      </div>

      <script>
        ${raw(sessionPollScript(sessionId))}
      </script>
    `,
    flash,
  )
}

function sessionPollScript(sessionId: string): string {
  return `
(() => {
  const id = ${JSON.stringify(sessionId)}
  const badgeEl = document.getElementById('live-status-badge')
  const statusEl = document.getElementById('live-status')
  const reasonEl = document.getElementById('live-reason')
  const pendingEl = document.getElementById('live-pending')
  const failedEl = document.getElementById('live-failed')
  const card = document.getElementById('qr-card')
  const image = document.getElementById('qr-image')
  let stopped = false

  const label = (status) => { const text = String(status).replaceAll('_', ' '); return text.charAt(0).toUpperCase() + text.slice(1) }
  const tone = (status) => status === 'ready' ? 'success' : status === 'failed' ? 'critical' : status === 'qr_ready' ? 'attention' : status ? 'info' : ''
  async function poll() {
    if (stopped) return
    try {
      const response = await fetch('/console/sessions/' + encodeURIComponent(id) + '/state', { headers: { accept: 'application/json' } })
      if (response.redirected || response.status === 401) { stopped = true; return }
      if (!response.ok) return
      const data = await response.json()
      const status = data.status || 'disconnected'
      if (statusEl) statusEl.textContent = String(status).replaceAll('_', ' ')
      if (reasonEl) reasonEl.textContent = data.reason || '—'
      if (pendingEl) pendingEl.textContent = String(data.outbox?.pending ?? 0)
      if (failedEl) failedEl.textContent = String(data.outbox?.failedLastDay ?? 0)
      if (badgeEl) badgeEl.innerHTML = '<span class="badge ' + tone(status) + '">' + label(status) + '</span>'
      if (card && image) {
        if (data.qrDataUrl) { image.src = data.qrDataUrl; card.hidden = false }
        else if (status !== 'qr_ready') { card.hidden = true }
      }
    } catch {}
  }
  void poll()
  const timer = setInterval(poll, 2000)
  window.addEventListener('pagehide', () => { stopped = true; clearInterval(timer) })
})()
`
}
