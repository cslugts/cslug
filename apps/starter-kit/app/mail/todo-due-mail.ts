import { Mailable } from '@cslug/mail'
import { t } from '@cslug/core'
import TodoDue from '#resources/mail/todo-due.vue'
import type { TodoPriority } from '#app/tables/todo-table'

export type DueItem = { title: string; dueOn: string; priority: TodoPriority }

export class TodoDueMail extends Mailable {
  static queued = true

  constructor(private name: string, private items: DueItem[]) { super() }

  build() {
    return this
      .subject(t('mail.todo_due.subject', { count: this.items.length }))
      .view(TodoDue, { name: this.name, items: this.items })
  }
}
