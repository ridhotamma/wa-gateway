import pino, { type Logger } from 'pino'

export type { Logger }

/** Used by services in tests and scripts that do not configure logging. */
export const silentLogger: Logger = pino({ level: 'silent' })

export function createLogger(level: string): Logger {
  return pino({
    level,
    base: { service: 'wa-gateway' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ['req.headers.authorization', 'req.headers["x-api-key"]'],
      censor: '[redacted]',
    },
  })
}
