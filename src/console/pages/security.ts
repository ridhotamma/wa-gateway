import type { ConsoleAdmin } from '../../services/console-auth.js'
import type { ConsoleRequestSession } from '../auth.js'
import { html, type Html } from '../html.js'
import { timeAgo, when } from '../helpers.js'
import type { Flash } from '../layout.js'
import { shell } from '../layout.js'
import type { ConsoleDependencies } from '../types.js'
import { badge, emptyState, header, settingsSection } from '../ui.js'

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
      ${header('Security', {
        description: html`Signed in as <b>${admin.email}</b>. Console sessions expire automatically.`,
      })}
      ${settingsSection(
        'Password',
        'Changing the password signs out every other console session.',
        html`<form method="post" action="/console/security/password">
          <label
            >Current password<input
              type="password"
              name="current"
              required
              autocomplete="current-password"
          /></label>
          <div class="fields">
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
          </div>
          <div class="foot"><button class="primary" type="submit">Change password</button></div>
        </form>`,
      )}
      ${settingsSection(
        'Console sessions',
        'Browsers currently signed in to this console. Revoke any you do not recognise.',
        sessions.length === 0
          ? emptyState('No active sessions', 'Sign in again to create one.')
          : html`<table class="stacked">
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
                      <td style="max-width:280px">
                        <span class="cell-title clip" title="${session.userAgent ?? ''}"
                          >${describeAgent(session.userAgent)}</span
                        >
                        <span class="cell-sub">Started ${when(session.createdAt)}</span>
                      </td>
                      <td class="mono subdued" data-label="IP">${session.ip ?? '—'}</td>
                      <td class="nowrap subdued" data-label="Last seen">
                        ${timeAgo(session.lastSeenAt)}
                      </td>
                      <td class="actions">
                        ${
                          session.id === current.session.id
                            ? badge('This device', 'success dot')
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
            </table>`,
        { flush: true },
      )}
    `,
    flash,
  )
}

/** "Chrome on macOS" from a user agent, or the raw string when it is unfamiliar. */
function describeAgent(agent: string | null): string {
  if (!agent) return 'Unknown browser'
  const browser = /Edg\//.test(agent)
    ? 'Edge'
    : /OPR\//.test(agent)
      ? 'Opera'
      : /Firefox\//.test(agent)
        ? 'Firefox'
        : /Chrome\//.test(agent)
          ? 'Chrome'
          : /Safari\//.test(agent)
            ? 'Safari'
            : null
  const os = /iPhone|iPad/.test(agent)
    ? 'iOS'
    : /Android/.test(agent)
      ? 'Android'
      : /Mac OS X/.test(agent)
        ? 'macOS'
        : /Windows/.test(agent)
          ? 'Windows'
          : /Linux/.test(agent)
            ? 'Linux'
            : null
  if (browser && os) return `${browser} on ${os}`
  return browser ?? os ?? agent
}
