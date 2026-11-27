import { describe, expect, test } from 'bun:test'
import { Application, Encrypter, hmac, parseKeys, safeEqual } from '../src'

const OLD = 'old-key-old-key-old-key-old-key-0'
const NEW = 'new-key-new-key-new-key-new-key-1'

describe('Encrypter', () => {
  test('encrypts with the current key; a rotation keeps old values readable and old signatures valid', () => {
    const before = new Encrypter(OLD)
    const stored = before.encrypt('IBAN FR76…')
    const signature = before.sign('magic:abc')
    expect(stored).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/)
    expect(before.decrypt(stored)).toBe('IBAN FR76…')

    const after = new Encrypter(NEW, [OLD])
    expect(after.decrypt(stored)).toBe('IBAN FR76…')
    expect(after.needsReencrypt(stored)).toBe(true)
    const fresh = after.encrypt(after.decrypt(stored))
    expect(after.needsReencrypt(fresh)).toBe(false)
    expect(after.verify('magic:abc', signature)).toBe(true)
    expect(after.sign('magic:abc')).not.toBe(signature) // new signatures use the new key

    const dropped = new Encrypter(NEW)
    expect(() => dropped.decrypt(stored)).toThrow(expect.objectContaining({ code: 'crypto.decrypt_failed' }))
    expect(dropped.verify('magic:abc', signature)).toBe(false)
  })

  test('the format is unchanged: values from before this service still decrypt (sha256(APP_KEY), AES-256-GCM)', () => {
    const { createCipheriv, createHash } = require('node:crypto')
    const iv = Buffer.alloc(12, 7)
    const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(OLD).digest(), iv)
    const data = Buffer.concat([cipher.update('legacy', 'utf8'), cipher.final()])
    const legacy = [
      'v1',
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      data.toString('base64url'),
    ]
    expect(new Encrypter(OLD).decrypt(legacy.join('.'))).toBe('legacy')
    expect(new Encrypter(OLD).sign('x')).toBe(hmac(OLD, 'x'))
  })

  test('tampering, garbage, and no key', () => {
    const e = new Encrypter(NEW)
    const stored = e.encrypt('secret')
    const parts = stored.split('.')
    parts[3] = `${parts[3]?.slice(0, -2)}AA`
    expect(() => e.decrypt(parts.join('.'))).toThrow(expect.objectContaining({ code: 'crypto.decrypt_failed' }))
    expect(() => e.decrypt('plain text')).toThrow('Not an encrypted value')
    expect(e.verify('x', '')).toBe(false)
    const none = new Encrypter(undefined, [OLD]) // previous keys alone are not trusted
    expect(none.configured).toBe(false)
    expect(() => none.encrypt('x')).toThrow(expect.objectContaining({ code: 'crypto.no_key' }))
    expect(none.verify('x', hmac(OLD, 'x'))).toBe(false)
  })

  test('helpers; the app binds one from app.key and app.previousKeys', async () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'abcd')).toBe(false)
    expect(parseKeys(' a, ,b ')).toEqual(['a', 'b'])
    expect(parseKeys(['a', ''])).toEqual(['a'])
    expect(Encrypter.random(16)).toMatch(/^[\w-]{22}$/)
    const app = new Application({ configs: { app: { key: NEW, previousKeys: `${OLD}` } } })
    await app.start()
    expect(app.resolve(Encrypter).decrypt(new Encrypter(OLD).encrypt('x'))).toBe('x')
    await app.shutdown()
  })
})
