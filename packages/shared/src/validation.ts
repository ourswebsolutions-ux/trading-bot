/** Limits enforced on both sides; the server re-validates everything. */
export const SCREENSHOT_MAX_BYTES = 5 * 1024 * 1024
export const SCREENSHOT_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
export type ScreenshotMime = (typeof SCREENSHOT_MIME_TYPES)[number]

/** Transaction references: 6–64 chars, letters, digits and - _ . / # */
export const TRANSACTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9\-_./#]{4,62}[A-Za-z0-9]$/

export function normalizeTransactionId(raw: string): string {
  return raw.trim().replace(/\s+/g, '').toUpperCase()
}

export function isValidTransactionId(raw: string): boolean {
  return TRANSACTION_ID_PATTERN.test(normalizeTransactionId(raw))
}

const EMAIL_PATTERN = /^[^\s@<>()[\]\\,;:"]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/
export function isValidEmail(raw: string): boolean {
  return raw.length <= 254 && EMAIL_PATTERN.test(raw)
}

/** Detects the real image type from magic bytes; never trust file extensions. */
export function sniffImageMime(bytes: Uint8Array): ScreenshotMime | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  return null
}
