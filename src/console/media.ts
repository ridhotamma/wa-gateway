/** MIME type detection for console uploads: file signature first, then the file extension. */

/** Largest console upload. The whole multipart body must stay under the app's 8 MB body limit. */
export const MAX_UPLOAD_BYTES = 7 * 1024 * 1024

const BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  '3gp': 'video/3gpp',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

/** Extension → MIME map, shared with the browser script so both sides agree. */
export const MIME_BY_EXTENSION: Readonly<Record<string, string>> = BY_EXTENSION

/** Guess a MIME type from a filename or URL path, e.g. `invoice.pdf` → `application/pdf`. */
export function mimeFromName(name: string | null | undefined): string | null {
  if (!name) return null
  let path = name
  try {
    path = new URL(name).pathname
  } catch {
    // Not a URL: treat it as a filename.
  }
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase()
  return ext ? (BY_EXTENSION[ext] ?? null) : null
}

const ascii = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.subarray(start, end))

/** Read the MIME type from a file's leading bytes, or null when the signature is unfamiliar. */
export function mimeFromBytes(bytes: Uint8Array): string | null {
  const b = bytes
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b[0] === 0x89 && ascii(b, 1, 4) === 'PNG') return 'image/png'
  if (ascii(b, 0, 4) === 'GIF8') return 'image/gif'
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'image/webp'
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WAVE') return 'audio/wav'
  if (ascii(b, 0, 5) === '%PDF-') return 'application/pdf'
  if (ascii(b, 0, 4) === 'OggS') return 'audio/ogg'
  if (ascii(b, 0, 3) === 'ID3' || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0)) {
    return 'audio/mpeg'
  }
  if (ascii(b, 4, 8) === 'ftyp') {
    const brand = ascii(b, 8, 12)
    if (brand === 'qt  ') return 'video/quicktime'
    if (brand.startsWith('M4A')) return 'audio/mp4'
    if (brand.startsWith('3gp')) return 'video/3gpp'
    return 'video/mp4'
  }
  return null
}

/**
 * Best MIME guess for an upload. Signatures beat names, except for ZIP-based
 * Office files, where only the extension tells a .docx from a .zip.
 */
export function detectMimetype(
  bytes: Uint8Array,
  filename?: string | null,
  browserType?: string | null,
): string | null {
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
  if (isZip) return mimeFromName(filename) ?? 'application/zip'
  return mimeFromBytes(bytes) ?? (browserType || null) ?? mimeFromName(filename)
}
