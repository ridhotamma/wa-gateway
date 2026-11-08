import { html, type Html } from '../html.js'
import { bare } from '../layout.js'
import { alert } from '../ui.js'

export function renderLogin(email = '', error?: string, notice?: string): Html {
  return bare(
    'Sign in',
    html`
      <div class="card">
        <h2>Sign in</h2>
        <p class="hint">Use the console admin account configured for this gateway.</p>
        ${error ? alert('critical', html`${error}`) : ''}
        ${notice ? alert('success', html`${notice}`) : ''}
        <form method="post" action="/console/login">
          <label
            >Email<input
              type="email"
              name="email"
              value="${email}"
              required
              autocomplete="username"
              autofocus
          /></label>
          <label
            >Password<input
              type="password"
              name="password"
              required
              autocomplete="current-password"
          /></label>
          <div class="foot"><button class="primary" type="submit">Sign in</button></div>
        </form>
      </div>
      <p class="subdued" style="text-align:center;margin-top:12px">wa-gateway console</p>
    `,
  )
}

export function renderSetup(error?: string, email = ''): Html {
  return bare(
    'Create the first admin',
    html`
      <div class="card">
        <h2>Create the first admin</h2>
        <p class="hint">
          No console admin exists yet. Create one now; after this page, setup is closed.
        </p>
        ${error ? alert('critical', html`${error}`) : ''}
        <form method="post" action="/console/setup">
          <label
            >Email<input
              type="email"
              name="email"
              value="${email}"
              required
              autocomplete="username"
          /></label>
          <label
            >Password<input
              type="password"
              name="password"
              minlength="10"
              required
              autocomplete="new-password"
          /></label>
          <label
            >Confirm password<input
              type="password"
              name="confirm"
              minlength="10"
              required
              autocomplete="new-password"
          /></label>
          <div class="foot"><button class="primary" type="submit">Create admin</button></div>
        </form>
      </div>
      <p class="subdued" style="text-align:center;margin-top:12px">
        In production, set WHATSAPP_CONSOLE_EMAIL and WHATSAPP_CONSOLE_PASSWORD to seed this account
        automatically.
      </p>
    `,
  )
}

export function renderNotFound(title: string, message: string): Html {
  return bare(
    title,
    html`<div class="card">
      <h2>${title}</h2>
      <p class="hint">${message}</p>
      <div class="foot"><a class="btn" href="/console">Back to console</a></div>
    </div>`,
  )
}
