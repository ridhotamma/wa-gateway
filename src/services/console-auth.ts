import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'

import type { SqliteDatabase } from '../db/database.js'

const SCRYPT_N = 16_384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LENGTH = 64

export interface ConsoleAdmin {
  id: string
  email: string
  createdAt: string
  updatedAt: string
}

export interface ConsoleSessionInfo {
  id: string
  adminId: string
  createdAt: string
  expiresAt: string
  lastSeenAt: string
  userAgent: string | null
  ip: string | null
}

export interface LoginMeta {
  userAgent?: string | null
  ip?: string | null
}

interface AdminRow {
  id: string
  email: string
  password_hash: string
  created_at: string
  updated_at: string
}

interface SessionRow {
  id: string
  admin_id: string
  created_at: string
  expires_at: string
  last_seen_at: string
  user_agent: string | null
  ip: string | null
}

function toAdmin(row: AdminRow): ConsoleAdmin {
  return {
    id: row.id,
    email: row.email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toSession(row: SessionRow): ConsoleSessionInfo {
  return {
    id: row.id,
    adminId: row.admin_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
    userAgent: row.user_agent,
    ip: row.ip,
  }
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  })
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${hash.toString('hex')}`
}

function verifyPassword(password: string, stored: string): boolean {
  const [scheme, n, r, p, saltHex, hashHex] = stored.split('$')
  if (scheme !== 'scrypt' || !n || !r || !p || !saltHex || !hashHex) return false

  try {
    const expected = Buffer.from(hashHex, 'hex')
    const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    })
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}

/**
 * Console authentication: admins and sessions are rows in SQLite. Sessions
 * are random bearer tokens; the database stores only their SHA-256 hash, so a
 * database read cannot mint a cookie.
 */
export class ConsoleAuthStore {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly sessionTtlMs: number,
  ) {}

  countAdmins(): number {
    const row = this.db.prepare('SELECT count(*) AS count FROM console_admins').get() as {
      count: number
    }
    return row.count
  }

  findAdminByEmail(email: string): ConsoleAdmin | null {
    const row = this.db
      .prepare('SELECT * FROM console_admins WHERE email = ?')
      .get(email.trim().toLowerCase()) as AdminRow | undefined
    return row ? toAdmin(row) : null
  }

  /** Create the first admin only; later admins are not seeded from env. */
  seedAdmin(email: string, password: string): ConsoleAdmin | null {
    if (this.countAdmins() > 0) return null
    return this.createAdmin(email, password)
  }

  createAdmin(email: string, password: string): ConsoleAdmin {
    const address = normaliseEmail(email)
    validatePassword(password)
    if (this.findAdminByEmail(address)) {
      throw new Error('An admin with that email already exists.')
    }

    const now = new Date().toISOString()
    const admin: ConsoleAdmin = {
      id: randomUUID(),
      email: address,
      createdAt: now,
      updatedAt: now,
    }
    this.db
      .prepare(
        `INSERT INTO console_admins (id, email, password_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(admin.id, admin.email, hashPassword(password), now, now)
    return admin
  }

  authenticate(
    email: string,
    password: string,
    meta: LoginMeta = {},
  ): { token: string; admin: ConsoleAdmin } | null {
    const row = this.db
      .prepare('SELECT * FROM console_admins WHERE email = ?')
      .get(email.trim().toLowerCase()) as AdminRow | undefined
    if (!row || !verifyPassword(password, row.password_hash)) return null

    this.cleanupExpired()
    const token = randomBytes(32).toString('base64url')
    const now = new Date()
    const expires = new Date(now.getTime() + this.sessionTtlMs)
    this.db
      .prepare(
        `INSERT INTO console_sessions
           (id, admin_id, created_at, expires_at, last_seen_at, user_agent, ip)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        tokenHash(token),
        row.id,
        now.toISOString(),
        expires.toISOString(),
        now.toISOString(),
        meta.userAgent ?? null,
        meta.ip ?? null,
      )

    return { token, admin: toAdmin(row) }
  }

  resolve(token: string): { admin: ConsoleAdmin; session: ConsoleSessionInfo } | null {
    if (!token) return null
    const row = this.db
      .prepare(
        `SELECT s.*, a.email, a.created_at AS admin_created_at,
                a.updated_at AS admin_updated_at
         FROM console_sessions s
         JOIN console_admins a ON a.id = s.admin_id
         WHERE s.id = ?`,
      )
      .get(tokenHash(token)) as
      | (SessionRow & {
          email: string
          admin_created_at: string
          admin_updated_at: string
        })
      | undefined
    if (!row) return null

    const now = Date.now()
    if (Date.parse(row.expires_at) <= now) {
      this.db.prepare('DELETE FROM console_sessions WHERE id = ?').run(row.id)
      return null
    }

    if (now - Date.parse(row.last_seen_at) > 60_000) {
      this.db
        .prepare('UPDATE console_sessions SET last_seen_at = ? WHERE id = ?')
        .run(new Date(now).toISOString(), row.id)
      row.last_seen_at = new Date(now).toISOString()
    }

    return {
      admin: {
        id: row.admin_id,
        email: row.email,
        createdAt: row.admin_created_at,
        updatedAt: row.admin_updated_at,
      },
      session: toSession(row),
    }
  }

  destroy(token: string): void {
    if (!token) return
    this.db.prepare('DELETE FROM console_sessions WHERE id = ?').run(tokenHash(token))
  }

  destroyById(sessionId: string): void {
    this.db.prepare('DELETE FROM console_sessions WHERE id = ?').run(sessionId)
  }

  /** Operator CLI: reset a password without knowing the current one. */
  resetPassword(email: string, next: string): ConsoleAdmin | null {
    const row = this.db
      .prepare('SELECT * FROM console_admins WHERE email = ?')
      .get(email.trim().toLowerCase()) as AdminRow | undefined
    if (!row) return null

    validatePassword(next)
    const now = new Date().toISOString()
    this.db
      .prepare('UPDATE console_admins SET password_hash = ?, updated_at = ? WHERE id = ?')
      .run(hashPassword(next), now, row.id)
    this.db.prepare('DELETE FROM console_sessions WHERE admin_id = ?').run(row.id)
    return { ...toAdmin(row), updatedAt: now }
  }

  /** Change a password and end every existing session. */
  changePassword(adminId: string, current: string, next: string): boolean {
    const row = this.db.prepare('SELECT * FROM console_admins WHERE id = ?').get(adminId) as
      AdminRow | undefined
    if (!row || !verifyPassword(current, row.password_hash)) return false
    validatePassword(next)

    const now = new Date().toISOString()
    this.db
      .prepare('UPDATE console_admins SET password_hash = ?, updated_at = ? WHERE id = ?')
      .run(hashPassword(next), now, adminId)
    this.db.prepare('DELETE FROM console_sessions WHERE admin_id = ?').run(adminId)
    return true
  }

  listSessions(adminId: string): ConsoleSessionInfo[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM console_sessions
         WHERE admin_id = ? AND expires_at > ?
         ORDER BY last_seen_at DESC`,
      )
      .all(adminId, new Date().toISOString()) as SessionRow[]
    return rows.map(toSession)
  }

  cleanupExpired(): void {
    this.db
      .prepare('DELETE FROM console_sessions WHERE expires_at <= ?')
      .run(new Date().toISOString())
  }
}

function normaliseEmail(email: string): string {
  const address = email.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    throw new Error('Enter a valid email address.')
  }
  return address
}

function validatePassword(password: string): void {
  if (password.length < 10) {
    throw new Error('The password must be at least 10 characters.')
  }
  if (password.length > 200) {
    throw new Error('The password must be at most 200 characters.')
  }
}
