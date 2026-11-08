import type { ConsoleDependencies } from './types.js'

export interface SessionRowView {
  sessionId: string
  status: string
  reason: string | null
  paired: boolean
  lastConnectedAt: string | null
  updatedAt: string | null
  outbox: { pending: number; failedLastDay: number }
  active: boolean
}

/** Merge live socket state with the durable session row in SQLite. */
export function listSessionRows(deps: ConsoleDependencies): SessionRowView[] {
  const active = new Map(
    deps.sessions.listSessions().map((session) => [session.sessionId, session]),
  )
  const stored = new Map(
    deps.sessions.listStoredSessions().map((session) => [session.sessionId, session]),
  )
  const ids = new Set([...stored.keys(), ...active.keys()])

  return [...ids]
    .sort((a, b) => a.localeCompare(b))
    .map((sessionId) => {
      const live = active.get(sessionId)
      const row = stored.get(sessionId)
      return {
        sessionId,
        // A stored status is last-known, not live: without a socket the
        // session is disconnected until boot restore or a new start.
        status: live?.status ?? 'disconnected',
        reason: live?.reason ?? row?.reason ?? null,
        paired: row?.paired ?? false,
        lastConnectedAt: row?.lastConnectedAt ?? null,
        updatedAt: row?.updatedAt ?? null,
        outbox: deps.outbox.stats(sessionId),
        active: live !== undefined && live.status !== 'disconnected',
      }
    })
}
