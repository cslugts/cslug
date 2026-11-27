import { afterAll, describe, expect, test } from 'bun:test'
import { Clock, FakeClock, resolve } from '@cslug/core'
import { Database, sql } from '@cslug/database'
import { testApp } from '@cslug/testing'
import { base32Decode, base32Encode, hotp, otpauthUri, totpCode, totpSecret, verifyTotp } from '../src'
import { fixtureApp, Hash, TwoFactor, UserRepository } from './fixture/app'

// RFC 4226 appendix D and RFC 6238 appendix B (SHA-1): the secret is the ASCII "12345678901234567890"
const RFC_SECRET = base32Encode(new TextEncoder().encode('12345678901234567890'))

describe('TOTP (RFC 6238)', () => {
  test('HOTP test vectors (RFC 4226)', () => {
    expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
    expect(Array.from({ length: 10 }, (_, i) => hotp(RFC_SECRET, i))).toEqual([
      '755224',
      '287082',
      '359152',
      '969429',
      '338314',
      '254676',
      '287922',
      '162583',
      '399871',
      '520489',
    ])
  })

  test('TOTP test vectors (RFC 6238, 8 digits)', () => {
    const at = (seconds: number) => new Date(seconds * 1000)
    expect(
      [59, 1111111109, 1111111111, 1234567890, 2000000000, 20000000000].map((s) =>
        totpCode(RFC_SECRET, at(s), { digits: 8 }),
      ),
    ).toEqual(['94287082', '07081804', '14050471', '89005924', '69279037', '65353130'])
  })

  test('verify: ±1 step by default, spaces ignored, wrong length or code is null; Base32 round-trips', () => {
    const secret = totpSecret()
    expect(secret).toMatch(/^[A-Z2-7]{32}$/)
    expect(base32Encode(base32Decode(secret))).toBe(secret)
    const now = new Date('2026-11-27T10:00:15Z')
    const step = Math.floor(now.getTime() / 30000)
    const code = (s: number) => hotp(secret, s)
    expect(verifyTotp(secret, code(step), now)).toBe(step)
    expect(verifyTotp(secret, `${code(step).slice(0, 3)} ${code(step).slice(3)}`, now)).toBe(step)
    expect(verifyTotp(secret, code(step - 1), now)).toBe(step - 1)
    expect(verifyTotp(secret, code(step + 1), now)).toBe(step + 1)
    expect(verifyTotp(secret, code(step - 2), now)).toBeNull()
    expect(verifyTotp(secret, code(step - 2), now, { window: 2 })).toBe(step - 2)
    expect(verifyTotp(secret, '12345', now)).toBeNull()
    expect(() => base32Decode('not base32!')).toThrow('Not a Base32 secret')
  })

  test('otpauth URI for authenticator apps', () => {
    expect(otpauthUri('JBSWY3DPEHPK3PXP', 'ada@example.test', 'Albastr')).toBe(
      'otpauth://totp/Albastr:ada%40example.test?secret=JBSWY3DPEHPK3PXP&issuer=Albastr&algorithm=SHA1&digits=6&period=30',
    )
  })
})

