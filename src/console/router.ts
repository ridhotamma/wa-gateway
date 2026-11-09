import { Hono } from 'hono'

import { maskPhone } from '../lib/phone.js'
import type { AppEnv } from '../http/types.js'
import { MAX_QUEUED_MEDIA_BASE64, sessionIdSchema } from '../http/schemas.js'
import type { OutboxMedia } from '../services/outbox.js'
import { settingsFromConfig, type RuntimeSettings } from '../services/settings-store.js'
import {
  clearLoginAttempts,
  clearSessionCookie,
  clientIp,
  consoleCsrf,
  consoleMiddleware,
  htmlPage,
  loginRateLimited,
  readConsoleSession,
  requireConsoleSession,
  setSessionCookie,
} from './auth.js'
import {
  flashFrom,
  formBool,
  formInteger,
  formNumber,
  formString,
  redirectFlash,
} from './helpers.js'
import { renderActivity } from './pages/activity.js'
import { renderApiKeys } from './pages/api-keys.js'
import { renderLogin, renderNotFound, renderSetup } from './pages/auth-pages.js'
import {
  noticeDefaults,
  renderNotifications,
  type NoticeFormValues,
} from './pages/notifications.js'
import { renderOverview } from './pages/overview.js'
import { renderSecurity } from './pages/security.js'
import { renderSession, renderSessions } from './pages/sessions.js'
import { renderSettings, type SettingsFormValues } from './pages/settings.js'
import type { ConsoleDependencies } from './types.js'

