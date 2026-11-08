import type { ConsoleAdmin } from '../../services/console-auth.js'
import { html, type Html } from '../html.js'
import { timeAgo, when } from '../helpers.js'
import type { Flash } from '../layout.js'
import { shell } from '../layout.js'
import type { ConsoleDependencies } from '../types.js'
import { badge, cardHead, emptyState, header, icon } from '../ui.js'

export function renderApiKeys(
  deps: ConsoleDependencies,
  admin: ConsoleAdmin,
  flash: Flash,
  createdKey?: { key: string; name: string },
): Html {
  const keys = deps.apiKeys.list()
  const active = keys.filter((key) => !key.revokedAt)
  const revoked = keys.filter((key) => key.revokedAt)

  return shell(
    'API keys',
    { section: 'api-keys', admin: admin.email },
    html`
      ${header('API keys')}
      ${
        createdKey
          ? html`<div class="card" style="border:1px solid var(--success)">
              ${cardHead('Copy this key now')}
              <p class="hint">
                This is the only time the full key is shown. Store it in the service that sends
                notifications.
              </p>
              <div class="copy-row">
                <input id="new-api-key" class="mono" value="${createdKey.key}" readonly />
                <button type="button" class="btn" data-copy-target="#new-api-key">
                  ${icon('copy')}Copy
                </button>
              </div>
              <p class="subdued" style="margin:8px 0 0">Key <b>${createdKey.name}</b> is active.</p>
            </div>`
          : ''
      }

      <div class="layout">
        <div>
          <div class="card flush">
            ${cardHead('Active keys', badge(String(active.length), active.length ? 'success' : ''))}
            ${
              active.length === 0
                ? emptyState(
                    'No console-created keys',
                    'The environment key still works, but create a named key for each caller.',
                  )
                : html`<div class="scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th>Prefix</th>
                          <th>Created</th>
                          <th>Last used</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        ${active.map(
                          (key) =>
                            html`<tr>
                              <td><b>${key.name}</b></td>
                              <td class="mono">${key.prefix}…</td>
                              <td class="nowrap subdued">${when(key.createdAt)}</td>
                              <td class="nowrap subdued">${timeAgo(key.lastUsedAt)}</td>
                              <td class="num">
                                <form
                                  method="post"
                                  action="/console/api-keys/${key.id}/revoke"
                                  class="inline"
                                  data-confirm="Revoke ${key.name}? Any service using it will get 401 immediately."
                                  data-confirm-label="Revoke key"
                                  data-confirm-tone="critical"
                                >
                                  <button class="critical small">Revoke</button>
                                </form>
                              </td>
                            </tr>`,
                        )}
                      </tbody>
                    </table>
                  </div>`
            }
          </div>

          ${
            revoked.length > 0
              ? html`<div class="card flush">
                  ${cardHead('Revoked')}
                  <div class="scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th>Prefix</th>
                          <th>Revoked</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${revoked.map(
                          (key) =>
                            html`<tr>
                              <td class="subdued">${key.name}</td>
                              <td class="mono subdued">${key.prefix}…</td>
                              <td class="nowrap subdued">${when(key.revokedAt)}</td>
                            </tr>`,
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>`
              : ''
          }
        </div>

        <div>
          <div class="card">
            ${cardHead('Create a key')}
            <p class="hint">
              Use one key per caller so a compromised integration can be revoked without touching
              the others.
            </p>
            <form method="post" action="/console/api-keys">
              <label
                >Key name<input
                  name="name"
                  placeholder="checkout service"
                  maxlength="80"
                  required
                  autocomplete="off"
              /></label>
              <div class="foot">
                <button class="primary" type="submit">${icon('plus')}Create key</button>
              </div>
            </form>
          </div>

          <div class="card">
            ${cardHead('Environment key')}
            <p class="hint">
              Set with <span class="mono">WHATSAPP_API_KEY</span> at deploy time. It is permanent
              and cannot be revoked from the console.
            </p>
            <p>
              ${deps.config.apiKey ? badge('Configured', 'success') : badge('Not configured', 'attention')}
            </p>
          </div>
        </div>
      </div>
    `,
    flash,
  )
}
