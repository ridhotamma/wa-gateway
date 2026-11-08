import type { ConsoleAdmin } from '../../services/console-auth.js'
import type { ConsoleRequestSession } from '../auth.js'
import { html, type Html } from '../html.js'
import { timeAgo, when } from '../helpers.js'
import type { Flash } from '../layout.js'
import { shell } from '../layout.js'
import type { ConsoleDependencies } from '../types.js'
import { badge, cardHead, emptyState, header } from '../ui.js'

export function renderSecurity(
  deps: ConsoleDependencies,
  admin: ConsoleAdmin,
  current: ConsoleRequestSession,
  flash: Flash,
): Html {
  const sessions = deps.auth.listSessions(admin.id)

  return shell(
    'Security',
    { section: 'security', admin: admin.email },
    html`
      ${header('Security')}
      <p class="page-note subdued">
        Signed in as <b>${admin.email}</b>. Console sessions are stored in SQLite and expire
        automatically.
      </p>

      <div class="layout">
        <div>
          <div class="card">
            ${cardHead('Change password')}
            <p class="hint">Changing the password signs out every other console session.</p>
            <form method="post" action="/console/security/password">
              <label
                >Current password<input
                  type="password"
                  name="current"
                  required
                  autocomplete="current-password"
              /></label>
              <label
                >New password<input
                  type="password"
                  name="next"
                  minlength="10"
                  required
                  autocomplete="new-password"
              /></label>
              <label
                >Confirm new password<input
                  type="password"
                  name="confirm"
                  minlength="10"
                  required
                  autocomplete="new-password"
              /></label>
              <div class="foot"><button class="primary" type="submit">Change password</button></div>
            </form>
          </div>
        </div>

        <div>
          <div class="card flush">
            ${cardHead('Console sessions', badge(String(sessions.length)))}
            ${
              sessions.length === 0
                ? emptyState('No active sessions', 'Sign in again to create one.')
                : html`<div class="scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Device</th>
                          <th>IP</th>
                          <th>Last seen</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        ${sessions.map(
                          (session) =>
                            html`<tr>
                              <td>
                                <b>${truncate(session.userAgent ?? 'Unknown browser', 52)}</b>
                                ${session.id === current.session.id ? badge('This device', 'success') : ''}
                                <div class="subdued">Started ${when(session.createdAt)}</div>
                              </td>
                              <td class="mono subdued">${session.ip ?? '—'}</td>
                              <td class="nowrap subdued">${timeAgo(session.lastSeenAt)}</td>
                              <td class="num">
                                ${
                                  session.id === current.session.id
                                    ? html`<span class="subdued">Current</span>`
                                    : html`<form
                                        method="post"
                                        action="/console/security/sessions/${session.id}/revoke"
                                        class="inline"
                                        data-confirm="Revoke this console session?"
                                        data-confirm-label="Revoke session"
                                        data-confirm-tone="critical"
                                      >
                                        <button class="critical small">Revoke</button>
                                      </form>`
                                }
                              </td>
                            </tr>`,
                        )}
                      </tbody>
                    </table>
                  </div>`
            }
          </div>
        </div>
      </div>
    `,
    flash,
  )
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}
