import type { Logger } from '../lib/logger.js'

export interface AppEnv {
  Variables: {
    logger: Logger
    requestId: string
  }
}
