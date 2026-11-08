import { useMultiFileAuthState } from 'baileys'
import * as fs from 'node:fs'
import * as path from 'node:path'

export interface BaileysSessionConfig {
  sessionId: string
  authDir?: string
}

/** Base directory holding one sub-directory per session. */
export function getAuthBaseDir(authDir?: string): string {
  // Explicit arg wins, then WHATSAPP_AUTH_DIR (absolute in prod, e.g.
  // /data/sessions; relative resolves against process.cwd()), then
  // ./.whatsapp-sessions under the daemon's working directory.
  return authDir ?? process.env.WHATSAPP_AUTH_DIR ?? path.join(process.cwd(), '.whatsapp-sessions')
}

/**
 * A session is restorable without a new QR scan only once pairing completed.
 * `creds.json` alone is not proof: Baileys writes it as soon as the socket
 * generates its noise keys, before any QR is scanned. `me` is only filled in
 * when the phone links the device.
 */
export function hasPairedCreds(baseDir: string, sessionId: string): boolean {
  try {
    const raw = fs.readFileSync(path.join(baseDir, sessionId, 'creds.json'), 'utf8')
    const creds = JSON.parse(raw) as { me?: { id?: unknown } }
    return typeof creds.me?.id === 'string' && creds.me.id !== ''
  } catch {
    return false
  }
}

/** Removes a session's auth directory (logout, abandoned pairing, bad session). */
export function clearSessionDir(baseDir: string, sessionId: string): void {
  fs.rmSync(path.join(baseDir, sessionId), { recursive: true, force: true })
}

/**
 * Provides multi-file authentication state for Baileys.
 * Saves auth keys and credentials to disk per session. In v7 the same store
 * also persists the LID <-> phone-number mapping (`lid-mapping-*` files).
 */
export async function getBaileysAuthState(config: BaileysSessionConfig) {
  const baseDir = getAuthBaseDir(config.authDir)
  const sessionDir = path.join(baseDir, config.sessionId)

  fs.mkdirSync(sessionDir, { recursive: true })

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir)

  return {
    state,
    saveCreds,
    sessionDir,
    clearSession: () => clearSessionDir(baseDir, config.sessionId),
  }
}
