import { inject } from '@cslug/core'
import { Command, arg, flag } from '@cslug/cli'
import { lte } from '@cslug/database'
import { TodoRepository } from '#app/repositories/todo-repository'

@inject(TodoRepository)
export class PurgeCompletedTodosCommand extends Command {
  static signature = 'todos:purge'
  static description = 'Delete todos completed more than N days ago.'
  static args = {
    days: arg.number().default(90).describe('Age in days'),
    dryRun: flag.boolean().describe('Count only'),
  }

  constructor(private todos: TodoRepository) { super() }      // the clock: this.clock (Command's)

  async handle({ days, dryRun }: Command.Args<typeof PurgeCompletedTodosCommand>) {
    const cutoff = this.clock.subtract(`${days}d`)
    if (dryRun) {
      this.info(`${await this.todos.count({ completedAt: lte(cutoff) })} todos would be deleted`)
      return
    }
    const deleted = await this.todos.purgeCompletedBefore(cutoff)
    this.success(`${deleted} todos deleted`)
  }
}
