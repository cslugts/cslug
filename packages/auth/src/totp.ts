import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** RFC 4648 Base32 (no padding), as authenticator apps expect secrets. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(text: string): Uint8Array {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '')
  const out: number[] = []
  let bits = 0
  let value = 0
  for (const char of clean) {
    const index = ALPHABET.indexOf(char)
    if (index < 0) throw new Error(`Not a Base32 secret (character "${char}")`)
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Uint8Array.from(out)
}

/** A new TOTP secret: 20 random bytes (160 bits, as RFC 4226 recommends), Base32. */
export const totpSecret = () => base32Encode(randomBytes(20))

/** The HOTP value of `counter` (RFC 4226): HMAC-SHA1, dynamic truncation, `digits` digits. */
export function hotp(secret: string, counter: number, digits = 6): string {
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(BigInt(counter))
  const mac = createHmac('sha1', base32Decode(secret)).update(message).digest()
  const offset = (mac[mac.length - 1] as number) & 15
  const binary = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits
  return String(binary).padStart(digits, '0')
}

export type TotpOptions = { period?: number; digits?: number; window?: number }

/** The time step of an instant: `floor(unix seconds / period)`. */
export const totpCounter = (at: Date, period = 30) => Math.floor(at.getTime() / 1000 / period)

/** The current code (RFC 6238). */
export const totpCode = (secret: string, at: Date, options: TotpOptions = {}) =>
  hotp(secret, totpCounter(at, options.period), options.digits)

/**
 * The time step `code` belongs to, within `window` steps of `at` (default 1: ±30 s of clock drift), or null.
 * Compared in constant time; spaces in the code are ignored.
 */
export function verifyTotp(secret: string, code: string, at: Date, options: TotpOptions = {}): number | null {
  const { period = 30, digits = 6, window = 1 } = options
  const given = Buffer.from(code.replace(/\s/g, ''))
  if (given.length !== digits) return null
  const now = totpCounter(at, period)
  let found: number | null = null
  for (let step = now - window; step <= now + window; step++) {
    const expected = Buffer.from(hotp(secret, step, digits))
    if (timingSafeEqual(expected, given) && found === null) found = step
  }
  return found
}

/**
 * The `otpauth://` URI authenticator apps import (usually shown as a QR code):
 * `otpauth://totp/Issuer:account?secret=…&issuer=Issuer&algorithm=SHA1&digits=6&period=30`.
 */
export function otpauthUri(secret: string, account: string, issuer: string, options: TotpOptions = {}): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`
  const query = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(options.digits ?? 6),
    period: String(options.period ?? 30),
  })
  return `otpauth://totp/${label}?${query}`
}
