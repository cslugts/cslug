import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { resolve } from '@cslug/core'
import { testApp } from '@cslug/testing'
import { v } from '@cslug/validation'
import { AccountLocked, Audit, AuditPruneCommand, BreachedPasswords, Lockout, notBreached } from '../src'
import { fixtureApp, makeUser } from './fixture/app'

const hasDb = !!process.env.DATABASE_URL

describe('notBreached() (guide 24)', () => {
  test('only the first 5 characters of the SHA-1 are sent; the padded answer is searched for the rest', async () => {
    const restore = BreachedPasswords.fake(['password123'])
    try {
      const schema = v.string().refineAsync(notBreached(), { message: 'validation.password_breached' })
      expect(await schema.parseAsync('a long and unusual passphrase')).toBe('a long and unusual passphrase')
      await expect(schema.parseAsync('password123')).rejects.toThrow()
      expect(await BreachedPasswords.count('password123')).toBe(1)
      expect(await notBreached({ threshold: 2 })('password123')).toBe(true)
    } finally {
      restore()
    }
  })

  test('fails open: the API down means the password is accepted', async () => {
    const restore = BreachedPasswords.fake(['password123'], { unavailable: true })
    const warn = spyOn(console, 'warn').mockImplementation(() => {}) // keep the output clean
    try {
      expect(await BreachedPasswords.count('password123')).toBeUndefined()
      expect(await notBreached()('password123')).toBe(true)
      // the warning goes to the current app's Logger, or to the console without one (it depends on test order)
    } finally {
      warn.mockRestore()
      restore()
    }
  })

  test('the real range request: 5 hex characters, padding asked for', async () => {
    const calls: { url: string; headers: Headers }[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) })
      // SHA-1("password") = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8
      return new Response('1E4C9B93F3F0682250B6CF8331B7EE68FD8:10434004\r\n0000000000000000000000000000000000A:0')
    }) as typeof fetch
    try {
      expect(await BreachedPasswords.count('password')).toBe(10_434_004)
    } finally {
      globalThis.fetch = original
    }
    expect(calls[0]?.url).toBe('https://api.pwnedpasswords.com/range/5BAA6')
    expect(calls[0]?.headers.get('add-padding')).toBe('true')
  })
})

describe.skipIf(!hasDb)('account lockout and audit log (guide 24)', () => {
  let drop = async () => {}
  const t = testApp({
    async create() {
      const f = await fixtureApp({ lockout: { attempts: 3, decay: '15m' }, csp: false })
      drop = f.drop
      return f.app
    },
  })
  afterAll(async () => {
    await drop()
  })

  const login = (email: string, password: string) =>
    t.post('/login').header('accept', 'application/json').form({ email, password })

  test('locks after 3 failed passwords, even with the right one; AccountLocked emitted; unlock', async () => {
    await makeUser()
    const locked: string[] = []
    AccountLocked.on(({ email }) => {
      locked.push(email)
    })
    for (let i = 0; i < 3; i++) await login('ada@example.test', 'nope').assertProblem(422, 'auth.failed')
    expect(locked).toEqual(['ada@example.test'])
    const refused = await login('Ada@Example.test', 'correct horse').assertProblem(423, 'security.account_locked')
    expect(((await refused.json()) as { params: { retryAfter: number } }).params.retryAfter).toBeGreaterThan(890)
    // unknown emails lock the same way (no difference to tell which accounts exist)
    for (let i = 0; i < 3; i++) await login('nobody@example.test', 'nope').assertStatus(422)
    await login('nobody@example.test', 'nope').assertStatus(423)

    await resolve(Lockout).unlock('ada@example.test')
    await login('ada@example.test', 'correct horse').assertRedirect('/dashboard')
  })

  test('a successful login resets the count', async () => {
    await makeUser()
    for (let i = 0; i < 2; i++) await login('ada@example.test', 'nope').assertStatus(422)
    await login('ada@example.test', 'correct horse').assertRedirect('/dashboard')
    await t.post('/logout').form({})
    for (let i = 0; i < 2; i++) await login('ada@example.test', 'nope').assertStatus(422)
    await login('ada@example.test', 'correct horse').assertRedirect('/dashboard') // not locked: the count restarted
  })

  test('auth events are recorded with the user, IP and request id; secrets redacted', async () => {
    const user = await makeUser()
    await login('ada@example.test', 'nope')
    await login('ada@example.test', 'correct horse').assertRedirect('/dashboard')
    const token = (await (await t.post('/tokens').form({})).json()) as { id: string }
    await t.post('/logout').form({})

    const entries = await resolve(Audit).byUser(user.id)
    expect(entries.map((e) => e.action)).toEqual([
      'auth.logged_out',
      'auth.token_created',
      'auth.login_succeeded',
      'auth.login_failed',
    ])
    const failed = entries[3]
    expect(failed?.data).toEqual({ reason: 'credentials', email: 'ada@example.test' })
    expect(failed?.ip).toBe('127.0.0.1')
    expect(failed?.requestId).toMatch(/^[0-9a-f-]{36}$/)
    expect(entries[1]).toMatchObject({
      subjectType: 'access_token',
      subjectId: token.id,
      data: { name: 'cli', abilities: ['quotes:read'] },
    })
  })

  test('record() joins the transaction: a rolled-back change leaves no entry; for(subject); prune', async () => {
    const user = await makeUser()
    await login('ada@example.test', 'correct horse')
    await t.post('/bookings/b1/refund').form({}).assertOk()
    await t.post('/bookings/b2/refund?fail').header('accept', 'application/json').form({}).assertStatus(409)
    const audit = resolve(Audit)
    const [entry] = await audit.for({ type: 'booking', id: 'b1' })
    expect(entry).toMatchObject({ action: 'booking.refunded', userId: user.id, subjectId: 'b1' })
    expect(entry?.data).toEqual({ amount: '12000', cardNumber: '[redacted]' })
    expect(await audit.for({ type: 'booking', id: 'b2' })).toEqual([])

    expect(await audit.prune('1d')).toBe(0)
    t.clock.advance('2d')
    expect(await audit.prune('1d')).toBeGreaterThan(0)
    expect(await audit.for({ type: 'booking', id: 'b1' })).toEqual([])
  })

  test('cslug audit:prune keeps security.audit.keep (365 days)', async () => {
    await resolve(Audit).record('test.entry')
    expect(await new AuditPruneCommand().handle()).toBe(0)
    expect(await t.db.count('cslug_audit_log')).toBe(1)
    t.clock.advance('366d')
    expect(await new AuditPruneCommand().handle()).toBe(0)
    expect(await t.db.count('cslug_audit_log')).toBe(0)
  })
})
