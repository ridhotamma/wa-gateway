import type { ConsoleAdmin } from '../../services/console-auth.js'
import { html, type Html } from '../html.js'
import type { Flash } from '../layout.js'
import { shell } from '../layout.js'
import type { ConsoleDependencies } from '../types.js'
import { header, settingsSection } from '../ui.js'

export interface SettingsFormValues {
  outboxSendGap: string
  outboxSendJitter: string
  outboxHourlyCap: string
  outboxMaxAgeHours: string
  outboxMaxAttempts: string
  typingEnabled: boolean
  typingMin: string
  typingMax: string
  typingMsPerChar: string
  typingJitter: string
  inboundUrl: string
  statusUrl: string
  inboundTimeout: string
  statusTimeout: string
  mediaMaxMb: string
  mediaSpoolMaxMb: string
  mediaTtlHours: string
  restoreOnBoot: boolean
  restoreDelay: string
  pairingTimeout: string
}

export function settingsValues(deps: ConsoleDependencies): SettingsFormValues {
  const settings = deps.settings.get()
  return {
    outboxSendGap: String(settings.outbox.sendGapMs / 1000),
    outboxSendJitter: String(settings.outbox.sendJitterMs / 1000),
    outboxHourlyCap: String(settings.outbox.hourlyCap),
    outboxMaxAgeHours: String(settings.outbox.maxAgeMs / 3_600_000),
    outboxMaxAttempts: String(settings.outbox.maxAttempts),
    typingEnabled: settings.typing !== null,
    typingMin: String((settings.typing?.minMs ?? 1_200) / 1000),
    typingMax: String((settings.typing?.maxMs ?? 8_000) / 1000),
    typingMsPerChar: String(settings.typing?.msPerChar ?? 35),
    typingJitter: String(settings.typing?.jitterRatio ?? 0.2),
    inboundUrl: settings.inbound.urlTemplate ?? '',
    statusUrl: settings.inbound.statusUrlTemplate ?? '',
    inboundTimeout: String(settings.inbound.timeoutMs / 1000),
    statusTimeout: String(settings.inbound.statusTimeoutMs / 1000),
    mediaMaxMb: String(settings.inbound.mediaMaxBytes / 1024 ** 2),
    mediaSpoolMaxMb: String(settings.inbound.mediaSpoolMaxBytes / 1024 ** 2),
    mediaTtlHours: String(settings.inbound.mediaTtlMs / 3_600_000),
    restoreOnBoot: settings.session.restoreOnBoot,
    restoreDelay: String(settings.session.restoreDelayMs / 1000),
    pairingTimeout: String(settings.session.pairingTimeoutMs / 60_000),
  }
}

