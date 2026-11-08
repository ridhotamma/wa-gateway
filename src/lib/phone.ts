/** Mask a recipient for logs and failure records: only the last 4 digits stay. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  return digits.length <= 4 ? '****' : `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`
}
