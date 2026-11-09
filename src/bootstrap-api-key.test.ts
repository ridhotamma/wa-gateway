import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { ensureBootstrapApiKey } from './bootstrap-api-key.js'
import { loadConfig } from './config.js'

let dir: string

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

function productionConfig(env: Record<string, string> = {}) {
  dir = mkdtempSync(path.join(tmpdir(), 'wa-bootstrap-'))
  return loadConfig(
    {
      NODE_ENV: 'production',
      WHATSAPP_DATABASE_PATH: path.join(dir, 'gateway.db'),
      ...env,
    },
    dir,
  )
}

describe('ensureBootstrapApiKey', () => {
  test('generates and persists a key beside the database', () => {
    const config = productionConfig()
    ensureBootstrapApiKey(config)

    expect(config.apiKey).toMatch(/^wa_[A-Za-z0-9_-]{40,}$/)
    expect(config.apiKeySource).toBe('generated')
    expect(config.apiKeyFile).toBe(path.join(dir, 'bootstrap-api-key'))
    expect(readFileSync(config.apiKeyFile!, 'utf8')).toBe(`${config.apiKey}\n`)
    expect(statSync(config.apiKeyFile!).mode & 0o777).toBe(0o600)
  })

  test('reuses the same key on the next boot', () => {
    const first = productionConfig()
    ensureBootstrapApiKey(first)

    const second = productionConfig({ WHATSAPP_DATABASE_PATH: first.databasePath })
    ensureBootstrapApiKey(second)

    expect(second.apiKey).toBe(first.apiKey)
  })

  test('regenerates an empty key file', () => {
    const config = productionConfig()
    const file = path.join(dir, 'bootstrap-api-key')
    writeFileSync(file, '\n', { mode: 0o600 })

    ensureBootstrapApiKey(config)

    expect(config.apiKey).toMatch(/^wa_/)
    expect(readFileSync(file, 'utf8')).toBe(`${config.apiKey}\n`)
  })

  test('keeps an explicitly configured environment key', () => {
    const config = productionConfig({ WHATSAPP_API_KEY: 'provided-secret' })
    ensureBootstrapApiKey(config)

    expect(config.apiKey).toBe('provided-secret')
    expect(config.apiKeySource).toBe('env')
    expect(config.apiKeyFile).toBeNull()
    expect(existsSync(path.join(dir, 'bootstrap-api-key'))).toBe(false)
  })

  test('leaves development without a key untouched', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'wa-bootstrap-'))
    const config = loadConfig({ WHATSAPP_DATABASE_PATH: path.join(dir, 'gateway.db') }, dir)
    ensureBootstrapApiKey(config)

    expect(config.apiKey).toBe('')
    expect(config.apiKeySource).toBe('none')
    expect(existsSync(path.join(dir, 'bootstrap-api-key'))).toBe(false)
  })
})