export function createConsoleApp(deps: ConsoleDependencies): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.use('*', async (c, next) => {
    if (!deps.config.console.enabled) return c.notFound()
    return next()
  })
  app.use('*', consoleCsrf(deps.config.console))
  app.use('*', async (c, next) => {
    try {
      await next()
    } catch (error) {
      deps.logger.error({ err: error }, 'console request failed')
      return htmlPage(
        String(
          renderNotFound(
            'Something went wrong',
            error instanceof Error ? error.message : 'The console could not finish that request.',
          ),
        ),
        500,
      )
    }
  })

  // -------------------------------------------------------------------------
  // Auth pages (public)
  // -------------------------------------------------------------------------

  app.get('/login', (c) => {
    if (deps.auth.countAdmins() === 0) return c.redirect('/console/setup', 303)
    if (readConsoleSession(c, deps)) return c.redirect('/console', 303)
    return htmlPage(String(renderLogin('', undefined, c.req.query('ok'))))
  })

  app.post('/login', async (c) => {
    if (deps.auth.countAdmins() === 0) return c.redirect('/console/setup', 303)
    const body = await c.req.parseBody()
    const email = formString(body, 'email').trim()
    const password = formString(body, 'password')
    const key = `${clientIp(c)}:${email.toLowerCase()}`

    if (loginRateLimited(key)) {
      return htmlPage(
        String(renderLogin(email, 'Too many attempts. Try again in a few minutes.')),
        429,
      )
    }

    const result = deps.auth.authenticate(email, password, {
      userAgent: c.req.header('user-agent'),
      ip: clientIp(c),
    })
    if (!result) {
      return htmlPage(String(renderLogin(email, 'Email or password is incorrect.')), 401)
    }

    clearLoginAttempts(key)
    deps.audit.record(result.admin.email, 'console.login', result.admin.email)
    setSessionCookie(c, result.token, deps.config)
    return c.redirect('/console', 303)
  })

  app.get('/setup', (c) => {
    if (deps.auth.countAdmins() > 0) return c.redirect('/console/login', 303)
    return htmlPage(String(renderSetup()))
  })

  app.post('/setup', async (c) => {
    if (deps.auth.countAdmins() > 0) return c.redirect('/console/login', 303)
    const body = await c.req.parseBody()
    const email = formString(body, 'email').trim()
    const password = formString(body, 'password')
    const confirm = formString(body, 'confirm')

    if (password !== confirm) {
      return htmlPage(String(renderSetup('The passwords do not match.', email)), 400)
    }

    try {
      const admin = deps.auth.createAdmin(email, password)
      const result = deps.auth.authenticate(email, password, {
        userAgent: c.req.header('user-agent'),
        ip: clientIp(c),
      })
      if (!result) throw new Error('The account was created but sign-in failed.')
      deps.audit.record(admin.email, 'console.setup', admin.email)
      setSessionCookie(c, result.token, deps.config)
      return redirectFlash(
        c,
        deps.config.apiKeySource === 'generated' ? '/console/api-keys' : '/console',
        'success',
        deps.config.apiKeySource === 'generated'
          ? 'Admin created. Copy the bootstrap API key below for your integration.'
          : 'Admin created.',
      )
    } catch (error) {
      return htmlPage(
        String(
          renderSetup(
            error instanceof Error ? error.message : 'Could not create the admin.',
            email,
          ),
        ),
        400,
      )
    }
  })

  // -------------------------------------------------------------------------
  // Everything below requires a console session
  // -------------------------------------------------------------------------

  app.use('*', consoleMiddleware(deps))

  app.get('/', (c) => {
    const { admin } = requireConsoleSession(c, deps)
    return htmlPage(String(renderOverview(deps, admin, flashFrom(c))))
  })

  app.post('/logout', (c) => {
    const session = requireConsoleSession(c, deps)
    deps.auth.destroy(session.token)
    deps.audit.record(session.admin.email, 'console.logout', null)
    clearSessionCookie(c, deps.config)
    return c.redirect('/console/login', 303)
  })

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  app.get('/sessions', (c) => {
    const { admin } = requireConsoleSession(c, deps)
    return htmlPage(String(renderSessions(deps, admin, flashFrom(c))))
  })

  app.post('/sessions', async (c) => {
    const { admin } = requireConsoleSession(c, deps)
    const body = await c.req.parseBody()
    const parsed = sessionIdSchema.safeParse(formString(body, 'sessionId').trim())
    if (!parsed.success) {
      return redirectFlash(c, '/console/sessions', 'critical', 'Invalid session id.')
    }

    try {
      await deps.sessions.startSession(parsed.data)
      deps.audit.record(admin.email, 'session.start', parsed.data)
      return c.redirect(`/console/sessions/${encodeURIComponent(parsed.data)}`, 303)
    } catch (error) {
      return redirectFlash(
        c,
        '/console/sessions',
        'critical',
        error instanceof Error ? error.message : 'Could not start the session.',
      )
    }
  })

  app.get('/sessions/:sessionId', (c) => {
    const { admin } = requireConsoleSession(c, deps)
    const sessionId = c.req.param('sessionId')
    const live = deps.sessions.getSession(sessionId)
    const stored = deps.sessions.listStoredSessions().find((row) => row.sessionId === sessionId)
    if (!live && !stored) {
      return htmlPage(
        String(renderNotFound('Session not found', `There is no session called "${sessionId}".`)),
        404,
      )
    }
    return htmlPage(String(renderSession(deps, admin, sessionId, flashFrom(c))))
  })

  app.get('/sessions/:sessionId/state', (c) => {
    requireConsoleSession(c, deps)
    const sessionId = c.req.param('sessionId')
    const live = deps.sessions.getSession(sessionId)
    const stored = deps.sessions.listStoredSessions().find((row) => row.sessionId === sessionId)
    if (!live && !stored) return c.json({ ok: false, error: 'Session not found' }, 404)
    return c.json({
      ok: true,
      status: live?.status ?? 'disconnected',
      reason: live?.lastStatusReason ?? stored?.reason ?? null,
      qrDataUrl: live?.qrDataUrl ?? null,
      outbox: deps.outbox.stats(sessionId),
    })
  })

  app.post('/sessions/:sessionId/start', async (c) => {
    const { admin } = requireConsoleSession(c, deps)
    const sessionId = c.req.param('sessionId')
    if (!sessionIdSchema.safeParse(sessionId).success) {
      return redirectFlash(c, '/console/sessions', 'critical', 'Invalid session id.')
    }
    await deps.sessions.startSession(sessionId)
    deps.audit.record(admin.email, 'session.start', sessionId)
    return c.redirect(`/console/sessions/${encodeURIComponent(sessionId)}`, 303)
  })

  app.post('/sessions/:sessionId/logout', async (c) => {
    const { admin } = requireConsoleSession(c, deps)
    const sessionId = c.req.param('sessionId')
    await deps.sessions.logoutSession(sessionId)
    deps.audit.record(admin.email, 'session.logout', sessionId)
    return redirectFlash(c, '/console/sessions', 'success', `Session ${sessionId} logged out.`)
  })

  app.post('/sessions/:sessionId/rename', async (c) => {
    const { admin } = requireConsoleSession(c, deps)
    const sessionId = c.req.param('sessionId')
    const body = await c.req.parseBody()
    const parsed = sessionIdSchema.safeParse(formString(body, 'to').trim())
    if (!parsed.success) {
      return redirectFlash(
        c,
        `/console/sessions/${encodeURIComponent(sessionId)}`,
        'critical',
        'Invalid session id.',
      )
    }
    if (parsed.data === sessionId) {
      return c.redirect(`/console/sessions/${encodeURIComponent(sessionId)}`, 303)
    }

    try {
      await deps.sessions.renameSession(sessionId, parsed.data)
      deps.outbox.renameSession(sessionId, parsed.data)
      deps.audit.record(admin.email, 'session.rename', `${sessionId} → ${parsed.data}`)
      return redirectFlash(
        c,
        `/console/sessions/${encodeURIComponent(parsed.data)}`,
        'success',
        'Session renamed.',
      )
    } catch (error) {
      return redirectFlash(
        c,
        `/console/sessions/${encodeURIComponent(sessionId)}`,
        'critical',
        error instanceof Error ? error.message : 'Rename failed.',
      )
    }
  })

  // -------------------------------------------------------------------------
  // Notifications
  // -------------------------------------------------------------------------

  app.get('/notifications', (c) => {
    const { admin } = requireConsoleSession(c, deps)
    return htmlPage(String(renderNotifications(deps, admin, flashFrom(c))))
  })

  app.post('/notifications', async (c) => {
    const { admin } = requireConsoleSession(c, deps)
    const body = await c.req.parseBody()
    const values = noticeValues(body)

    try {
      const sessionId = parseSessionId(values.sessionId)
      const phone = parsePhone(values.phone)
      const buttons = collectButtons(values).filter((button) => button.id || button.text)
      const media = values.mode === 'media' ? parseMedia(values) : null

      if (values.mode === 'buttons') {
        if (buttons.length === 0) throw new Error('Add at least one button.')
        if (buttons.some((button) => !button.id || !button.text)) {
          throw new Error('Every button needs both an id and a label.')
        }
        if (values.text.trim().length === 0) throw new Error('The message body is required.')
      }
      if (values.mode === 'text' && values.text.trim().length === 0) {
        throw new Error('The message body is required.')
      }
      if (values.mode === 'media' && !media) throw new Error('Add a media URL or base64 payload.')

      if (values.delivery === 'queue') {
        if (!deps.sessions.isKnown(sessionId)) throw new Error('That session is not paired.')
        if (
          media &&
          !/^https?:\/\//i.test(media.data) &&
          media.data.length > MAX_QUEUED_MEDIA_BASE64
        ) {
          throw new Error('Queued media over 1.5 MB must be a URL.')
        }

        const kind = values.kind.trim() || 'console.test'
        if (!/^[a-z_]+(\.[a-z_]+)*$/.test(kind)) throw new Error('Kind must look like order.paid.')
        const idempotencyKey =
          values.idempotencyKey.trim() || `console.test:${Date.now().toString(36)}`

        const queued = deps.outbox.enqueue({
          sessionId,
          idempotencyKey,
          kind,
          to: phone,
          text: media ? media.caption || values.text : values.text,
          ...(media ? { media } : {}),
          ...(values.mode === 'buttons'
            ? { buttons, ...(values.footer.trim() ? { footer: values.footer.trim() } : {}) }
            : {}),
        })
        deps.audit.record(
          admin.email,
          'message.queued',
          `${values.mode} → ${sessionId} (${maskPhone(phone)}) job ${queued.jobId}`,
        )
        return redirectFlash(
          c,
          '/console/notifications',
          'success',
          queued.duplicate
            ? 'That idempotency key was already queued.'
            : `Queued job ${queued.jobId}.`,
        )
      }

      const message = media
        ? { text: media.caption || values.text, media }
        : {
            text: values.text,
            ...(values.mode === 'buttons'
              ? { buttons, ...(values.footer.trim() ? { footer: values.footer.trim() } : {}) }
              : {}),
          }
      const result = await deps.directSender.send(sessionId, phone, message)
      if (!result.ok) {
        return htmlPage(
          String(
            renderNotifications(deps, admin, { tone: 'critical', text: result.error }, values),
          ),
          result.status,
        )
      }

      deps.audit.record(
        admin.email,
        'message.sent',
        `${values.mode} → ${sessionId} (${maskPhone(phone)})`,
      )
      return redirectFlash(
        c,
        '/console/notifications',
        'success',
        `Message accepted${result.result.id ? ` (${result.result.id})` : ''}.`,
      )
    } catch (error) {
      return htmlPage(
        String(
          renderNotifications(
            deps,
            admin,
            {
              tone: 'critical',
              text: error instanceof Error ? error.message : 'Could not send the message.',
            },
            values,
          ),
        ),
        400,
      )
    }
  })

  // -------------------------------------------------------------------------
  // API keys
  // -------------------------------------------------------------------------

  app.get('/api-keys', (c) => {
    const { admin } = requireConsoleSession(c, deps)
    return htmlPage(String(renderApiKeys(deps, admin, flashFrom(c))))
  })

  app.post('/api-keys', async (c) => {
    const { admin } = requireConsoleSession(c, deps)
    const body = await c.req.parseBody()
    const name = formString(body, 'name')

    try {
      const created = deps.apiKeys.create(name)
      deps.audit.record(
        admin.email,
        'api-key.created',
        `${created.record.name} (${created.record.prefix}…)`,
      )
      return htmlPage(
        String(
          renderApiKeys(
            deps,
            admin,
            {
              tone: 'success',
              text: `API key “${created.record.name}” created.`,
            },
            { key: created.key, name: created.record.name },
          ),
        ),
      )
    } catch (error) {
      return htmlPage(
        String(
          renderApiKeys(deps, admin, {
            tone: 'critical',
            text: error instanceof Error ? error.message : 'Could not create the key.',
          }),
        ),
        400,
      )
    }
  })

  app.post('/api-keys/:id/revoke', (c) => {
    const { admin } = requireConsoleSession(c, deps)
    const id = c.req.param('id')
    const key = deps.apiKeys.list().find((item) => item.id === id)
    if (!key) return redirectFlash(c, '/console/api-keys', 'critical', 'That key no longer exists.')
    deps.apiKeys.revoke(id)
    deps.audit.record(admin.email, 'api-key.revoked', `${key.name} (${key.prefix}…)`)
    return redirectFlash(c, '/console/api-keys', 'success', `Revoked “${key.name}”.`)
  })

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  app.get('/settings', (c) => {
    const { admin } = requireConsoleSession(c, deps)
    return htmlPage(String(renderSettings(deps, admin, flashFrom(c))))
  })

  app.post('/settings', async (c) => {
    const { admin } = requireConsoleSession(c, deps)
    const body = await c.req.parseBody()
    const values = settingsValuesFromBody(body)

    try {
      const next = buildSettings(body)
      deps.settings.save(next)
      deps.audit.record(admin.email, 'settings.updated', 'Runtime configuration changed')
      return redirectFlash(c, '/console/settings', 'success', 'Settings saved and applied.')
    } catch (error) {
      return htmlPage(
        String(
          renderSettings(
            deps,
            admin,
            {
              tone: 'critical',
              text: error instanceof Error ? error.message : 'Could not save the settings.',
            },
            values,
          ),
        ),
        400,
      )
    }
  })

  app.post('/settings/reset', (c) => {
    const { admin } = requireConsoleSession(c, deps)
    deps.settings.save(settingsFromConfig(deps.config))
    deps.audit.record(
      admin.email,
      'settings.reset',
      'Runtime settings reset to environment defaults',
    )
    return redirectFlash(
      c,
      '/console/settings',
      'success',
      'Runtime settings reset to environment defaults.',
    )
  })

  // -------------------------------------------------------------------------
  // Security
  // -------------------------------------------------------------------------

  app.get('/security', (c) => {
    const session = requireConsoleSession(c, deps)
    return htmlPage(String(renderSecurity(deps, session.admin, session, flashFrom(c))))
  })

  app.post('/security/password', async (c) => {
    const session = requireConsoleSession(c, deps)
    const body = await c.req.parseBody()
    const current = formString(body, 'current')
    const next = formString(body, 'next')
    const confirm = formString(body, 'confirm')

    if (next !== confirm) {
      return redirectFlash(c, '/console/security', 'critical', 'The new passwords do not match.')
    }
    try {
      const changed = deps.auth.changePassword(session.admin.id, current, next)
      if (!changed) {
        return redirectFlash(c, '/console/security', 'critical', 'Current password is incorrect.')
      }
      deps.audit.record(session.admin.email, 'console.password', 'Password changed')
      clearSessionCookie(c, deps.config)
      return c.redirect('/console/login?ok=Password%20changed.%20Sign%20in%20again.', 303)
    } catch (error) {
      return redirectFlash(
        c,
        '/console/security',
        'critical',
        error instanceof Error ? error.message : 'Could not change the password.',
      )
    }
  })

  app.post('/security/sessions/:id/revoke', (c) => {
    const session = requireConsoleSession(c, deps)
    const id = c.req.param('id')
    if (id === session.session.id) {
      return redirectFlash(
        c,
        '/console/security',
        'warning',
        'That is this session. Use Sign out instead.',
      )
    }
    const owned = deps.auth.listSessions(session.admin.id).some((item) => item.id === id)
    if (!owned)
      return redirectFlash(c, '/console/security', 'critical', 'That session no longer exists.')
    deps.auth.destroyById(id)
    deps.audit.record(session.admin.email, 'console.session.revoked', id.slice(0, 12))
    return redirectFlash(c, '/console/security', 'success', 'Console session revoked.')
  })

  // -------------------------------------------------------------------------
  // Activity
  // -------------------------------------------------------------------------

  app.get('/activity', (c) => {
    const { admin } = requireConsoleSession(c, deps)
    return htmlPage(String(renderActivity(deps, admin, flashFrom(c))))
  })

  app.notFound((c) =>
    htmlPage(String(renderNotFound('Page not found', 'The console page may have moved.')), 404),
  )

  return app
}

