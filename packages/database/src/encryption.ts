import { CslugError, Encrypter } from '@cslug/core'

let source: (() => Encrypter | undefined) | undefined

/**
 * The app's `Encrypter` (`APP_KEY`, and `APP_PREVIOUS_KEYS` for reading), or a function returning it on first use
 * (DatabaseProvider passes one at register, when it cannot be resolved yet).
 */
export function setEncrypter(value: Encrypter | (() => Encrypter) | undefined): void {
  source = typeof value === 'function' ? value : () => value
}

/** Set the key directly (scripts, tests): `setEncryptionKey(APP_KEY, [previous keys])`. */
export function setEncryptionKey(appKey: string | undefined, previous: readonly string[] = []): void {
  setEncrypter(appKey ? new Encrypter(appKey, previous) : undefined)
}

const requireEncrypter = (): Encrypter => {
  const encrypter = source?.()
  if (!encrypter?.configured)
    throw new CslugError(
      'db.no_encryption_key',
      'Encrypted columns need APP_KEY (config app.key). Run `cslug key:generate`.',
    )
  return encrypter
}

/** AES-256-GCM with a random IV and the current key: `v1.<iv>.<tag>.<ciphertext>` (base64url). */
export function encrypt(plain: string): string {
  return requireEncrypter().encrypt(plain)
}

/** Reverse of `encrypt()` (current or previous key); throws `db.decrypt_failed` on a tampered value or an unknown key. */
export function decrypt(stored: string): string {
  const e = requireEncrypter()
  try {
    return e.decrypt(stored)
  } catch (error) {
    throw new CslugError(
      'db.decrypt_failed',
      (error as Error).message.startsWith('Not an')
        ? 'Not an encrypted value'
        : 'Could not decrypt a value (wrong APP_KEY, or the value was altered)',
      { cause: error },
    )
  }
}

/** Whether a stored value was encrypted with a previous key (`cslug key:rotate` re-encrypts those). */
export function needsReencrypt(stored: string): boolean {
  return requireEncrypter().needsReencrypt(stored)
}
