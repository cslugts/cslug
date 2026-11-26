import { test, expect } from 'bun:test'
import { testApp } from '@cslug/testing'
import { UserFactory } from '#database/factories/user-factory'

const app = testApp()

test('a visitor can register and lands on the todo list', async () => {
  await app.post('/register')
    .form({ name: 'Ada', email: 'ADA@example.test', password: 'correct horse battery', passwordConfirmation: 'correct horse battery' })
    .assertRedirect('/todos')
    .assertSessionHas('success')

  await app.assertDatabaseHas('users', { email: 'ada@example.test' })
  expect(app.auth.check()).toBe(true)
})

test('registration rejects a taken email and keeps the old input', async () => {
  await UserFactory.create({ email: 'taken@example.test' })

  await app.post('/register')
    .form({ name: 'Bob', email: 'taken@example.test', password: 'correct horse battery', passwordConfirmation: 'correct horse battery' })
    .assertInvalid({ email: 'This value is already taken.' })
    .assertOldInput({ name: 'Bob' })
})

test('login with the wrong password fails', async () => {
  const user = await UserFactory.create()
  await app.post('/login').form({ email: user.email, password: 'nope' }).assertInvalid({ email: 'These credentials do not match our records.' })
})

test('guests are redirected to login', async () => {
  await app.get('/todos').assertRedirect('/login')
})
