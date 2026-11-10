import type { ConsoleAdmin } from '../../services/console-auth.js'
import { html, type Html } from '../html.js'
import { when } from '../helpers.js'
import type { Flash } from '../layout.js'
import { shell } from '../layout.js'
import type { ConsoleDependencies } from '../types.js'
import { emptyState, header } from '../ui.js'

export function renderActivity(deps: ConsoleDependencies, admin: ConsoleAdmin, flash: Flash): Html {
  const entries = deps.audit.recent(100)

  return shell(
    'Activity',
    { section: 'activity', admin: admin.email },
    html`
      ${header('Activity', {
        description: 'The last 100 logins, key and settings changes, and message tests.',
      })}
      <div class="card flush">
        ${
          entries.length === 0
            ? emptyState(
                'Nothing here yet',
                'Key and settings changes, logins and message tests will show up here.',
                undefined,
                'chart-bar',
              )
            : html`<table class="stacked">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Actor</th>
                    <th>Action</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  ${entries.map(
                    (entry) =>
                      html`<tr>
                        <td class="nowrap subdued">${when(entry.at)}</td>
                        <td data-label="Actor"><span class="cell-title">${entry.actor}</span></td>
                        <td data-label="Action"><span class="mono">${entry.action}</span></td>
                        <td class="subdued" data-label="Detail" style="overflow-wrap:anywhere">
                          ${entry.detail ?? '—'}
                        </td>
                      </tr>`,
                  )}
                </tbody>
              </table>`
        }
      </div>
    `,
    flash,
  )
}
