import { afterAll, describe, expect, test } from 'bun:test'
import { resolve } from '@cslug/core'
import { testApp } from '@cslug/testing'
import { MagicLinks } from '../src'
import { BookingRepository, fixtureApp, Hash, Tokens, UserRepository } from './fixture/app'

const hasDb = !!process.env.DATABASE_URL
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

const makeUser = async (values: Partial<{ email: string; name: string; role: string; password: string }> = {}) =>
  resolve(UserRepository).create({
    email: values.email ?? 'ada@example.test',
    name: values.name ?? 'Ada',
    role: values.role ?? 'traveller',
    passwordHash: await resolve(Hash).make(values.password ?? 'correct horse'),
  })

describe.skipIf(!hasDb)('auth (guide 15)', () => {
  test('login with a password: session regenerated, intended URL, then the user is known', async () => {
    await makeUser()
    // a guest asking for /dashboard is sent to the login route, which remembers where they wanted to go
    await t.get('/dashboard').assertRedirect('/login')
    const before = t.app.config('session.cookie') ?? 'cslug_session'
    await t
      .post('/login')
      .form({ email: 'ada@example.test', password: 'correct horse' })
      .assertRedirect('/dashboard')
      .assertCookie(String(before))
    await t.get('/dashboard').assertOk().assertJson({ hello: 'Ada' })
    await t.get('/me').assertJson({ user: 'ada@example.test' })
    await t.get('/login').assertRedirect('/') // guest() only
    await t.post('/logout').form({}).assertRedirect('/login')
    await t.get('/me').assertJson({ user: null })
  })

  test('wrong password or unknown email: same failure; throttled per email + IP', async () => {
    await makeUser()
    await t
      .post('/login')
      .header('accept', 'application/json')
      .form({ email: 'ada@example.test', password: 'nope' })
      .assertProblem(422, 'auth.failed')
    await t
      .post('/login')
      .header('accept', 'application/json')
      .form({ email: 'nobody@example.test', password: 'nope' })
      .assertProblem(422, 'auth.failed')
    await t
      .post('/login')
      .header('accept', 'application/json')
      .form({ email: 'ada@example.test', password: 'nope' })
      .assertProblem(422, 'auth.failed')
    await t
      .post('/login')
      .header('accept', 'application/json')
      .form({ email: 'ada@example.test', password: 'nope' })
      .assertProblem(422, 'auth.failed')
    await t
      .post('/login')
      .header('accept', 'application/json')
      .form({ email: 'ada@example.test', password: 'correct horse' })
      .assertStatus(429)
  })

  test('login rehashes a password made with old parameters', async () => {
    const old = await new Hash({ memoryCost: 8192, timeCost: 1 }).make('correct horse')
    const user = await resolve(UserRepository).create({
      email: 'ada@example.test',
      name: 'Ada',
      role: 'traveller',
      passwordHash: old,
    })
    await t.post('/login').form({ email: 'ada@example.test', password: 'correct horse' }).assertRedirect('/dashboard')
    const after = (await resolve(UserRepository).find(user.id))?.passwordHash as string
    expect(after).not.toBe(old)
    expect(resolve(Hash).needsRehash(after)).toBe(false)
  })

  test('JSON guests get 401; a deleted user is signed out', async () => {
    await t.get('/dashboard').header('accept', 'application/json').assertProblem(401, 'auth.unauthenticated')
    const user = await makeUser()
    t.actingAs(user)
    await t.get('/dashboard').assertOk()
    await resolve(UserRepository).delete(user.id)
    await t.get('/dashboard').header('accept', 'application/json').assertStatus(401)
  })

  test('policies: before(), ability arguments; gates as middleware', async () => {
    const ada = await makeUser()
    const booking = await resolve(BookingRepository).create({ travellerId: ada.id, status: 'proposed' })
    await t.get(`/bookings/${booking.id}`).actingAs(ada).assertJson({ booking: booking.id, canPay: true })
    t.actingAs(ada)
    await t.get('/admin').header('accept', 'application/json').assertProblem(403, 'auth.forbidden')
  })

  test('…another user is forbidden; an admin passes through before()', async () => {
    const ada = await makeUser()
    const bo = await makeUser({ email: 'bo@example.test', name: 'Bo' })
    const admin = await makeUser({ email: 'root@example.test', role: 'admin' })
    const booking = await resolve(BookingRepository).create({ travellerId: ada.id, status: 'paid' })
    t.actingAs(bo)
    await t.get(`/bookings/${booking.id}`).header('accept', 'application/json').assertProblem(403, 'auth.forbidden')
    t.actingAs(admin)
    await t.get(`/bookings/${booking.id}`).assertJson({ canPay: true })
    await t.get('/admin').assertOk()
  })

  test('magic links: sign in once, then "used"; expired; tampered; redirects stay local', async () => {
    const user = await makeUser()
    const links = resolve(MagicLinks)
    const { token } = links.create(user, { redirect: '/bookings' })
    await t.get(`/magic/${token}`).assertRedirect('/bookings')
    await t.get('/me').assertJson({ user: 'ada@example.test' })
    await t.get(`/magic/${token}`).header('accept', 'application/json').assertProblem(400, 'auth.magic_link_used')

    const old = links.create(user, { lifetime: '1h' }).token
    t.clock.advance('2h')
    await t.get(`/magic/${old}`).header('accept', 'application/json').assertProblem(400, 'auth.magic_link_expired')
    const forged = `${token.split('.')[0]}.AAAA`
    await t.get(`/magic/${forged}`).header('accept', 'application/json').assertProblem(400, 'auth.magic_link_invalid')
    expect(() => links.create(user, { redirect: '//evil.example' })).toThrow('must be a local path')
  })

  test('API tokens: Bearer, abilities, expiry, revocation; only the hash is stored', async () => {
    const user = await makeUser()
    const tokens = resolve(Tokens)
    const { plainText, token } = await tokens.create(user, {
      name: 'quote-bot',
      abilities: ['quotes:read'],
      expiresIn: '1d',
    })
    await t.get('/api/quotes').withToken(plainText).assertJson({ by: 'ada@example.test', guard: 'token' })
    await t.post('/api/quotes').withToken(plainText).json({}).assertProblem(403, 'auth.token_ability')
    await t.get('/api/quotes').withToken(`${token.id}.wrong`).assertProblem(401, 'auth.unauthenticated')
    await t.get('/api/quotes').header('accept', 'application/json').assertStatus(401)
    expect(JSON.stringify(await t.db.find('cslug_access_tokens', token.id))).not.toContain(plainText.split('.')[1])
    t.clock.advance('2d')
    await t.get('/api/quotes').withToken(plainText).assertStatus(401)
    t.clock.travelTo(new Date())
    await tokens.revoke(token.id)
    await t.get('/api/quotes').withToken(plainText).assertStatus(401)
  })

  test('a session user cannot use token-only routes', async () => {
    t.actingAs(await makeUser())
    await t.get('/api/quotes').header('accept', 'application/json').assertStatus(401)
  })
})

describe('Hash', () => {
  test('argon2id; verify; needsRehash when parameters change; malformed hashes are false', async () => {
    const hash = new Hash({ memoryCost: 4096, timeCost: 1 })
    const h = await hash.make('secret')
    expect(h).toStartWith('$argon2id$')
    expect([
      await hash.verify('secret', h),
      await hash.verify('nope', h),
      await hash.verify('x', 'garbage'),
      await hash.verify('x', null),
    ]).toEqual([true, false, false, false])
    expect(hash.needsRehash(h)).toBe(false)
    expect(new Hash({ memoryCost: 8192, timeCost: 1 }).needsRehash(h)).toBe(true)
    expect(new Hash({ algorithm: 'bcrypt', cost: 4 }).needsRehash(h)).toBe(true)
  })
})
