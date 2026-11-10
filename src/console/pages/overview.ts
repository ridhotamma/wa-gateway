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

  const failing = totals.failedLastDay > 0

  return shell(
    'Overview',
    { section: 'overview', admin: admin.email },
    html`
      ${header('Overview', {
        description: 'Sessions, delivery and recent console activity at a glance.',
        actions: html`<a class="btn primary" href="/console/notifications"
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
        ${stat('Sessions', sessions.length, {
          href: '/console/sessions',
          sub: sessions.length ? `${ready} ready` : 'none paired',
        })}
        ${stat('Queued', totals.pending, { sub: 'in the outbox' })}
        ${stat(
          'Failed · 24h',
          failing ? html`<span style="color:var(--critical)">${totals.failedLastDay}</span>` : 0,
          { sub: failing ? 'check status callbacks' : 'all delivered' },
        )}
        ${stat('API keys', keys.length, { href: '/console/api-keys', sub: 'active' })}
      </div>

      <div class="grid">
        <div class="col">
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
                    html`<a class="btn primary" href="/console/sessions"
                      >${icon('plus')}Pair a session</a
                    >`,
                    'users',
                  )
                : html`<table class="stacked">
                    <thead>
                      <tr>
                        <th>Session</th>
                        <th>Status</th>
                        <th class="num">Queued</th>
                        <th>Last connected</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${sessions.slice(0, 6).map(
                        (session) =>
                          html`<tr>
                            <td>
                              <a class="mono cell-title" href="${sessionPath(session.sessionId)}"
                                >${session.sessionId}</a
                              >
                            </td>
                            <td data-label="Status">${engineBadge(session.status)}</td>
                            <td class="num" data-label="Queued">${session.outbox.pending}</td>
                            <td class="nowrap subdued" data-label="Last connected">
                              ${timeAgo(session.lastConnectedAt)}
                            </td>
                          </tr>`,
                      )}
                    </tbody>
                  </table>`
            }
          </div>

          <div class="card">
            ${cardHead(
              'Delivery',
              html`<a class="btn small" href="/console/settings#outbox">Edit</a>`,
            )}
            <ul class="list">
              <li>
                <span>Message gap</span
                ><span
                  >${Math.round(settings.outbox.sendGapMs / 1000)}s + up to
                  ${Math.round(settings.outbox.sendJitterMs / 1000)}s jitter</span
                >
              </li>
              <li><span>Hourly cap</span><span>${settings.outbox.hourlyCap} per session</span></li>
              <li>
                <span>Typing simulation</span
                ><span
                  >${settings.typing ? `On · ${settings.typing.minMs / 1000}–${settings.typing.maxMs / 1000}s` : 'Off'}</span
                >
              </li>
              <li>
                <span>Inbound webhook</span
                ><span class="clip mono">${settings.inbound.urlTemplate ?? 'disabled'}</span>
              </li>
              <li>
                <span>Status callback</span
                ><span class="clip mono">${settings.inbound.statusUrlTemplate ?? 'disabled'}</span>
              </li>
            </ul>
          </div>
        </div>

        <div class="col">
          <div class="card">
            ${cardHead(
              'Recent activity',
              html`<a class="btn small" href="/console/activity">View all</a>`,
            )}
            ${
              activity.length === 0
                ? html`<p class="subdued" style="margin:0">Console actions will appear here.</p>`
                : html`<ul class="feed">
                    ${activity.map(
                      (entry) =>
                        html`<li>
                          <div class="feed-main">
                            <b>${entry.action}</b>
                            <span title="${entry.detail ?? entry.actor}"
                              >${entry.detail ?? entry.actor}</span
                            >
                          </div>
                          <time datetime="${entry.at}">${timeAgo(entry.at)}</time>
                        </li>`,
                    )}
                  </ul>`
            }
          </div>

          <div class="card">
            ${cardHead('System')}
            <ul class="list">
              <li>
                <span>Environment</span>
                <span class="mono">${deps.config.nodeEnv}</span>
              </li>
              <li>
                <span>Database</span
                ><span class="clip mono" title="${deps.config.databasePath}"
                  >${deps.config.databasePath}</span
                >
              </li>
              <li>
                <span>Media spool</span
                ><span>${media.files} files · ${formatBytes(media.bytes)}</span>
              </li>
              <li>
                <span>Bootstrap key</span
                ><span
                  >${
                    deps.config.apiKeySource === 'generated'
                      ? 'Generated'
                      : deps.config.apiKey
                        ? 'Configured'
                        : 'Not set'
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
