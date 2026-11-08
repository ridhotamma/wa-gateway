import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { openDatabase, type SqliteDatabase } from '../db/database.js'
import { ConsoleAuthStore } from './console-auth.js'

let db: SqliteDatabase
let auth: ConsoleAuthStore

beforeEach(() => {
  db = openDatabase(':memory:')
  auth = new ConsoleAuthStore(db, 60_000)
})

afterEach(() => {
  db.close()
})

describe('ConsoleAuthStore', () => {
  test('creates an admin and signs in with a hashed session token', () => {
    const admin = auth.createAdmin('Admin@Example.com', 'a-long-password')
    expect(admin.email).toBe('admin@example.com')

    const login = auth.authenticate('admin@example.com', 'a-long-password', {
      ip: '127.0.0.1',
      userAgent: 'vitest',
    })
    expect(login?.token).toHaveLength(43)
    expect(login?.admin.email).toBe('admin@example.com')

    const resolved = auth.resolve(login!.token)
    expect(resolved?.admin.id).toBe(admin.id)
    expect(resolved?.session.ip).toBe('127.0.0.1')

    const row = db.prepare('SELECT id FROM console_sessions WHERE admin_id = ?').get(admin.id) as {
      id: string
    }
    expect(row.id).not.toBe(login!.token)
  })

  test('rejects a wrong password and a revoked session', () => {
    auth.createAdmin('admin@example.com', 'a-long-password')
    expect(auth.authenticate('admin@example.com', 'wrong-password')).toBeNull()

    const login = auth.authenticate('admin@example.com', 'a-long-password')!
    auth.destroy(login.token)
    expect(auth.resolve(login.token)).toBeNull()
  })

  test('seeds the first admin only once', () => {
    expect(auth.seedAdmin('first@example.com', 'a-long-password')?.email).toBe('first@example.com')
    expect(auth.seedAdmin('second@example.com', 'a-long-password')).toBeNull()
    expect(auth.countAdmins()).toBe(1)
  })

  test('changes a password and signs out every session', () => {
    const admin = auth.createAdmin('admin@example.com', 'a-long-password')
    const login = auth.authenticate('admin@example.com', 'a-long-password')!

    expect(auth.changePassword(admin.id, 'wrong', 'another-long-password')).toBe(false)
    expect(auth.changePassword(admin.id, 'a-long-password', 'another-long-password')).toBe(true)

    expect(auth.resolve(login.token)).toBeNull()
    expect(auth.authenticate('admin@example.com', 'a-long-password')).toBeNull()
    expect(auth.authenticate('admin@example.com', 'another-long-password')).not.toBeNull()
  })

  test('lists and revokes individual console sessions', () => {
    const admin = auth.createAdmin('admin@example.com', 'a-long-password')
    const first = auth.authenticate('admin@example.com', 'a-long-password')!
    auth.authenticate('admin@example.com', 'a-long-password')

    const sessions = auth.listSessions(admin.id)
    expect(sessions).toHaveLength(2)

    auth.destroyById(sessions[0]!.id)
    expect(auth.listSessions(admin.id)).toHaveLength(1)
    expect(auth.resolve(first.token)).not.toBeNull()
  })

  test('validates email and password strength', () => {
    expect(() => auth.createAdmin('not-an-email', 'a-long-password')).toThrow(
      'Enter a valid email address.',
    )
    expect(() => auth.createAdmin('admin@example.com', 'short')).toThrow(
      'The password must be at least 10 characters.',
    )
  })
})
