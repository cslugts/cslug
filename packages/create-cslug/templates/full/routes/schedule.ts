import { defineSchedule } from '@cslug/queue'

/** Recurring work, run by `cslug schedule:work` (part of `cslug dev` and `cslug start`). */
export default defineSchedule((_s) => {
  // s.job(SendDailyDigestJob).dailyAt('07:00')
})
