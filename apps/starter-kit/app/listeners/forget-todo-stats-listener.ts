import { inject, listener, Cache } from '@cslug/core'
import { TodoCompleted } from '#app/events/todo-completed'

/** Synchronous listener: drop the cached header counts so the next page shows fresh numbers. */
@inject(Cache)
@listener(TodoCompleted)
export class ForgetTodoStatsListener {
  constructor(private cache: Cache) {}

  async handle({ userId }: TodoCompleted['payload']) {
    await this.cache.forget(`todos:stats:${userId}`)
  }
}
