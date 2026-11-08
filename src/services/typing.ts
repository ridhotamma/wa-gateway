import type { WhatsAppEngine } from '../engine/index.js'

/**
 * Human-looking "typing…" for chatbot replies.
 *
 * A reply is generated long before the outbox can send it: the model thinks,
 * then the queue waits for the session's pacing gap. Showing the indicator at
 * enqueue time would therefore either expire or loop for minutes. The queue
 * instead marks a reply as `typing`, and the session manager displays it right
 * before the actual send — the same order a person reading and answering a
 * message would produce.
 */
export interface TypingTiming {
  /** Shortest display, even for a one-word answer. */
  minMs: number
  /** Longest display: beyond this the customer assumes the bot is stuck. */
  maxMs: number
  /** Average keystroke time, used to scale the delay with the reply length. */
  msPerChar: number
  /** ± share applied to the duration so replies don't look robotic. */
  jitterRatio: number
}

export const DEFAULT_TYPING_TIMING: TypingTiming = {
  minMs: 1_200,
  maxMs: 8_000,
  msPerChar: 35,
  jitterRatio: 0.2,
}

/**
 * How long to keep the indicator up for a reply. The result is always inside
 * `[minMs, maxMs]`; a bad env value cannot produce a negative timer.
 */
export function typingDurationMs(
  text: string,
  timing: TypingTiming = DEFAULT_TYPING_TIMING,
  random: () => number = Math.random,
): number {
  const min = Math.max(0, timing.minMs)
  const max = Math.max(min, timing.maxMs)
  const base = Math.min(max, Math.max(min, min + text.trim().length * timing.msPerChar))
  const jitterRatio = Math.min(1, Math.max(0, timing.jitterRatio))
  const jitter = 1 + (random() * 2 - 1) * jitterRatio
  return Math.round(Math.min(max, Math.max(min, base * jitter)))
}

export interface TypingSimulationOptions {
  /** Injected by tests; production uses a plain timer. */
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  /** Presence is cosmetic: a failure must never stop the message itself. */
  onError?: (error: unknown) => void
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Show "typing…", wait like a person would, then clear it. Presence failures
 * are reported and swallowed; the caller still sends the reply immediately.
 */
export async function simulateTyping(
  engine: Pick<WhatsAppEngine, 'sendPresenceUpdate'>,
  to: string,
  text: string,
  timing: TypingTiming = DEFAULT_TYPING_TIMING,
  options: TypingSimulationOptions = {},
): Promise<void> {
  const report = options.onError ?? (() => {})

  try {
    await engine.sendPresenceUpdate(to, 'composing')
  } catch (error) {
    // An invalid/unreachable recipient is handled by the send that follows,
    // with the proper PermanentSendError. Waiting here would only add delay.
    report(error)
    return
  }

  await (options.sleep ?? wait)(typingDurationMs(text, timing, options.random))

  try {
    await engine.sendPresenceUpdate(to, 'paused')
  } catch (error) {
    report(error)
  }
}