function parseSessionId(raw: string): string {
  const parsed = sessionIdSchema.safeParse(raw)
  if (!parsed.success) throw new Error('Choose a valid session.')
  return parsed.data
}

function parsePhone(raw: string): string {
  const value = raw.trim()
  if (value.length < 6 || value.length > 32) throw new Error('Enter a valid phone number.')
  return value
}

function noticeValues(body: Record<string, string | File>): NoticeFormValues {
  const defaults = noticeDefaults()
  const mode = formString(body, 'mode')
  const delivery = formString(body, 'delivery')
  return {
    mode: mode === 'buttons' || mode === 'media' ? mode : 'text',
    delivery: delivery === 'queue' ? 'queue' : 'direct',
    sessionId: formString(body, 'sessionId'),
    phone: formString(body, 'phone'),
    text: formString(body, 'text'),
    footer: formString(body, 'footer'),
    buttonId1: formString(body, 'buttonId1'),
    buttonText1: formString(body, 'buttonText1'),
    buttonId2: formString(body, 'buttonId2'),
    buttonText2: formString(body, 'buttonText2'),
    buttonId3: formString(body, 'buttonId3'),
    buttonText3: formString(body, 'buttonText3'),
    mediaData: formString(body, 'mediaData'),
    mimetype: formString(body, 'mimetype', defaults.mimetype),
    filename: formString(body, 'filename'),
    caption: formString(body, 'caption'),
    kind: formString(body, 'kind', defaults.kind),
    idempotencyKey: formString(body, 'idempotencyKey'),
  }
}

