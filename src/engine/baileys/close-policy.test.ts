import { describe, expect, test } from 'vitest'
import { DisconnectReason } from 'baileys'

import { closeAction } from './close-policy.js'

describe('closeAction', () => {
  describe('an unpaired socket (QR shown, never scanned)', () => {
    test('Baileys running out of QR codes ends the pairing, it does not reconnect', () => {
      // "QR refs attempts ended": the close that used to start the loop.
      expect(closeAction(DisconnectReason.timedOut, false)).toEqual({
        kind: 'pairing_ended',
        reason: 'qr_timeout',
      })
    })

    test('any other drop ends the pairing too', () => {
      for (const code of [
        DisconnectReason.connectionClosed,
        DisconnectReason.connectionLost,
        undefined,
      ]) {
        expect(closeAction(code, false).kind).toBe('pairing_ended')
      }
      // `connectionLost` shares 408 with `timedOut`, so it reads as
      // `qr_timeout`; either way the seller has to connect again.
      expect(closeAction(DisconnectReason.connectionClosed, false)).toEqual({
        kind: 'pairing_ended',
        reason: `pairing_interrupted_${DisconnectReason.connectionClosed}`,
      })
    })

    test('the restart WhatsApp asks for right after a scan is still followed', () => {
      expect(closeAction(DisconnectReason.restartRequired, false)).toEqual({ kind: 'restart' })
    })
  })

  describe('a paired socket', () => {
    test('a dropped connection reconnects', () => {
      for (const code of [
        DisconnectReason.timedOut,
        DisconnectReason.connectionClosed,
        DisconnectReason.connectionLost,
        undefined,
      ]) {
        expect(closeAction(code, true).kind).toBe('reconnect')
      }
    })

    test('the post-scan restart reconnects at once', () => {
      expect(closeAction(DisconnectReason.restartRequired, true)).toEqual({ kind: 'restart' })
    })
  })

  describe('terminal closes stop whether paired or not', () => {
    for (const paired of [true, false]) {
      test(`paired: ${paired}`, () => {
        expect(closeAction(DisconnectReason.loggedOut, paired)).toEqual({
          kind: 'terminal',
          reason: 'logged_out',
          clearCreds: true,
          status: 'disconnected',
        })
        expect(closeAction(DisconnectReason.connectionReplaced, paired)).toMatchObject({
          kind: 'terminal',
          clearCreds: false,
          status: 'failed',
        })
        expect(closeAction(DisconnectReason.badSession, paired)).toMatchObject({
          kind: 'terminal',
          clearCreds: true,
        })
      })
    }
  })
})
