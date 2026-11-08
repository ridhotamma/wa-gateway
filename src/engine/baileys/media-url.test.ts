import { describe, expect, test } from 'vitest'

import { UnsafeMediaUrlError } from '../errors.js'
import { assertSafeMediaUrl } from './media-url.js'

describe('outbound media URL guard', () => {
  test('rejects non-HTTP and private targets', async () => {
    for (const url of [
      'file:///etc/passwd',
      'http://localhost/photo.jpg',
      'http://app.local/photo.jpg',
      'http://127.0.0.1/photo.jpg',
      'http://10.1.2.3/photo.jpg',
      'http://192.168.1.2/photo.jpg',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/photo.jpg',
    ]) {
      await expect(assertSafeMediaUrl(url)).rejects.toBeInstanceOf(UnsafeMediaUrlError)
    }
  })

  test('keeps a normal public URL unchanged', async () => {
    const url = 'https://8.8.8.8/private/team_x/chat/file.webp'
    await expect(assertSafeMediaUrl(url)).resolves.toBe(url)
  })
})