function collectButtons(values: NoticeFormValues): Array<{ id: string; text: string }> {
  return [
    { id: values.buttonId1, text: values.buttonText1 },
    { id: values.buttonId2, text: values.buttonText2 },
    { id: values.buttonId3, text: values.buttonText3 },
  ]
    .map((button) => ({ id: button.id.trim(), text: button.text.trim() }))
    .filter((button) => button.id || button.text)
}

function parseMedia(values: NoticeFormValues): OutboxMedia | null {
  const data = values.mediaData.trim()
  if (!data) return null
  const mimetype = values.mimetype.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(mimetype)) {
    throw new Error('Enter a valid MIME type.')
  }
  return {
    data,
    mimetype,
    ...(values.filename.trim() ? { filename: values.filename.trim() } : {}),
    ...(values.caption.trim() ? { caption: values.caption.trim() } : {}),
  }
}

function settingsValuesFromBody(body: Record<string, string | File>): SettingsFormValues {
  return {
    outboxSendGap: formString(body, 'outboxSendGap'),
    outboxSendJitter: formString(body, 'outboxSendJitter'),
    outboxHourlyCap: formString(body, 'outboxHourlyCap'),
    outboxMaxAgeHours: formString(body, 'outboxMaxAgeHours'),
    outboxMaxAttempts: formString(body, 'outboxMaxAttempts'),
    typingEnabled: formBool(body, 'typingEnabled'),
    typingMin: formString(body, 'typingMin'),
    typingMax: formString(body, 'typingMax'),
    typingMsPerChar: formString(body, 'typingMsPerChar'),
    typingJitter: formString(body, 'typingJitter'),
    inboundUrl: formString(body, 'inboundUrl'),
    statusUrl: formString(body, 'statusUrl'),
    inboundTimeout: formString(body, 'inboundTimeout'),
    statusTimeout: formString(body, 'statusTimeout'),
    mediaMaxMb: formString(body, 'mediaMaxMb'),
    mediaSpoolMaxMb: formString(body, 'mediaSpoolMaxMb'),
    mediaTtlHours: formString(body, 'mediaTtlHours'),
    restoreOnBoot: formBool(body, 'restoreOnBoot'),
    restoreDelay: formString(body, 'restoreDelay'),
    pairingTimeout: formString(body, 'pairingTimeout'),
  }
}

