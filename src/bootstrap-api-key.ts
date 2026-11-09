import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import type { Config } from './config.js'
import type { Logger } from './lib/logger.js'

/**
 * A production gateway must not expose its API without authentication. When
 * `WHATSAPP_API_KEY` is omitted (the common Docker quick start), generate a
 * strong key on first boot, keep it beside the SQLite database, and reuse it
 * on every restart. The console shows the value to the signed-in admin, so
 * the operator never has to copy secrets out of the container by hand.
 */
export function ensureBootstrapApiKey(config: Config, logger?: Logger): void {
  if (config.apiKey) return
  if (!config.isProduction) return

  const filePath = path.join(path.dirname(config.databasePath), 'bootstrap-api-key')
  let key: string
  try {
    mkdirSync(path.dirname(filePath), { recursive: true })
    key = existsSync(filePath) ? readFileSync(filePath, 'utf8').trim() : ''
    if (!key) {
      key = `wa_${randomBytes(32).toString('base64url')}`
      writeFileSync(filePath, `${key}\n`, { mode: 0o600 })
    }
    // Also repair the mode when an older or copied file was too permissive.
    chmodSync(filePath, 0o600)
  } catch (error) {
    throw new Error(
      `Could not create the bootstrap API key at ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }

  config.apiKey = key
  config.apiKeySource = 'generated'
  config.apiKeyFile = filePath
  logger?.info({ file: filePath }, 'bootstrap API key ready (copy it from the console)')
}
