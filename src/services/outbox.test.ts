import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { openDatabase, type SqliteDatabase } from '../db/database.js'
import { PermanentSendError, type MessageResult } from '../engine/index.js'
import { Outbox, type OutboxMessage, type OutboxSender, type OutboxSettlement } from './outbox.js'
import type { RuntimeSettings } from './settings-store.js'

let dir: string
let db: SqliteDatabase
let outbox: Outbox | null = null

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'wa-outbox-'))
  db = openDatabase(':memory:')
})

afterEach(async () => {
  await outbox?.stop()
  outbox = null
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function runtime(overrides: Partial<RuntimeSettings['outbox']> = {}): RuntimeSettings {
  return {
    outbox: {
      sendGapMs: 0,
      sendJitterMs: 0,
      hourlyCap: 100,
      maxAgeMs: 60_000,
      maxAttempts: 3,
      ...overrides,
    },
    typing: null,
    inbound: {
      urlTemplate: null,
      statusUrlTemplate: null,
      timeoutMs: 1_000,
      statusTimeoutMs: 1_000,
      mediaMaxBytes: 1_000_000,
      mediaSpoolMaxBytes: 1_000_000,
      mediaTtlMs: 60_000,
    },
    session: {
      restoreOnBoot: false,
      restoreDelayMs: 0,
      pairingTimeoutMs: 60_000,
    },
  }
}

function makeOutbox(
  sender: OutboxSender,
  options: {
    outbox?: Partial<RuntimeSettings['outbox']>
    onSettled?: (event: OutboxSettlement) => void
  } = {},
): Outbox {
  outbox = new Outbox(
    {
      db,
      settings: runtime(options.outbox),
      ...(options.onSettled ? { onSettled: options.onSettled } : {}),
    },
    sender,
  )
  outbox.start()
  return outbox
}

const ok = (): Promise<MessageResult> => Promise.resolve({ id: 'm1', timestamp: 1 })
const job = (key = 'order:1:paid') => ({
  sessionId: 'shop',
  idempotencyKey: key,
  kind: 'order.paid',
  to: '628123456789',
  text: 'hello',
})
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function row(idempotencyKey = 'order:1:paid') {
  return db
    .prepare('SELECT * FROM outbox_jobs WHERE session_id = ? AND idempotency_key = ?')
    .get('shop', idempotencyKey) as
    | {
        status: string
        to_phone: string
        text: string
        attempts: number
        message_id: string | null
        fail_reason: string | null
        media_json: string | null
        buttons_json: string | null
      }
    | undefined
}

describe('Outbox', () => {
  test('sends a queued job and scrubs the completed row', async () => {
    const sent: string[] = []
    makeOutbox({ send: (_session, to) => (sent.push(to), ok()) }).enqueue(job())
    await wait(1_300)

    expect(sent).toEqual(['628123456789'])
    expect(row()).toMatchObject({
      status: 'done',
      message_id: 'm1',
      to_phone: '',
      text: '',
    })
  })

  test('queues an attachment and hands it to the sender', async () => {
    const sent: Array<{ to: string; text: string; media?: unknown }> = []
    makeOutbox({
      send: (_session, to, message) => (sent.push({ to, ...message }), ok()),
    }).enqueue({
      ...job('media:1'),
      text: 'Invoice',
      media: {
        data: 'https://example.com/invoice.pdf',
        mimetype: 'application/pdf',
        filename: 'invoice.pdf',
      },
    })
    await wait(1_300)

    expect(sent).toEqual([
      {
        to: '628123456789',
        text: 'Invoice',
        media: {
          data: 'https://example.com/invoice.pdf',
          mimetype: 'application/pdf',
          filename: 'invoice.pdf',
        },
      },
    ])
  })

  test('keeps the chatbot typing hint until the sender delivers it', async () => {
    const sent: OutboxMessage[] = []
    makeOutbox({
      send: (_session, _to, message) => (sent.push(message), ok()),
    }).enqueue({ ...job('chatbot:1'), kind: 'chatbot.llm', typing: true })
    await wait(1_300)

    expect(sent).toEqual([{ text: 'hello', typing: true }])
  })

  test('queues reply buttons and keeps them across a restart', async () => {
    makeOutbox({ send: () => null }).enqueue({
      ...job('buttons:1'),
      text: 'Place this order?',
      buttons: [
        { id: 'yes', text: 'Yes' },
        { id: 'no', text: 'No' },
      ],
    })
    await outbox!.stop()

    const sent: Array<{ text: string; buttons?: unknown }> = []
    makeOutbox({
      send: (_session, _to, message) => (sent.push(message), ok()),
    })
    await wait(1_300)

    expect(sent).toEqual([
      {
        text: 'Place this order?',
        buttons: [
          { id: 'yes', text: 'Yes' },
          { id: 'no', text: 'No' },
        ],
      },
    ])
  })

  test('same idempotency key sends once, even after it was delivered', async () => {
    let calls = 0
    const box = makeOutbox({ send: () => (calls++, ok()) })
    expect(box.enqueue(job()).duplicate).toBe(false)
    expect(box.enqueue(job()).duplicate).toBe(true)
    await wait(1_300)
    expect(box.enqueue(job()).duplicate).toBe(true)
    await wait(1_100)
    expect(calls).toBe(1)
  })

  test('waits while the session is not ready without spending attempts', async () => {
    let ready = false
    let calls = 0
    const box = makeOutbox({ send: () => (ready ? (calls++, ok()) : null) })
    box.enqueue(job())
    await wait(2_200)
    expect(calls).toBe(0)
    expect(box.stats('shop').pending).toBe(1)
    ready = true
    await wait(1_200)
    expect(calls).toBe(1)
  })

  test('drops permanently undeliverable jobs with a masked recipient', async () => {
    makeOutbox({
      send: () => Promise.reject(new PermanentSendError('nope', 'not_on_whatsapp')),
    }).enqueue(job())
    await wait(1_300)

    expect(row()).toMatchObject({
      status: 'failed',
      fail_reason: 'not_on_whatsapp',
      to_phone: '********6789',
      text: '',
    })
  })

  test('reports a sent job with its message id', async () => {
    const settled: OutboxSettlement[] = []
    makeOutbox(
      { send: () => ok() },
      {
        onSettled: (event) => {
          settled.push(event)
        },
      },
    ).enqueue(job())
    await wait(1_300)

    expect(settled).toEqual([
      expect.objectContaining({
        sessionId: 'shop',
        idempotencyKey: 'order:1:paid',
        kind: 'order.paid',
        status: 'sent',
        messageId: 'm1',
      }),
    ])
  })

  test('reports a permanently failed job with its reason', async () => {
    const settled: OutboxSettlement[] = []
    makeOutbox(
      { send: () => Promise.reject(new PermanentSendError('nope', 'not_on_whatsapp')) },
      {
        onSettled: (event) => {
          settled.push(event)
        },
      },
    ).enqueue(job())
    await wait(1_300)

    expect(settled).toEqual([
      expect.objectContaining({
        idempotencyKey: 'order:1:paid',
        status: 'failed',
        reason: 'not_on_whatsapp',
      }),
    ])
  })

  test('a callback that throws never breaks the queue', async () => {
    const box = makeOutbox(
      { send: () => ok() },
      {
        onSettled: () => {
          throw new Error('callback down')
        },
      },
    )
    box.enqueue(job())
    await wait(1_300)

    expect(row()?.status).toBe('done')
  })

  test('backs off after a transient failure instead of hammering', async () => {
    let calls = 0
    const box = makeOutbox({
      send: () => (calls++, Promise.reject(new Error('socket closed'))),
    })
    box.enqueue(job())
    await wait(3_200)

    expect(calls).toBe(1) // next attempt is 30s out
    expect(box.stats('shop').pending).toBe(1)
    expect(row()?.attempts).toBe(1)
  })

  test('resumes pending jobs after a restart', async () => {
    makeOutbox({ send: () => null }).enqueue(job())
    await outbox!.stop()

    const sent: string[] = []
    makeOutbox({ send: (_session, to) => (sent.push(to), ok()) })
    await wait(1_300)

    expect(sent).toEqual(['628123456789'])
  })

  test('paces sends of one session by the configured gap', async () => {
    const times: number[] = []
    const box = makeOutbox(
      { send: () => (times.push(Date.now()), ok()) },
      { outbox: { sendGapMs: 1_500 } },
    )
    box.enqueue(job('a'))
    box.enqueue(job('b'))
    await wait(3_300)

    expect(times).toHaveLength(2)
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(1_400)
  })

  test('direct sends share the hourly cap', () => {
    const box = makeOutbox({ send: () => null }, { outbox: { hourlyCap: 2 } })
    expect(box.reserveDirectSend('shop').ok).toBe(true)
    expect(box.reserveDirectSend('shop').ok).toBe(true)
    expect(box.reserveDirectSend('shop').ok).toBe(false)
  })

  test('rename moves pending jobs to the new session id', async () => {
    const sentFor: string[] = []
    let ready = false
    const box = makeOutbox({ send: (session) => (ready ? (sentFor.push(session), ok()) : null) })
    box.enqueue(job())
    box.renameSession('shop', 'new-shop')
    ready = true
    await wait(1_300)

    expect(sentFor).toEqual(['new-shop'])
    expect(
      db
        .prepare('SELECT session_id FROM outbox_jobs WHERE idempotency_key = ?')
        .get('order:1:paid'),
    ).toEqual({ session_id: 'new-shop' })
  })
})