function buildSettings(body: Record<string, string | File>): RuntimeSettings {
  const toMs = (name: string, min = 0): number =>
    Math.round(formNumber(body, name, 0, { min }) * 1000)
  const toBytes = (name: string): number =>
    Math.round(formNumber(body, name, 0, { min: 0 }) * 1024 * 1024)

  return {
    outbox: {
      sendGapMs: toMs('outboxSendGap'),
      sendJitterMs: toMs('outboxSendJitter'),
      hourlyCap: formInteger(body, 'outboxHourlyCap', 0, { min: 0 }),
      maxAgeMs: Math.round(formNumber(body, 'outboxMaxAgeHours', 0, { min: 0 }) * 3_600_000),
      maxAttempts: formInteger(body, 'outboxMaxAttempts', 1, { min: 1, max: 100 }),
    },
    typing: formBool(body, 'typingEnabled')
      ? {
          minMs: toMs('typingMin'),
          maxMs: toMs('typingMax'),
          msPerChar: formInteger(body, 'typingMsPerChar', 0, { min: 0 }),
          jitterRatio: formNumber(body, 'typingJitter', 0, { min: 0, max: 1 }),
        }
      : null,
    inbound: {
      urlTemplate: optionalUrl(formString(body, 'inboundUrl'), 'Inbound URL'),
      statusUrlTemplate: optionalUrl(formString(body, 'statusUrl'), 'Status callback URL'),
      timeoutMs: Math.max(100, toMs('inboundTimeout')),
      statusTimeoutMs: Math.max(100, toMs('statusTimeout')),
      mediaMaxBytes: toBytes('mediaMaxMb'),
      mediaSpoolMaxBytes: toBytes('mediaSpoolMaxMb'),
      mediaTtlMs: Math.round(formNumber(body, 'mediaTtlHours', 0, { min: 0 }) * 3_600_000),
    },
    session: {
      restoreOnBoot: formBool(body, 'restoreOnBoot'),
      restoreDelayMs: toMs('restoreDelay'),
      pairingTimeoutMs: Math.round(formNumber(body, 'pairingTimeout', 1, { min: 0.1 }) * 60_000),
    },
  }
}

function optionalUrl(raw: string, label: string): string | null {
  const value = raw.trim()
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('bad protocol')
    return value
  } catch {
    throw new Error(`${label} must be an http(s) URL or a template containing {sessionId}.`)
  }
}