export function renderSettings(
  deps: ConsoleDependencies,
  admin: ConsoleAdmin,
  flash: Flash,
  values: SettingsFormValues = settingsValues(deps),
): Html {
  return shell(
    'Settings',
    { section: 'settings', admin: admin.email },
    html`
      ${header('Settings')}
      <p class="page-note subdued">
        Changes apply immediately and are stored in SQLite. A few session-boot values need a
        restart; they are marked below.
      </p>

      <form method="post" action="/console/settings">
        <div id="outbox">
          ${settingsSection(
            'Outbox delivery',
            'Pacing keeps a seller number from looking like a spam bot. The hourly cap is shared by queued and direct sends.',
            html`<div class="fields">
              <label
                >Gap between sends (seconds)<input
                  name="outboxSendGap"
                  value="${values.outboxSendGap}"
                  inputmode="decimal"
                  required
              /></label>
              <label
                >Random jitter (seconds)<input
                  name="outboxSendJitter"
                  value="${values.outboxSendJitter}"
                  inputmode="decimal"
                  required
              /></label>
              <label
                >Hourly cap<input
                  name="outboxHourlyCap"
                  value="${values.outboxHourlyCap}"
                  inputmode="numeric"
                  required
              /></label>
              <label
                >Drop jobs older than (hours)<input
                  name="outboxMaxAgeHours"
                  value="${values.outboxMaxAgeHours}"
                  inputmode="decimal"
                  required
              /></label>
              <label
                >Max attempts<input
                  name="outboxMaxAttempts"
                  value="${values.outboxMaxAttempts}"
                  inputmode="numeric"
                  required
              /></label>
            </div>`,
          )}
          ${settingsSection(
            'Typing simulation',
            'Chatbot replies can show “typing…” for a human-looking pause before the message arrives.',
            html`<label class="check"
                ><input
                  type="checkbox"
                  name="typingEnabled"
                  ${values.typingEnabled ? html`checked` : ''}
                />
                Show a typing pause</label
              >
              <div class="fields">
                <label
                  >Minimum display (seconds)<input
                    name="typingMin"
                    value="${values.typingMin}"
                    inputmode="decimal"
                /></label>
                <label
                  >Maximum display (seconds)<input
                    name="typingMax"
                    value="${values.typingMax}"
                    inputmode="decimal"
                /></label>
                <label
                  >Milliseconds per character<input
                    name="typingMsPerChar"
                    value="${values.typingMsPerChar}"
                    inputmode="numeric"
                /></label>
                <label
                  >Jitter ratio (0–1)<input
                    name="typingJitter"
                    value="${values.typingJitter}"
                    inputmode="decimal"
                /></label>
              </div>`,
          )}
        </div>

        <div id="webhooks">
          ${settingsSection(
            'Webhooks',
            'Inbound customer messages are forwarded here. The status callback receives the final sent or failed outcome.',
            html`<label
                >Inbound URL<input
                  name="inboundUrl"
                  value="${values.inboundUrl}"
                  placeholder="https://hook.example.com/store/{sessionId}/whatsapp"
              /></label>
              <p class="hint">
                A full template with <span class="mono">{sessionId}</span>, or a base origin. Empty
                disables forwarding.
              </p>
              <label
                >Status callback URL<input
                  name="statusUrl"
                  value="${values.statusUrl}"
                  placeholder="https://hook.example.com/store/{sessionId}/whatsapp-status"
              /></label>
              <p class="hint">
                Empty disables send receipts. Defaults to the inbound URL's sibling when left blank
                at deploy time.
              </p>
              <div class="fields">
                <label
                  >Inbound timeout (seconds)<input
                    name="inboundTimeout"
                    value="${values.inboundTimeout}"
                    inputmode="decimal"
                    required
                /></label>
                <label
                  >Status timeout (seconds)<input
                    name="statusTimeout"
                    value="${values.statusTimeout}"
                    inputmode="decimal"
                    required
                /></label>
              </div>`,
          )}
        </div>

        <div id="media">
          ${settingsSection(
            'Media',
            'Customer attachments are downloaded only below the limit (applied when a session connects). Metadata is in SQLite; bytes stay in the media directory.',
            html`<div class="fields">
              <label
                >Max inbound download (MB)<input
                  name="mediaMaxMb"
                  value="${values.mediaMaxMb}"
                  inputmode="decimal"
                  required
              /></label>
              <label
                >Spool cap (MB)<input
                  name="mediaSpoolMaxMb"
                  value="${values.mediaSpoolMaxMb}"
                  inputmode="decimal"
                  required
              /></label>
              <label
                >Spool retention (hours)<input
                  name="mediaTtlHours"
                  value="${values.mediaTtlHours}"
                  inputmode="decimal"
                  required
              /></label>
            </div>`,
          )}
        </div>

        <div id="sessions">
          ${settingsSection(
            'Session lifecycle',
            'Restore reconnects paired sessions after a restart; those two values apply on the next start. Pairing timeout applies to new attempts.',
            html`<label class="check"
                ><input
                  type="checkbox"
                  name="restoreOnBoot"
                  ${values.restoreOnBoot ? html`checked` : ''}
                />
                Restore paired sessions on boot</label
              >
              <div class="fields">
                <label
                  >Restore stagger (seconds)<input
                    name="restoreDelay"
                    value="${values.restoreDelay}"
                    inputmode="decimal"
                /></label>
                <label
                  >Pairing timeout (minutes)<input
                    name="pairingTimeout"
                    value="${values.pairingTimeout}"
                    inputmode="decimal"
                    required
                /></label>
              </div>`,
          )}
        </div>

        <div class="page-foot"><button class="primary" type="submit">Save settings</button></div>
      </form>

      <div id="deployment" style="margin-top:24px">
        ${settingsSection(
          'Deployment',
          'These values come from the process environment and are not editable from the console.',
          html`<ul class="list">
              <li>
                <span class="subdued">Environment</span>
                <span class="mono">${deps.config.nodeEnv}</span>
              </li>
              <li>
                <span class="subdued">Listen address</span>
                <span class="mono">${deps.config.host}:${deps.config.port}</span>
              </li>
              <li>
                <span class="subdued">Database</span>
                <span class="mono clip">${deps.config.databasePath}</span>
              </li>
              <li>
                <span class="subdued">Media directory</span>
                <span class="mono clip">${deps.config.mediaDir}</span>
              </li>
              <li>
                <span class="subdued">Console admin</span>
                <span class="mono">${admin.email}</span>
              </li>
              <li>
                <span class="subdued">Bootstrap API key</span>
                <span>${deps.config.apiKey ? 'configured' : 'not set'}</span>
              </li>
            </ul>
            <form
              method="post"
              action="/console/settings/reset"
              data-confirm="Reset every runtime setting to the environment defaults? SQLite-stored overrides will be replaced."
              data-confirm-label="Reset settings"
              data-confirm-tone="critical"
            >
              <button class="critical">Reset runtime settings</button>
            </form>`,
        )}
      </div>
    `,
    flash,
  )
}
