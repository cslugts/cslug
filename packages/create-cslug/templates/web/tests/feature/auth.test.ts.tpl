import { expect, test } from 'bun:test'
import { testApp } from '@cslug/testing'
import { UserFactory } from '#database/factories/user-factory'

const app = testApp()

test('the home page renders', async () => {
  await app.get('/').assertOk().assertSee('{{title}}')
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

test('guests are redirected to login', async () => {
  await app.get('/dashboard').assertRedirect('/login')
})
