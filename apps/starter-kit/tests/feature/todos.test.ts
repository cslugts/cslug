import { test, expect } from 'bun:test'
import { testApp } from '@cslug/testing'
import { UserFactory } from '#database/factories/user-factory'
import { TodoFactory } from '#database/factories/todo-factory'
import { TodoCompleted } from '#app/events/todo-completed'
import TodoIndex from '#views/todos/index.vue'

const app = testApp({ fakes: ['events'] })

test('the list shows only my todos, server-rendered, with islands', async () => {
  const me = await UserFactory.create()
  await TodoFactory.for({ userId: me.id }).create({ title: 'Buy bread' })
  await TodoFactory.create({ title: 'Someone else’s todo' })

  await app.get('/todos').actingAs(me)
    .assertOk()
    .assertView(TodoIndex, (props) => expect(props.todos).toHaveLength(1))
    .assertSee('Buy bread')
    .assertDontSee('Someone else’s todo')
    .assertIsland('new-todo-form')
    .assertIsland('todo-item', { todo: { title: 'Buy bread' } })
})

test('creating a todo works as a plain form and as JSON', async () => {
  const me = await UserFactory.create()

  await app.post('/todos').actingAs(me).form({ title: 'Plain form' }).assertRedirect()
  await app.post('/todos').actingAs(me).json({ title: 'From the island', priority: 'high' }).assertOk()
    .assertJson({ todo: { title: 'From the island', priority: 'high' } })

  expect(await app.db.count('todos', { userId: me.id })).toBe(2)
})

test('an empty title is rejected (422 for the island)', async () => {
  const me = await UserFactory.create()
  await app.post('/todos').actingAs(me).json({ title: '' }).assertProblem(422, 'validation.failed')
})

test('toggling completes a todo and emits TodoCompleted', async () => {
  const todo = await TodoFactory.create()
  const owner = (await app.db.find('users', todo.userId)) as { id: string }

  await app.post(`/todos/${todo.id}/toggle`).actingAs(owner).json({}).assertOk()
    .assertJson({ todo: { id: todo.id }, stats: { done: 1 } })

  app.events.assertEmitted(TodoCompleted, (e) => e.payload.todoId === todo.id)
})

test('I cannot touch someone else’s todo', async () => {
  const me = await UserFactory.create()
  const theirs = await TodoFactory.create()

  await app.post(`/todos/${theirs.id}/toggle`).actingAs(me).json({}).assertForbidden()
  await app.delete(`/todos/${theirs.id}`).actingAs(me).json({}).assertForbidden()
})
