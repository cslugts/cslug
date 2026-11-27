import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { CslugError } from './errors'

/** Compare two secrets in constant time (for their length): tokens, signatures, hashes. */
export function safeEqual(a: string | Uint8Array, b: string | Uint8Array): boolean {
  const x = typeof a === 'string' ? Buffer.from(a) : a
  const y = typeof b === 'string' ? Buffer.from(b) : b
  return x.length === y.length && timingSafeEqual(x, y)
}

/** HMAC-SHA256 of `data` with `key`, base64url. */
export function hmac(key: string, data: string): string {
  return createHmac('sha256', key).update(data).digest('base64url')
}

/** `APP_PREVIOUS_KEYS` (comma-separated) or a list, cleaned. */
export function parseKeys(value: string | readonly string[] | undefined): string[] {
  const list = typeof value === 'string' ? value.split(',') : (value ?? [])
  return list.map((k) => k.trim()).filter(Boolean)
}

/**
 * Encryption and signatures with the app key, and key rotation. New values use `APP_KEY`; values made with a key
 * listed in `APP_PREVIOUS_KEYS` still decrypt and verify, so the key can change without logging everyone out or
 * losing encrypted columns (`cslug key:rotate` explains the steps). Used by encrypted columns, signed URLs, magic
 * links and two-factor secrets.
 */
export class Encrypter {
  private readonly keys: string[]
  private readonly aesKeys: Buffer[]

  constructor(current: string | undefined, previous: readonly string[] = []) {
    this.keys = [current, ...previous].filter((k): k is string => !!k)
    if (!current) this.keys = [] // no current key: nothing new can be made, nothing is trusted
    this.aesKeys = this.keys.map((k) => createHash('sha256').update(k).digest())
  }

  /** True when `APP_KEY` is set. */
  get configured(): boolean {
    return this.keys.length > 0
  }

  private require(): void {
    if (!this.configured)
      throw new CslugError('crypto.no_key', 'APP_KEY is not set (config app.key). Run `cslug key:generate`.')
  }

  /** AES-256-GCM with a random IV: `v1.<iv>.<tag>.<ciphertext>` (base64url), with the current key. */
  encrypt(plain: string): string {
    this.require()
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.aesKeys[0] as Buffer, iv)
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join(
      '.',
    )
  }

  /** Reverse of `encrypt()`, with the current key or a previous one; `crypto.decrypt_failed` otherwise. */
  decrypt(stored: string): string {
    return this.open(stored).plain
  }

  /** Whether a value was encrypted with a previous key (re-encrypt it with `encrypt(decrypt(value))`). */
  needsReencrypt(stored: string): boolean {
    return this.open(stored).keyIndex > 0
  }

  private open(stored: string): { plain: string; keyIndex: number } {
    this.require()
    const [version, iv, tag, data] = stored.split('.')
    if (version !== 'v1' || !iv || !tag || data === undefined)
      throw new CslugError('crypto.decrypt_failed', 'Not an encrypted value')
    for (const [keyIndex, key] of this.aesKeys.entries()) {
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
        decipher.setAuthTag(Buffer.from(tag, 'base64url'))
        const plain = Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString(
          'utf8',
        )
        return { plain, keyIndex }
      } catch {}
    }
    throw new CslugError(
      'crypto.decrypt_failed',
      'Could not decrypt a value (a key that is neither APP_KEY nor in APP_PREVIOUS_KEYS, or the value was altered)',
    )
  }

  /** HMAC-SHA256 (base64url) of `data` with the current key. Prefix `data` with a purpose (`magic:`, a URL). */
  sign(data: string): string {
    this.require()
    return hmac(this.keys[0] as string, data)
  }

  /** Whether `signature` is `sign(data)` with the current key or a previous one (constant time). */
  verify(data: string, signature: string): boolean {
    if (!this.configured || !signature) return false
    let ok = false
    for (const key of this.keys) ok = safeEqual(hmac(key, data), signature) || ok
    return ok
  }

  /** Random bytes, base64url (tokens, secrets). */
  static random(bytes = 32): string {
    return randomBytes(bytes).toString('base64url')
  }
}
