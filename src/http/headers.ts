/** RFC 5987 filename; clip and encode so a filename cannot inject a header. */
export function attachmentDisposition(filename: string): string {
  const clean =
    filename
      .replace(/[\r\n]+/g, ' ')
      .trim()
      .slice(0, 200) || 'attachment'
  return `attachment; filename*=UTF-8''${encodeURIComponent(clean).replace(/'/g, '%27')}`
}

/** Only a plausible MIME type reaches a response header. */
export function safeContentType(value: string | undefined): string {
  return value && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(value)
    ? value
    : 'application/octet-stream'
}
