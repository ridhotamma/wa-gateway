import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { openDatabase, type SqliteDatabase } from '../db/database.js'
import { getBaileysAuthState } from '../engine/baileys/auth-state.js'
import { SqliteWhatsAppAuthStore } from '../db/whatsapp-auth-store.js'

let db: SqliteDatabase
let store: SqliteWhatsAppAuthStore

beforeEach(() => {
  db = openDatabase(':memory:')
  store = new SqliteWhatsAppAuthStore(db)
})

afterEach(() => {
  db.close()
})

describe('SqliteWhatsAppAuthStore', () => {
  test('stores credentials and detects a completed pairing', () => {
    store.ensureSession('shop')
    store.saveCreds('shop', JSON.stringify({ me: { id: '6281234567890:1@s.whatsapp.net' } }))
    expect(store.hasPairedCreds('shop')).toBe(true)
    expect(store.listSessions()).toEqual([
      expect.objectContaining({ sessionId: 'shop', paired: true }),
    ])

    store.clearSession('shop')
    expect(store.hasSession('shop')).toBe(false)
    expect(store.hasPairedCreds('shop')).toBe(false)
  })

  test('upserts and deletes signal keys', () => {
    store.ensureSession('shop')
    store.saveKeys('shop', [{ category: 'pre-key', id: '1', value: '{"a":1}' }])
    store.saveKeys('shop', [{ category: 'pre-key', id: '2', value: '{"b":2}' }])
    expect(store.loadKeys('shop', 'pre-key', ['1', '2', '3'])).toEqual({
      '1': '{"a":1}',
      '2': '{"b":2}',
    })

    store.saveKeys('shop', [{ category: 'pre-key', id: '1', value: null }])
    expect(store.loadKeys('shop', 'pre-key', ['1'])).toEqual({})
  })

  test('renames a session and cascades its keys', () => {
    store.ensureSession('shop')
    store.saveKeys('shop', [{ category: 'session', id: 'a', value: '{"x":1}' }])
    store.renameSession('shop', 'toko-baru')

    expect(store.hasSession('shop')).toBe(false)
    expect(store.hasSession('toko-baru')).toBe(true)
    expect(store.loadKeys('toko-baru', 'session', ['a'])).toEqual({ a: '{"x":1}' })
  })

  test('persists the last known status', () => {
    store.setStatus('shop', 'ready', 'connected')
    expect(store.getStatus('shop')).toMatchObject({
      status: 'ready',
      reason: 'connected',
    })
    expect(store.getStatus('shop')?.lastConnectedAt).not.toBeNull()
    expect(store.listSessions()[0]).toMatchObject({ status: 'ready', reason: 'connected' })
  })

  test('exposes credentials and signal keys to the Baileys auth helper', async () => {
    const first = await getBaileysAuthState(store, 'shop')
    ;(first.state.creds as { me?: { id: string } }).me = {
      id: '6281234567890:1@s.whatsapp.net',
    }
    await first.saveCreds()
    expect(store.hasPairedCreds('shop')).toBe(true)

    await first.state.keys.set({
      'pre-key': { '1': { private: Buffer.from([1, 2, 3]) } },
    } as never)

    const again = await getBaileysAuthState(store, 'shop')
    const loaded = await again.state.keys.get('pre-key', ['1'])
    expect(loaded['1']).toBeTruthy()
    expect(store.loadKeys('shop', 'pre-key', ['1'])['1']).toContain('"private"')
  })
})
