import { loadConfig, loadEnvFiles } from '../config.js'
import { openDatabase } from '../db/database.js'
import { AuditLog } from '../services/audit-log.js'
import { ConsoleAuthStore } from '../services/console-auth.js'

/**
 * Create or reset a console admin. Useful when the only admin is locked out:
 *
 *   node dist/cli/console-admin.js admin@example.com a-long-password
 */
function main(): void {
  loadEnvFiles()
  const config = loadConfig()
  const email = process.argv[2]
  const password = process.argv[3]
  if (!email || !password) {
    console.error('Usage: node dist/cli/console-admin.js <email> <password>')
    process.exit(1)
  }

  const db = openDatabase(config.databasePath)
  try {
    const auth = new ConsoleAuthStore(db, config.console.sessionTtlMs)
    const existing = auth.findAdminByEmail(email)
    const admin = existing ? auth.resetPassword(email, password) : auth.createAdmin(email, password)
    if (admin) {
      new AuditLog(db).record(
        'cli',
        existing ? 'console.admin.password-reset' : 'console.admin.created',
        admin.email,
      )
    }
    console.info(
      `[console-admin] ${existing ? 'password reset' : 'admin created'} for ${admin?.email}`,
    )
  } finally {
    db.close()
  }
}

try {
  main()
} catch (error) {
  console.error('[console-admin] failed:', error)
  process.exit(1)
}
