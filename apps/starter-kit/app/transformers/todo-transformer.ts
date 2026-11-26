import type { Todo } from '#app/tables/todo-table'

/** Public JSON shape of a todo for the token API. */
export const todoTransformer = (todo: Todo) => ({
  id: todo.id,
  title: todo.title,
  notes: todo.notes,
  priority: todo.priority,
  dueOn: todo.dueOn,
  done: todo.completedAt !== null,
  completedAt: todo.completedAt,
})
