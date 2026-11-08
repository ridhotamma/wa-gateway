import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PermanentSendError, type MessageResult } from '../engine/index.js'
import {
  Outbox,
  type OutboxMessage,
  type OutboxOptions,
  type OutboxSender,
  type OutboxSettlement,
} from './outbox.js'

let dir: string
let outbox: Outbox | null = null

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'wa-outbox-'))
})

afterEach(() => {
  outbox?.stop()
  outbox = null
  rmSync(dir, { recursive: true, force: true })
})

function makeOutbox(sender: OutboxSender, options: Partial<OutboxOptions> = {}): Outbox {
  outbox = new Outbox(
    {
      dir,
      sendGapMs: 0,
      sendJitterMs: 0,
      hourlyCap: 100,
      maxAgeMs: 60_000,
      maxAttempts: 3,
      ...options,
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
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const files = (bucket: string) => {
  const d = path.join(dir, bucket, 'shop')
  return existsSync(d) ? readdirSync(d) : []
}

describe('Outbox', () => {
  test('sends a queued job and leaves only a PII-free marker', async () => {
    const sent: string[] = []
    makeOutbox({ send: (_s, to) => (sent.push(to), ok()) }).enqueue(job())
    await wait(1_300)
    expect(sent).toEqual(['628123456789'])
    expect(files('pending')).toHaveLength(0)
    const [marker] = files('done')
    const content = readFileSync(path.join(dir, 'done', 'shop', marker!), 'utf8')
    expect(content).not.toContain('628123456789')
    expect(content).not.toContain('hello')
  })

  test('queues an attachment and hands it to the sender', async () => {
    const sent: Array<{ to: string; text: string; media?: unknown }> = []
    makeOutbox({
      send: (_s, to, message) => (sent.push({ to, ...message }), ok()),
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
      send: (_s, _to, message) => (sent.push(message), ok()),
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
    outbox!.stop()

    const sent: Array<{ text: string; buttons?: unknown }> = []
    makeOutbox({
      send: (_s, _to, message) => (sent.push(message), ok()),
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
    expect(files('pending')).toHaveLength(0)
    const [failed] = files('failed')
    const record = JSON.parse(readFileSync(path.join(dir, 'failed', 'shop', failed!), 'utf8'))
    expect(record.reason).toBe('not_on_whatsapp')
    expect(record.to).toBe('********6789')
    expect(record.text).toBeUndefined()
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
    expect(files('pending')).toHaveLength(0)
    expect(files('done')).toHaveLength(1)
  })

  test('backs off after a transient failure instead of hammering', async () => {
    let calls = 0
    const box = makeOutbox({ send: () => (calls++, Promise.reject(new Error('socket closed'))) })
    box.enqueue(job())
    await wait(3_200)
    expect(calls).toBe(1) // next attempt is 30s out
    expect(box.stats('shop').pending).toBe(1)
  })

  test('resumes pending jobs after a restart', async () => {
    makeOutbox({ send: () => null }).enqueue(job())
    outbox!.stop()
    const sent: string[] = []
    makeOutbox({ send: (_s, to) => (sent.push(to), ok()) })
    await wait(1_300)
    expect(sent).toEqual(['628123456789'])
  })

  test('paces sends of one session by the configured gap', async () => {
    const times: number[] = []
    const box = makeOutbox({ send: () => (times.push(Date.now()), ok()) }, { sendGapMs: 1_500 })
    box.enqueue(job('a'))
    box.enqueue(job('b'))
    await wait(3_300)
    expect(times).toHaveLength(2)
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(1_400)
  })

  test('direct sends share the hourly cap', () => {
    const box = makeOutbox({ send: () => null }, { hourlyCap: 2 })
    expect(box.reserveDirectSend('shop').ok).toBe(true)
    expect(box.reserveDirectSend('shop').ok).toBe(true)
    expect(box.reserveDirectSend('shop').ok).toBe(false)
  })

  test('rename moves pending jobs to the new session id', async () => {
    const sentFor: string[] = []
    let ready = false
    const box = makeOutbox({ send: (s) => (ready ? (sentFor.push(s), ok()) : null) })
    box.enqueue(job())
    box.renameSession('shop', 'new-shop')
    ready = true
    await wait(1_300)
    expect(sentFor).toEqual(['new-shop'])
  })
})
