import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { MediaStore } from './media-store.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'wa-media-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const meta = {
  kind: 'image' as const,
  mimetype: 'image/jpeg',
  filename: 'photo.jpg',
  sizeBytes: 4,
}

describe('MediaStore', () => {
  test('round-trips bytes without exposing the WhatsApp message id', async () => {
    const store = new MediaStore(dir)
    const saved = await store.save('shop', 'MSG1', meta, Buffer.from('jpeg'))

    expect(saved.id).toMatch(/^[a-f0-9]{32}$/)
    expect(saved.id).not.toContain('MSG1')
    const read = await store.read('shop', saved.id)
    expect(read?.data.toString()).toBe('jpeg')
    expect(read?.media).toMatchObject({
      kind: 'image',
      mimetype: 'image/jpeg',
      filename: 'photo.jpg',
      sizeBytes: 4,
    })
    // The metadata file must never carry the attachment bytes.
    const storedMeta = readFileSync(path.join(dir, 'shop', `${saved.id}.json`), 'utf8')
    expect(storedMeta).not.toContain('"data"')
  })

  test('rejects another session or a forged id', async () => {
    const store = new MediaStore(dir)
    const saved = await store.save('shop', 'MSG1', meta, Buffer.from('jpeg'))
    expect(await store.read('other', saved.id)).toBeNull()
    expect(await store.read('shop', '../MSG1')).toBeNull()
  })

  test('prunes files past the retention window', async () => {
    const store = new MediaStore(dir, 0)
    const saved = await store.save('shop', 'MSG1', meta, Buffer.from('jpeg'))
    expect(await store.prune(Date.now() + 1_000)).toBeGreaterThan(0)
    expect(await store.read('shop', saved.id)).toBeNull()
  })

  test('trims the oldest files when the spool byte cap is exceeded', async () => {
    const store = new MediaStore(dir, 1e15, 4)
    const oldest = await store.save('shop', 'OLD', meta, Buffer.from('aaaa'))
    const newest = await store.save('shop', 'NEW', meta, Buffer.from('bbbb'))
    const oldPath = path.join(dir, 'shop', `${oldest.id}.bin`)
    const newPath = path.join(dir, 'shop', `${newest.id}.bin`)
    utimesSync(oldPath, new Date(1_000), new Date(1_000))
    utimesSync(newPath, new Date(2_000), new Date(2_000))

    await store.prune(Date.now())
    expect(await store.read('shop', oldest.id)).toBeNull()
    expect((await store.read('shop', newest.id))?.data.toString()).toBe('bbbb')
  })
})
