import { test, expect } from 'bun:test'
import { testApp } from '@cslug/testing'
import { notNull } from '@cslug/database'
import { UserFactory } from '#database/factories/user-factory'
import { TodoFactory } from '#database/factories/todo-factory'
import { SendDueRemindersJob } from '#app/jobs/send-due-reminders-job'
import { TodoDueMail } from '#app/mail/todo-due-mail'

const app = testApp({ fakes: ['queue', 'mail'] })

test('the scheduler dispatches the reminder job at 07:00', async () => {
  app.clock.travelTo('2027-03-01T07:00:00Z')
  await app.schedule.runDue()
  app.queue.assertPushed(SendDueRemindersJob)
})

test('one email per user, each todo reminded once', async () => {
  app.clock.travelTo('2027-03-01T07:00:00Z')
  const ada = await UserFactory.create({ email: 'ada@example.test' })
  await TodoFactory.for({ userId: ada.id }).state('dueToday').createMany(2)
  await TodoFactory.for({ userId: ada.id }).state('overdue').create()
  await TodoFactory.for({ userId: ada.id }).state('dueToday').state('done').create()   // completed: ignored

  await app.resolve(SendDueRemindersJob).handle()
  await app.resolve(SendDueRemindersJob).handle()                                     // second run: nothing new

  app.mail.assertQueuedCount(TodoDueMail, 1)
  app.mail.assertQueued(TodoDueMail, (m) => m.to === 'ada@example.test' && m.subject === '3 todos are due')
  expect(await app.db.count('todos', { userId: ada.id, remindedAt: notNull() })).toBe(3)
})
