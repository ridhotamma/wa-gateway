import type { ConsoleAdmin } from '../../services/console-auth.js'
import { listSessionRows } from '../data.js'
import { engineBadge, formatBytes, sessionPath, timeAgo } from '../helpers.js'
import type { Html } from '../html.js'
import type { Flash } from '../layout.js'
import { shell } from '../layout.js'
import type { ConsoleDependencies } from '../types.js'
import { alert, cardHead, emptyState, header, icon, stat } from '../ui.js'
import { html } from '../html.js'

export function renderOverview(deps: ConsoleDependencies, admin: ConsoleAdmin, flash: Flash): Html {
  const sessions = listSessionRows(deps)
  const ready = sessions.filter((session) => session.status === 'ready').length
  const totals = deps.outbox.totals()
  const keys = deps.apiKeys.list().filter((key) => !key.revokedAt)
  const media = deps.mediaStore.stats()
  const settings = deps.settings.get()
  const activity = deps.audit.recent(8)

  return shell(
    'Overview',
    { section: 'overview', admin: admin.email },
    html`
      ${header('Overview', {
        actions: html`<a class="btn" href="/console/sessions">${icon('users')}Sessions</a
          ><a class="btn primary" href="/console/notifications"
            >${icon('lightning')}Send a message</a
          >`,
      })}
      ${
        deps.config.apiKeySource === 'generated' && keys.length === 0
          ? alert(
              'info',
              html`Your bootstrap API key is ready.
                <a href="/console/api-keys">Copy it from API keys</a> before connecting a client.`,
            )
          : ''
      }
      <div class="stats">
        ${stat('Sessions', sessions.length, '/console/sessions')}
        ${stat('Ready', ready, '/console/sessions')}
        ${stat('Queued messages', totals.pending, '/console/settings#outbox')}
        ${stat('Failed · 24h', totals.failedLastDay)}
        ${stat('Active API keys', keys.length, '/console/api-keys')}
        ${stat('Media spool', formatBytes(media.bytes))}
      </div>

      <div class="layout" style="margin-top:16px">
        <div>
          <div class="card flush">
            ${cardHead(
              'Sessions',
              html`<a class="btn small" href="/console/sessions">View all</a>`,
            )}
            ${
              sessions.length === 0
                ? emptyState(
                    'No sessions yet',
                    'Pair a WhatsApp number to start sending notifications.',
                    html`<a class="btn primary" href="/console/sessions">Pair a session</a>`,
                  )
                : html`<div class="scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Session</th>
                          <th>Status</th>
                          <th>Queued</th>
                          <th>Last connected</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        ${sessions.slice(0, 6).map(
                          (session) =>
                            html`<tr>
                              <td>
                                <a class="mono" href="${sessionPath(session.sessionId)}"
                                  >${session.sessionId}</a
                                >
                              </td>
                              <td>${engineBadge(session.status)}</td>
                              <td class="num">${session.outbox.pending}</td>
                              <td class="nowrap subdued">${timeAgo(session.lastConnectedAt)}</td>
                              <td class="num">
                                <a class="btn small" href="${sessionPath(session.sessionId)}"
                                  >Open</a
                                >
                              </td>
                            </tr>`,
                        )}
                      </tbody>
                    </table>
                  </div>`
            }
          </div>

          <div class="card">
            ${cardHead(
              'Delivery',
              html`<a class="btn small" href="/console/settings#outbox">Settings</a>`,
            )}
            <ul class="list">
              <li>
                <span class="subdued">Message gap</span
                ><span
                  >${Math.round(settings.outbox.sendGapMs / 1000)}s + up to
                  ${Math.round(settings.outbox.sendJitterMs / 1000)}s jitter</span
                >
              </li>
              <li>
                <span class="subdued">Hourly cap</span
                ><span>${settings.outbox.hourlyCap} messages per session</span>
              </li>
              <li>
                <span class="subdued">Typing simulation</span
                ><span
                  >${settings.typing ? `on · ${settings.typing.minMs / 1000}–${settings.typing.maxMs / 1000}s` : 'off'}</span
                >
              </li>
              <li>
                <span class="subdued">Inbound webhook</span
                ><span class="clip mono">${settings.inbound.urlTemplate ?? 'disabled'}</span>
              </li>
              <li>
                <span class="subdued">Status callback</span
                ><span class="clip mono">${settings.inbound.statusUrlTemplate ?? 'disabled'}</span>
              </li>
            </ul>
          </div>
        </div>

        <div>
          <div class="card">
            ${cardHead(
              'Recent activity',
              html`<a class="btn small" href="/console/activity">View all</a>`,
            )}
            ${
              activity.length === 0
                ? html`<p class="subdued">Console actions will appear here.</p>`
                : html`<ul class="list">
                    ${activity.map(
                      (entry) =>
                        html`<li>
                          <span
                            ><b>${entry.action}</b
                            >${entry.detail ? html`<br /><span class="subdued">${entry.detail}</span>` : ''}</span
                          >
                          <span class="subdued" style="text-align:right"
                            >${entry.actor}<br />${timeAgo(entry.at)}</span
                          >
                        </li>`,
                    )}
                  </ul>`
            }
          </div>

          <div class="card">
            ${cardHead('System')}
            <ul class="list">
              <li>
                <span class="subdued">Environment</span>
                <span class="mono">${deps.config.nodeEnv}</span>
              </li>
              <li>
                <span class="subdued">Database</span
                ><span class="clip mono">${deps.config.databasePath}</span>
              </li>
              <li>
                <span class="subdued">Media files</span
                ><span>${media.files} · ${formatBytes(media.bytes)}</span>
              </li>
              <li>
                <span class="subdued">Bootstrap API key</span
                ><span
                  >${
                    deps.config.apiKeySource === 'generated'
                      ? 'generated'
                      : deps.config.apiKey
                        ? 'configured'
                        : 'not set'
                  }</span
                >
              </li>
            </ul>
          </div>
        </div>
      </div>
    `,
    flash,
  )
}
