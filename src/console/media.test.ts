import { describe, expect, test } from 'vitest'

import { detectMimetype, mimeFromName } from './media.js'

const bytes = (...values: Array<number | string>) =>
  new Uint8Array(
    values.flatMap((value) =>
      typeof value === 'string' ? [...value].map((ch) => ch.charCodeAt(0)) : [value],
    ),
  )

describe('MIME detection', () => {
  test('reads common file signatures', () => {
    expect(detectMimetype(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg')
    expect(detectMimetype(bytes(0x89, 'PNG'))).toBe('image/png')
    expect(detectMimetype(bytes('RIFF', 0, 0, 0, 0, 'WEBP'))).toBe('image/webp')
    expect(detectMimetype(bytes('%PDF-1.7'))).toBe('application/pdf')
    expect(detectMimetype(bytes('OggS'))).toBe('audio/ogg')
    expect(detectMimetype(bytes(0, 0, 0, 0x18, 'ftypisom'))).toBe('video/mp4')
  })

  test('trusts the signature over a wrong name', () => {
    expect(detectMimetype(bytes(0x89, 'PNG'), 'photo.jpg', 'image/jpeg')).toBe('image/png')
  })

  test('uses the extension to tell Office files from plain ZIPs', () => {
    const zip = bytes(0x50, 0x4b, 0x03, 0x04)
    expect(detectMimetype(zip, 'report.xlsx')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
    expect(detectMimetype(zip, 'archive.bin')).toBe('application/zip')
  })

  test('falls back to the browser type, then the name', () => {
    expect(detectMimetype(bytes('hello'), 'notes.txt', 'text/markdown')).toBe('text/markdown')
    expect(detectMimetype(bytes('hello'), 'notes.csv')).toBe('text/csv')
    expect(detectMimetype(bytes('hello'), 'notes')).toBeNull()
  })

  test('guesses from URLs and ignores query strings', () => {
    expect(mimeFromName('https://cdn.example.com/a/invoice.PDF?sig=1')).toBe('application/pdf')
    expect(mimeFromName('https://cdn.example.com/download')).toBeNull()
  })
})
