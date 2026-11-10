import type { ConsoleAdmin } from '../../services/console-auth.js'
import { html, type Html } from '../html.js'
import { timeAgo, when } from '../helpers.js'
import type { Flash } from '../layout.js'
import { shell } from '../layout.js'
import type { ConsoleDependencies } from '../types.js'
import { dialog } from '../dialog.js'
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
      ${header('API keys', {
        description:
          'Keys authenticate API clients. Use one per caller so each can be revoked alone.',
      })}
      ${
        createdKey
          ? dialog({
              id: 'new-key-dialog',
              title: 'Copy this key now',
              open: true,
              wide: true,
              body: html`<p class="dialog-message">
                  This is the only time the full key for <b>${createdKey.name}</b> is shown. Store
                  it in the service that sends notifications.
                </p>
                <div class="copy-row" style="margin-top:16px">
                  <input
                    id="new-api-key"
                    class="mono"
                    value="${createdKey.key}"
                    aria-label="New API key"
                    readonly
                  />
                  <button type="button" data-copy-target="#new-api-key">
                    ${icon('copy')}<span data-copy-label>Copy</span>
                  </button>
                </div>`,
              actions: html`<button type="button" class="primary" data-dialog-close>Done</button>`,
            })
          : ''
      }

      <div class="grid">
        <div class="col">
          <div class="card flush">
            ${cardHead('Active keys', badge(String(active.length), active.length ? 'success' : ''))}
            ${
              active.length === 0
                ? emptyState(
                    'No console-created keys',
                    deps.config.apiKey
                      ? 'The bootstrap key still works, but create a named key for each caller.'
                      : 'Create a named key for each caller.',
                    undefined,
                    'key',
                  )
                : html`<table class="stacked">
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
                            <td><span class="cell-title">${key.name}</span></td>
                            <td class="mono" data-label="Prefix">${key.prefix}…</td>
                            <td class="nowrap subdued" data-label="Created">
                              ${when(key.createdAt)}
                            </td>
                            <td class="nowrap subdued" data-label="Last used">
                              ${timeAgo(key.lastUsedAt)}
                            </td>
                            <td class="actions">
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
                  </table>`
            }
          </div>

          ${
            revoked.length > 0
              ? html`<div class="card flush">
                  ${cardHead('Revoked', badge(String(revoked.length)))}
                  <div>
                    <table class="stacked table-muted">
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
                              <td>${key.name}</td>
                              <td class="mono" data-label="Prefix">${key.prefix}…</td>
                              <td class="nowrap" data-label="Revoked">${when(key.revokedAt)}</td>
                            </tr>`,
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>`
              : ''
          }
        </div>

        <div class="col">
          <div class="card">
            ${cardHead('Create a key')}
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
            ${
              deps.config.apiKeySource === 'generated'
                ? html`${cardHead('Bootstrap API key')}
                    <p class="hint">
                      Generated on first boot and stored at
                      <span class="mono clip">${deps.config.apiKeyFile}</span>. Copy it into your
                      integration, or create a named key below.
                    </p>
                    <div class="copy-row">
                      <input
                        id="bootstrap-api-key"
                        class="mono"
                        value="${deps.config.apiKey}"
                        readonly
                      />
                      <button type="button" class="btn" data-copy-target="#bootstrap-api-key">
                        ${icon('copy')}Copy
                      </button>
                    </div>
                    <p class="help">
                      Permanent; cannot be revoked from the console. It also signs outbound
                      webhooks.
                    </p>`
                : html`${cardHead('Environment key')}
                    <p class="hint">
                      Set with <span class="mono">WHATSAPP_API_KEY</span> at deploy time. It is
                      permanent and cannot be revoked from the console.
                    </p>
                    ${
                      deps.config.apiKey
                        ? badge('Configured', 'success dot')
                        : badge('Not configured', 'attention dot')
                    }`
            }
          </div>
          <div class="card">
            ${cardHead('API reference')}
            <p class="hint">
              Browse every endpoint, its request schema and examples. Open the reference, then paste
              a key into <b>Authorize</b> to try requests from the browser.
            </p>
            <a class="btn" style="width:100%" href="/docs" target="_blank" rel="noreferrer"
              >${icon('tree-structure')}Open API reference</a
            >
          </div>
        </div>
      </div>
    `,
    flash,
  )
}
