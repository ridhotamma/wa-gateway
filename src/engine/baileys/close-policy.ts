/**
 * What to do when a Baileys socket closes, as a pure decision so it can be
 * tested without a WhatsApp connection.
 *
 * The one rule that matters most here: **an unpaired socket is never
 * reconnected.** Baileys shows a handful of QR codes (the first for 60s, the
 * rest for 20s each) and then closes the socket itself with 408, "QR refs
 * attempts ended". Treating that as a dropped connection used to open a new
 * socket with new QRs, over and over, for a pairing nobody was looking at any
 * more; closing the browser tab does not end a pairing, only this does.
 */

import { DisconnectReason } from 'baileys'

/**
 * Close codes after which reconnecting is pointless or harmful. Each maps to
 * the reason reported to the caller and whether the saved credentials are
 * dead (a re-scan is needed either way, but dead creds must not be restored
 * on the next boot).
 */
export const TERMINAL_CLOSES: Partial<Record<number, { reason: string; clearCreds: boolean }>> = {
  // Unlinked from the phone, or the session was revoked.
  [DisconnectReason.loggedOut]: { reason: 'logged_out', clearCreds: true },
  // Another socket took over this account — reconnecting makes the two fight
  // (e.g. a second replica, or a dev daemon sharing prod credentials).
  [DisconnectReason.connectionReplaced]: { reason: 'connection_replaced', clearCreds: false },
  // Account banned or blocked from linking devices.
  [DisconnectReason.forbidden]: { reason: 'forbidden', clearCreds: false },
  // Credentials no longer match the device list; only a re-pair fixes it.
  [DisconnectReason.multideviceMismatch]: { reason: 'multidevice_mismatch', clearCreds: true },
  [DisconnectReason.badSession]: { reason: 'bad_session', clearCreds: true },
}

export type CloseAction =
  /** Stop for good. `status` is what the session reports. */
  | { kind: 'terminal'; reason: string; clearCreds: boolean; status: 'disconnected' | 'failed' }
  /** WhatsApp asked the freshly scanned device to reconnect: do it now. */
  | { kind: 'restart' }
  /** The pairing is over without a scan: stop, and drop the half-made keys. */
  | { kind: 'pairing_ended'; reason: string }
  /** A paired session dropped: reconnect with backoff, forever. */
  | { kind: 'reconnect'; reason: string }

export function closeAction(statusCode: number | undefined, paired: boolean): CloseAction {
  const terminal = statusCode !== undefined ? TERMINAL_CLOSES[statusCode] : undefined
  if (terminal) {
    return {
      kind: 'terminal',
      reason: terminal.reason,
      clearCreds: terminal.clearCreds,
      status: terminal.reason === 'logged_out' ? 'disconnected' : 'failed',
    }
  }

  // 515 is expected right after a QR scan. It comes before the unpaired check
  // on purpose: it is the one close an unpaired-looking socket must follow,
  // and it only ever arrives once the phone has scanned.
  if (statusCode === DisconnectReason.restartRequired) return { kind: 'restart' }

  if (!paired) {
    return {
      kind: 'pairing_ended',
      reason:
        statusCode === DisconnectReason.timedOut
          ? 'qr_timeout'
          : `pairing_interrupted_${statusCode ?? 'unknown'}`,
    }
  }

  return { kind: 'reconnect', reason: `status_${statusCode ?? 'unknown'}` }
}
