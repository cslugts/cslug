import { v } from '@cslug/validation'
import { TodoPriority } from '#app/tables/todo-table'

export const StoreTodoValidator = v.object({
  title: v.string().trim().min(1).max(200),
  notes: v.string().trim().max(2000).optional(),
  priority: v.enum(TodoPriority).default('normal'),
  dueOn: v.date().optional(),                       // 'YYYY-MM-DD'
})
