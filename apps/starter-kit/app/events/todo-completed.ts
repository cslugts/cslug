import { Event } from '@cslug/core'

export class TodoCompleted extends Event<{ todoId: string; userId: string }>('todo.completed') {}
