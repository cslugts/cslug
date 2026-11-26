import { defineSchedule } from '../../../src'
import { PingJob } from '../app/jobs/reports/ping-job'

export default defineSchedule((s) => {
  s.job(PingJob, { n: 7 }).dailyAt('07:00')
  s.call('tidy', () => {}).hourly()
})
