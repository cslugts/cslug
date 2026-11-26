import { defineSchedule } from '@cslug/queue'
import { SendDueRemindersJob } from '#app/jobs/send-due-reminders-job'

export default defineSchedule((s) => {
  // Every morning: one email per user listing the todos due today or overdue.
  s.job(SendDueRemindersJob).dailyAt('07:00')
})
