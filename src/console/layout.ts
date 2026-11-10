/**
 * Console chrome: a quiet sidebar, a centred page column, white cards, a page
 * header with at most one primary action, and tables that stack on phones.
 * Server-rendered; the only JavaScript is a few tiny helpers.
 */
import { DIALOG_SCRIPT, confirmDialog } from './dialog.js'
import { html, raw, type Html } from './html.js'
import { CONSOLE_CSS } from './styles.js'
import { alert, avatar, brandMark, icon, type IconName } from './ui.js'

export interface ConsoleNav {
  section: string
  admin: string
}

export type Flash = { tone: 'success' | 'critical' | 'warning' | 'info'; text: string } | null

type NavItem = [key: string, label: string, href: string, icon: IconName]

const NAV_GROUPS: Array<[string, NavItem[]]> = [
  [
    'Gateway',
    [
      ['overview', 'Overview', '/console', 'house'],
      ['sessions', 'Sessions', '/console/sessions', 'users'],
      ['notifications', 'Notifications', '/console/notifications', 'lightning'],
    ],
  ],
  [
    'Admin',
    [
      ['api-keys', 'API keys', '/console/api-keys', 'key'],
      ['settings', 'Settings', '/console/settings', 'gear-six'],
      ['activity', 'Activity', '/console/activity', 'chart-bar'],
      ['security', 'Security', '/console/security', 'warning-circle'],
    ],
  ],
]

function flashParts(flash?: Flash) {
  return {
    banner: flash && flash.tone !== 'success' ? alert(flash.tone, html`${flash.text}`) : '',
    toast:
      flash?.tone === 'success'
        ? html`<div class="toast" role="status">
            ${icon('check-circle')}<span>${flash.text}</span>
          </div>`
        : '',
  }
}

const CLEAR_FLASH = html`<script>
  {
    const url = new URL(location.href)
    url.searchParams.delete('ok')
    url.searchParams.delete('err')
    history.replaceState(history.state, '', url.pathname + url.search + url.hash)
  }
</script>`

export function shell(title: string, nav: ConsoleNav, body: Html, flash?: Flash): Html {
  const link = ([key, label, href, name]: NavItem) =>
    html`<a
      href="${href}"
      class="nav-link ${nav.section === key ? 'on' : ''}"
      ${nav.section === key ? html`aria-current="page"` : ''}
      data-tooltip="${label}"
      >${icon(name, 18)}<span>${label}</span></a
    >`
  const { banner, toast } = flashParts(flash)

  return html`<!doctype html>
    <html lang="en">
      <head>
        ${head(title)}
        <script>
          try {
            if (localStorage.getItem('wa-gateway-nav') === 'collapsed')
              document.documentElement.classList.add('nav-collapsed')
          } catch (e) {}
        </script>
      </head>
      <body>
        <input type="checkbox" id="nav-toggle" aria-hidden="true" tabindex="-1" />
        <label for="nav-toggle" class="scrim" aria-hidden="true"></label>
        <header class="topbar">
          <label for="nav-toggle" class="topbar-menu" aria-label="Open menu"
            >${icon('list', 20)}</label
          >
          <a class="topbar-brand" href="/console"
            >${brandMark('sm')}<span>WhatsApp Gateway</span></a
          >
        </header>
        <div class="frame">
          <nav class="nav" aria-label="Console">
            <div class="nav-head">
              <a class="nav-brand" href="/console">
                ${brandMark()}
                <span class="nav-brand-text"
                  ><b>WhatsApp Gateway</b><span>Admin console</span></span
                >
              </a>
              <button
                type="button"
                class="nav-toggle"
                data-nav-toggle
                data-tooltip="Expand sidebar"
                aria-label="Toggle sidebar"
              >
                <span class="nav-collapse-icon">${icon('caret-double-left')}</span
                ><span class="nav-expand-icon">${icon('caret-double-right')}</span>
              </button>
            </div>
            ${NAV_GROUPS.map(
              ([group, items]) =>
                html`<div class="nav-group">${group}</div>
                  ${items.map(link)}`,
            )}
            <div class="nav-foot">
              ${avatar(nav.admin)}<span class="nav-admin" title="${nav.admin}">${nav.admin}</span>
              <form
                method="post"
                action="/console/logout"
                class="inline"
                data-confirm="Sign out of the console?"
                data-confirm-label="Sign out"
              >
                <button class="icon-btn" data-tooltip="Sign out" aria-label="Sign out">
                  ${icon('sign-out', 18)}
                </button>
              </form>
            </div>
          </nav>
          <main>
            <div class="page">${banner} ${body}</div>
            ${toast} ${flash ? CLEAR_FLASH : ''}
          </main>
        </div>
        <div id="nav-tooltip" class="nav-tooltip" role="tooltip" hidden></div>
        ${confirmDialog()}
        <script>
          ${raw(DIALOG_SCRIPT)}
        </script>
        <script>
          ${raw(CONSOLE_SCRIPT)}
        </script>
      </body>
    </html>`
}

function head(title: string): Html {
  return html`<meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="theme-color" content="#f7f7f8" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <title>${title} · WhatsApp Gateway</title>
    <style>
      ${raw(CONSOLE_CSS)}
    </style>`
}

/** Auth pages: one card on the canvas, no sidebar. */
export function bare(title: string, body: Html): Html {
  return html`<!doctype html>
    <html lang="en">
      <head>
        ${head(title)}
      </head>
      <body>
        <main class="auth">
          <div class="auth-brand">${brandMark()}<span>WhatsApp Gateway</span></div>
          ${body}
        </main>
        <script>
          ${raw(DIALOG_SCRIPT)}
        </script>
        <script>
          ${raw(CONSOLE_SCRIPT)}
        </script>
      </body>
    </html>`
}

const CONSOLE_SCRIPT = `
(() => {
  if (window.__waGatewayConsole) return
  window.__waGatewayConsole = true

  // Escape closes the phone menu.
  document.addEventListener('keydown', (event) => {
    const toggle = document.getElementById('nav-toggle')
    if (event.key === 'Escape' && toggle instanceof HTMLInputElement) toggle.checked = false
  })

  // Submit once: a second click cannot queue a second POST. The native
  // constraint validation has already run by the time this event fires.
  document.addEventListener('submit', (event) => {
    if (event.defaultPrevented) return
    const form = event.target instanceof HTMLFormElement ? event.target : null
    if (!form || form.dataset.busy === 'off') return
    const submitter = event.submitter ?? form.querySelector('button[type="submit"], button:not([type])')
    if (!(submitter instanceof HTMLButtonElement)) return
    if (submitter.dataset.busy === 'off') return
    setTimeout(() => {
      submitter.setAttribute('aria-busy', 'true')
      submitter.disabled = true
    }, 0)
  })
})()
`
