import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationState,
  type SignalDataTypeMap,
  type SignalKeyStore,
} from 'baileys'

export interface AuthKeyEntry {
  category: string
  id: string
  /** JSON string, or null to delete the key. */
  value: string | null
}

/**
 * Storage contract for Baileys credentials and signal keys. The SQLite
 * implementation lives in `src/db/whatsapp-auth-store.ts`; keeping the
 * contract here lets the engine stay unaware of the database.
 */
export interface AuthPersistence {
  ensureSession(sessionId: string): void
  loadCreds(sessionId: string): string | null
  saveCreds(sessionId: string, json: string): void
  loadKeys(sessionId: string, category: string, ids: string[]): Record<string, string | null>
  saveKeys(sessionId: string, entries: AuthKeyEntry[]): void
}

export interface StoredSessionInfo {
  sessionId: string
  paired: boolean
  status: string | null
  reason: string | null
  lastConnectedAt: string | null
  updatedAt: string
}

export interface WhatsAppAuthStore extends AuthPersistence {
  hasSession(sessionId: string): boolean
  hasPairedCreds(sessionId: string): boolean
  clearSession(sessionId: string): void
  renameSession(from: string, to: string): void
  listSessionIds(): string[]
  listSessions(): StoredSessionInfo[]
  setStatus(sessionId: string, status: string, reason?: string): void
  getStatus(sessionId: string): {
    status: string | null
    reason: string | null
    lastConnectedAt: string | null
  } | null
}

/**
 * The equivalent of Baileys' mult-file auth state, backed by a persistence
 * adapter. Values are serialized with BufferJSON so Buffers and protobufs
 * survive the round trip exactly as the library's own store does.
 */
export async function getBaileysAuthState(
  store: AuthPersistence,
  sessionId: string,
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  store.ensureSession(sessionId)

  const rawCreds = store.loadCreds(sessionId)
  const creds = rawCreds ? JSON.parse(rawCreds, BufferJSON.reviver) : initAuthCreds()

  const keys: SignalKeyStore = {
    get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
      const stored = store.loadKeys(sessionId, type, ids)
      const data: Record<string, unknown> = {}
      for (const id of ids) {
        const raw = stored[id]
        let value = raw ? JSON.parse(raw, BufferJSON.reviver) : null
        if (type === 'app-state-sync-key' && value) {
          value = proto.Message.AppStateSyncKeyData.fromObject(value)
        }
        data[id] = value
      }
      return data as { [id: string]: SignalDataTypeMap[T] }
    },
    set: async (data) => {
      const entries: AuthKeyEntry[] = []
      for (const category of Object.keys(data)) {
        const categoryData = data[category as keyof typeof data] as Record<string, unknown>
        for (const [id, value] of Object.entries(categoryData)) {
          entries.push({
            category,
            id,
            value: value ? JSON.stringify(value, BufferJSON.replacer) : null,
          })
        }
      }
      if (entries.length > 0) store.saveKeys(sessionId, entries)
    },
  }

  return {
    state: { creds, keys },
    saveCreds: async () => {
      store.saveCreds(sessionId, JSON.stringify(creds, BufferJSON.replacer))
    },
  }
}
