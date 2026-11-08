import { describe, expect, test } from 'vitest'
import type { PresenceState, WhatsAppEngine } from '../engine/index.js'
import {
  DEFAULT_TYPING_TIMING,
  simulateTyping,
  typingDurationMs,
  type TypingTiming,
} from './typing.js'

const timing = (overrides: Partial<TypingTiming> = {}): TypingTiming => ({
  minMs: 1_000,
  maxMs: 5_000,
  msPerChar: 10,
  jitterRatio: 0,
  ...overrides,
})

describe('typingDurationMs', () => {
  test('uses the floor for a short or empty reply', () => {
    expect(typingDurationMs('', timing(), () => 0.5)).toBe(1_000)
    expect(typingDurationMs('ok', timing(), () => 0.5)).toBe(1_020)
  })

  test('scales with the reply and stops at the ceiling', () => {
    expect(typingDurationMs('x'.repeat(100), timing(), () => 0.5)).toBe(2_000)
    expect(typingDurationMs('x'.repeat(10_000), timing(), () => 0.5)).toBe(5_000)
  })

  test('jitter stays inside the configured window', () => {
    const jittery = timing({ jitterRatio: 0.5 })
    expect(typingDurationMs('x'.repeat(100), jittery, () => 0)).toBe(1_000)
    expect(typingDurationMs('x'.repeat(100), jittery, () => 0.5)).toBe(2_000)
    expect(typingDurationMs('x'.repeat(100), jittery, () => 1)).toBe(3_000)
    expect(typingDurationMs('x'.repeat(100), timing({ jitterRatio: 5 }), () => 1)).toBe(4_000)
  })

  test('a nonsensical env value cannot produce a negative or inverted delay', () => {
    expect(typingDurationMs('x', timing({ minMs: -1, maxMs: -5 }), () => 0.5)).toBe(0)
    expect(typingDurationMs('x', timing({ minMs: 2_000, maxMs: 1_000 }), () => 0.5)).toBe(2_000)
  })

  test('defaults leave a reply visible as typing for a beat, not a minute', () => {
    expect(
      typingDurationMs('Halo kak, stoknya masih ada.', DEFAULT_TYPING_TIMING, () => 0.5),
    ).toBeGreaterThanOrEqual(DEFAULT_TYPING_TIMING.minMs)
    expect(
      typingDurationMs('x'.repeat(5_000), DEFAULT_TYPING_TIMING, () => 0.5),
    ).toBeLessThanOrEqual(DEFAULT_TYPING_TIMING.maxMs)
  })
})

describe('simulateTyping', () => {
  test('composes, waits, then pauses before the message is sent', async () => {
    const states: PresenceState[] = []
    const waits: number[] = []
    const engine = {
      sendPresenceUpdate: async (_to: string, state: PresenceState) => {
        states.push(state)
      },
    } as Pick<WhatsAppEngine, 'sendPresenceUpdate'>

    await simulateTyping(engine, '628123456789', 'Halo', timing(), {
      sleep: async (ms) => {
        waits.push(ms)
      },
      random: () => 0.5,
    })

    expect(states).toEqual(['composing', 'paused'])
    expect(waits).toEqual([1_040])
  })

  test('a presence failure never blocks the reply', async () => {
    const errors: unknown[] = []
    let waits = 0
    const engine = {
      sendPresenceUpdate: async () => {
        throw new Error('not on WhatsApp')
      },
    } as Pick<WhatsAppEngine, 'sendPresenceUpdate'>

    await simulateTyping(engine, '628123456789', 'Halo', timing(), {
      sleep: async () => {
        waits += 1
      },
      onError: (error) => {
        errors.push(error)
      },
    })

    expect(waits).toBe(0)
    expect(errors).toHaveLength(1)
  })

  test('a failed pause is reported but the delay already happened', async () => {
    const errors: unknown[] = []
    const states: PresenceState[] = []
    const engine = {
      sendPresenceUpdate: async (_to: string, state: PresenceState) => {
        states.push(state)
        if (state === 'paused') throw new Error('socket closed')
      },
    } as Pick<WhatsAppEngine, 'sendPresenceUpdate'>

    await simulateTyping(engine, '628123456789', 'Halo', timing(), {
      sleep: async () => {},
      onError: (error) => {
        errors.push(error)
      },
    })

    expect(states).toEqual(['composing', 'paused'])
    expect(errors).toHaveLength(1)
  })
})
