import { expect, test } from 'bun:test'
import { TwoFactor, totpCode } from '@cslug/auth'
import { resolve } from '@cslug/core'
import { testApp } from '@cslug/testing'
import { UserFactory } from '#database/factories/user-factory'

const app = testApp()

test('the home page renders', async () => {
  await app.get('/').assertOk().assertSee('{{title}}')
})

test('an unknown page renders the app\'s 404 page; API clients get JSON', async () => {
  await app.get('/no-such-page').assertNotFound().assertSee('Page not found').assertSee('Back to the home page')
  await app.get('/no-such-page').header('accept', 'application/json').assertProblem(404, 'route.not_found')
})

test('a visitor can register and lands on the dashboard', async () => {
  await app
    .post('/register')
    .form({
      name: 'Ada',
      email: 'ADA@example.test',
      password: 'correct horse battery',
      passwordConfirmation: 'correct horse battery',
    })
    .assertRedirect('/dashboard')
    .assertSessionHas('success')

  await app.assertDatabaseHas('users', { email: 'ada@example.test' })
  expect(app.auth.check()).toBe(true)
})

test('registration rejects a taken email and keeps the old input', async () => {
  await UserFactory.create({ email: 'taken@example.test' })
  await app
    .post('/register')
    .form({
      name: 'Bob',
      email: 'taken@example.test',
      password: 'correct horse battery',
      passwordConfirmation: 'correct horse battery',
    })
    .assertInvalid({ email: 'This value is already taken.' })
    .assertOldInput({ name: 'Bob' })
})

test('login with the right password, then the dashboard', async () => {
  const user = await UserFactory.create()
  await app.post('/login').form({ email: user.email, password: 'password-password' }).assertRedirect('/dashboard')
  await app.get('/dashboard').assertOk().assertSee(`Hello, ${user.name}!`)
})

test('login with the wrong password fails', async () => {
  const user = await UserFactory.create()
  await app
    .post('/login')
    .form({ email: user.email, password: 'nope' })
    .assertInvalid({ email: 'These credentials do not match our records.' })
})

test('with two-factor authentication: the password, then a code, then the dashboard', async () => {
  const user = await UserFactory.create()
  const twoFactor = resolve(TwoFactor)
  const { secret } = await twoFactor.enable(user, user.email)
  const [recoveryCode] = (await twoFactor.confirm(user, totpCode(secret, new Date()))) ?? []

  await app.post('/login').form({ email: user.email, password: 'password-password' }).assertRedirect('/two-factor')
  await app.get('/dashboard').assertRedirect('/login') // not signed in yet
  await app.get('/two-factor').assertOk().assertSee('Enter the 6-digit code')
  await app.post('/two-factor').form({ code: '000000' }).assertInvalid({ code: 'This code is not valid.' })
  await app.post('/two-factor').form({ code: String(recoveryCode) }).assertRedirect('/dashboard')
  await app.get('/dashboard').assertOk().assertSee(`Hello, ${user.name}!`)
})

test('the code page without a waiting login goes back to login', async () => {
  await app.get('/two-factor').assertRedirect('/login')
})

test('guests are redirected to login', async () => {
  await app.get('/dashboard').assertRedirect('/login')
})
