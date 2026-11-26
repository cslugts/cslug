import { test, expect } from 'bun:test'
import { todoTransformer } from '#app/transformers/todo-transformer'
import type { Todo } from '#app/tables/todo-table'

test('done is derived from completedAt', () => {
  const todo = { id: '1', title: 'x', notes: null, priority: 'normal', dueOn: null, completedAt: new Date(), userId: 'u' } as Todo
  expect(todoTransformer(todo).done).toBe(true)
})
