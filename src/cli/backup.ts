import { mkdirSync } from 'node:fs'
import path from 'node:path'

import { loadConfig, loadEnvFiles } from '../config.js'
import { openDatabase } from '../db/database.js'

/**
 * Create a consistent copy of the SQLite database with better-sqlite3's
 * online backup API. Designed to run inside the gateway container:
 *
 *   node dist/cli/backup.js /data/backups/gateway.db
 */
async function main(): Promise<void> {
  loadEnvFiles()
  const config = loadConfig()
  const destination = process.argv[2]
  if (!destination) {
    console.error('Usage: node dist/cli/backup.js <destination.db>')
    process.exit(1)
  }

  mkdirSync(path.dirname(destination), { recursive: true })
  const db = openDatabase(config.databasePath)
  try {
    await db.backup(destination)
    console.info(`[backup] wrote ${destination}`)
  } finally {
    db.close()
  }
}

main().catch((error: unknown) => {
  console.error('[backup] failed:', error)
  process.exit(1)
})
