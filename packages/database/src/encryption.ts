import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { CslugError } from '@cslug/core'

let key: Buffer | undefined

/** Set the encryption key from `APP_KEY` (DatabaseProvider does this at register). */
export function setEncryptionKey(appKey: string | undefined): void {
  key = appKey ? createHash('sha256').update(appKey).digest() : undefined
}

const requireKey = (): Buffer => {
  if (!key)
    throw new CslugError(
      'db.no_encryption_key',
      'Encrypted columns need APP_KEY (config app.key). Run `cslug key:generate`.',
    )
  return key
}

/** AES-256-GCM with a random IV: `v1.<iv>.<tag>.<ciphertext>` (base64url). */
export function encrypt(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', requireKey(), iv)
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join(
    '.',
  )
}

export function decrypt(stored: string): string {
  const [version, iv, tag, data] = stored.split('.')
  if (version !== 'v1' || !iv || !tag || data === undefined)
    throw new CslugError('db.decrypt_failed', 'Not an encrypted value')
  try {
    const decipher = createDecipheriv('aes-256-gcm', requireKey(), Buffer.from(iv, 'base64url'))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8')
  } catch (error) {
    throw new CslugError('db.decrypt_failed', 'Could not decrypt a value (wrong APP_KEY, or the value was altered)', {
      cause: error,
    })
  }
}
