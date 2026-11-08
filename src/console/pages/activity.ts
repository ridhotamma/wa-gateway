import type { ConsoleAdmin } from '../../services/console-auth.js'
import { html, type Html } from '../html.js'
import { when } from '../helpers.js'
import type { Flash } from '../layout.js'
import { shell } from '../layout.js'
import type { ConsoleDependencies } from '../types.js'
import { cardHead, emptyState, header } from '../ui.js'

export function renderActivity(deps: ConsoleDependencies, admin: ConsoleAdmin, flash: Flash): Html {
  const entries = deps.audit.recent(100)

  return shell(
    'Activity',
    { section: 'activity', admin: admin.email },
    html`
      ${header('Activity')}
      <div class="card flush">
        ${cardHead('Console activity')}
        ${
          entries.length === 0
            ? emptyState(
                'Nothing here yet',
                'Key and settings changes, logins and message tests will show up here.',
              )
            : html`<div class="scroll">
                <table>
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
                          <td><b>${entry.actor}</b></td>
                          <td>${entry.action}</td>
                          <td class="subdued">${entry.detail ?? '—'}</td>
                        </tr>`,
                    )}
                  </tbody>
                </table>
              </div>`
        }
      </div>
    `,
    flash,
  )
}
