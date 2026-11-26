import { StoreTodoValidator } from './store-todo-validator'

/** Same fields as create, all optional (PATCH). */
export const UpdateTodoValidator = StoreTodoValidator.partial()
