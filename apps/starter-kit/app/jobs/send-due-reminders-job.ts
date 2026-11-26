import { inject, Clock } from '@cslug/core'
import { Job } from '@cslug/queue'
import { Mailer } from '@cslug/mail'
import { TodoRepository } from '#app/repositories/todo-repository'
import { TodoDueMail } from '#app/mail/todo-due-mail'

/** Scheduled daily. One email per user with their due and overdue todos; each todo is reminded once. */
@inject(TodoRepository, Mailer, Clock)
export class SendDueRemindersJob extends Job {
  static tries = 3
  static backoff = Job.exponential('1m')

  constructor(private todos: TodoRepository, private mailer: Mailer, private clock: Clock) { super() }

  async handle() {
    const rows = await this.todos.dueForReminder(this.clock.today())

    // group by user
    const byUser = Map.groupBy(rows, (row) => row.userId)

    for (const [, items] of byUser) {
      const first = items[0]!
      await this.mailer
        .to({ email: first.email, name: first.name })
        .locale(first.locale)
        .send(new TodoDueMail(first.name, items.map((i) => ({ title: i.title, dueOn: i.dueOn, priority: i.priority }))))
      await this.todos.markReminded(items.map((i) => i.todoId), this.clock.now())
    }
  }
}
