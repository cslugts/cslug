import { test } from 'bun:test'
import { testApp } from '@cslug/testing'
import { UserFactory } from '#database/factories/user-factory'
import { TodoFactory } from '#database/factories/todo-factory'

const app = testApp()

test('the token API lists and creates todos', async () => {
  const me = await UserFactory.create()
  await TodoFactory.for({ userId: me.id }).create({ title: 'Via API' })
  const { plainText: token } = await app.tokens.create(me, { abilities: ['todos:read', 'todos:write'] })

  await app.get('/api/v1/todos').withToken(token).assertOk().assertJson({ data: [{ title: 'Via API', done: false }] })
  await app.post('/api/v1/todos').withToken(token).json({ title: 'Created via API' }).assertCreated()
})

test('a read-only token cannot create', async () => {
  const me = await UserFactory.create()
  const { plainText: token } = await app.tokens.create(me, { abilities: ['todos:read'] })
  await app.post('/api/v1/todos').withToken(token).json({ title: 'x' }).assertForbidden()
})