describe.skipIf(!process.env.DATABASE_URL)('two-factor logins (guide 15)', () => {
  let drop = async () => {}
  const t = testApp({
    async create() {
      const f = await fixtureApp()
      drop = f.drop
      return f.app
    },
  })
  afterAll(async () => {
    await drop()
  })
  const clock = new FakeClock('UTC', '2026-11-27T10:00:05Z')
  const signUp = async () => {
    t.app.swap(Clock, clock)
    return resolve(UserRepository).create({
      email: 'staff@example.test',
      name: 'Staff',
      role: 'staff',
      passwordHash: await resolve(Hash).make('correct horse'),
    })
  }
  const login = () => t.post('/login').form({ email: 'staff@example.test', password: 'correct horse' })

  test('enrol: a secret to scan, confirmed by a first code, recovery codes; the secret is stored encrypted', async () => {
    const user = await signUp()
    await login().assertRedirect('/dashboard') // no 2FA yet: signed in at once
    const res = await t.post('/settings/two-factor').form({}).assertOk()
    const { secret, uri } = (await res.json()) as { secret: string; uri: string }
    expect(uri).toContain(`secret=${secret}`)
    expect(uri).toStartWith('otpauth://totp/')
    await t.post('/settings/two-factor/confirm').form({ code: '000000' }).assertStatus(422)
    const confirmed = await t
      .post('/settings/two-factor/confirm')
      .form({ code: totpCode(secret, clock.now()) })
      .assertOk()
    const { recoveryCodes } = (await confirmed.json()) as { recoveryCodes: string[] }
    expect(recoveryCodes).toHaveLength(8)
    expect(recoveryCodes[0]).toMatch(/^[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}$/)
    expect(await resolve(TwoFactor).enabled(user)).toBe(true)
    const stored = await resolve(Database).value<string>(sql`select secret from cslug_two_factor`)
    expect(stored).not.toContain(secret)
    expect(resolve(TwoFactor).enable(user, 'x')).rejects.toThrow('already on')
  })

  test('login: the password alone is not enough; a code finishes it; a code or recovery code works once', async () => {
    const user = await signUp()
    const { secret } = await resolve(TwoFactor).enable(user, user.email)
    const codes = (await resolve(TwoFactor).confirm(user, totpCode(secret, clock.now()))) as string[]

    await login().assertRedirect('/two-factor')
    await t.get('/dashboard').assertRedirect('/login') // not signed in yet
    await t.post('/two-factor').form({ code: '123456' }).assertStatus(422)
    // the code that confirmed enrolment was already used in this time step
    await t
      .post('/two-factor')
      .form({ code: totpCode(secret, clock.now()) })
      .assertStatus(422)
    clock.advance('30s')
    const code = totpCode(secret, clock.now())
    await t.post('/two-factor').form({ code }).assertRedirect('/dashboard')
    await t.get('/dashboard').assertOk()

    await t.post('/logout').form({})
    await login().assertRedirect('/two-factor')
    await t.post('/two-factor').form({ code }).assertStatus(422) // replayed
    await t
      .post('/two-factor')
      .form({ code: (codes[0] as string).toUpperCase() })
      .assertRedirect('/dashboard')
    expect(await resolve(TwoFactor).remainingRecoveryCodes(user)).toBe(7)
    await t.post('/logout').form({})
    await login().assertRedirect('/two-factor')
    await t
      .post('/two-factor')
      .form({ code: codes[0] as string })
      .assertStatus(422) // used up
  })

  test('a waiting login expires; failed codes are throttled; without a waiting login nothing happens', async () => {
    const user = await signUp()
    const { secret } = await resolve(TwoFactor).enable(user, user.email)
    await resolve(TwoFactor).confirm(user, totpCode(secret, clock.now()))
    await t.post('/two-factor').form({ code: '123456' }).assertStatus(422) // nothing pending

    await login().assertRedirect('/two-factor')
    clock.advance('11m')
    await t
      .post('/two-factor')
      .form({ code: totpCode(secret, clock.now()) })
      .assertStatus(422) // expired

    await login().assertRedirect('/two-factor')
    // the same limit as password attempts (config auth.throttle: 3/min in this app)
    const limit = Number(String(t.app.config('auth.throttle')).split('/')[0])
    for (let i = 0; i < limit; i++) await t.post('/two-factor').form({ code: '000000' }).assertStatus(422)
    await t
      .post('/two-factor')
      .form({ code: totpCode(secret, clock.now()) })
      .assertStatus(429)
  })

  test('disable, and new recovery codes', async () => {
    const user = await signUp()
    const { secret } = await resolve(TwoFactor).enable(user, user.email)
    const first = (await resolve(TwoFactor).confirm(user, totpCode(secret, clock.now()))) as string[]
    const second = (await resolve(TwoFactor).regenerateRecoveryCodes(user)) as string[]
    expect(second).not.toEqual(first)
    expect(await resolve(TwoFactor).verify(user, first[0] as string)).toBe(false)
    expect(await resolve(TwoFactor).verify(user, second[0] as string)).toBe(true)
    await resolve(TwoFactor).disable(user)
    expect(await resolve(TwoFactor).enabled(user)).toBe(false)
    await login().assertRedirect('/dashboard')
  })
})
