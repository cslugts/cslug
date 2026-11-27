# Scheduler

Scheduled work is declared in one file, `routes/schedule.ts`, and run by `cslug schedule:work` (long-running)
or `cslug schedule:run` (single tick, for an external cron).

```ts
// routes/schedule.ts
import { defineSchedule } from '@cslug/queue'
import { DispatchDailyCheckinsJob } from '#app/jobs/dispatch-daily-checkins-job'
import { RecheckVisaPageJob } from '#app/jobs/recheck-visa-page-job'
import { PilotMetricsReportJob } from '#app/jobs/pilot-metrics-report-job'
import { ExpireStaleProposalsJob } from '#app/jobs/expire-stale-proposals-job'

export default defineSchedule((s) => {
  // MVP #7: mid-trip check-ins, every morning in Madagascar time
  s.job(DispatchDailyCheckinsJob).dailyAt('08:00').timezone('Indian/Antananarivo')

  // MVP #4: visa guide must be rechecked monthly
  s.job(RecheckVisaPageJob).monthlyOn(1, '09:00').timezone('Europe/Paris')

  // MVP #16: weekly pilot metrics for the team
  s.job(PilotMetricsReportJob, { recipients: ['team@example.com'] }).weeklyOn('monday', '07:00')

  s.job(ExpireStaleProposalsJob).everyFifteenMinutes()

  // tiny inline task — runs in the scheduler process, keep it fast
  s.call('cache:prune-fx', async ({ resolve }) => resolve(Cache).tags(['fx']).flush()).hourly()

  s.cron('0 */6 * * *', 'db:vacuum-webhook-inbox', VacuumWebhookInboxJob)
})
```

## Guarantees

| | Default | Override |
|---|---|---|
| **Once per tick across all instances** | Always. A Redis lock `schedule:{name}:{tick}` is taken before running | — |
| **No overlap** with a previous run still going | On | `.allowOverlap()` |
| **Missed ticks** after downtime | Skipped | `.catchUp('once')` runs one missed tick on recovery |
| **Where it runs** | `s.job()` dispatches to the queue; the scheduler stays light | `s.call()` runs inline |
| **Time zone** | UTC | `.timezone('Indian/Antananarivo')` per entry, or `schedule.timezone` in config |

Entry names come from the job class (`DispatchDailyCheckinsJob` → `dispatch-daily-checkins`) or the first argument
of `s.call` / `s.cron`; rename with `.as('name')`. A job entry is skipped while its previous job is still waiting
or running (it is dispatched as a unique job). The lock and the history live in Redis.

Every run is recorded, the last 100 per entry (`name`, `scheduledFor`, `startedAt`, `finishedAt`, `status`:
`dispatched`, `ok`, `failed` or `skipped`, `error`):

```bash
cslug schedule:list
  NAME                         WHEN                         TZ                      NEXT
  dispatch-daily-checkins      daily 08:00                  Indian/Antananarivo     in 13h 2m
  recheck-visa-page            monthly 1st 09:00            Europe/Paris            in 4d
  pilot-metrics-report         mondays 07:00                UTC                     in 4d 18h
cslug schedule:history dispatch-daily-checkins --last=10
cslug schedule:test dispatch-daily-checkins     # run now, once, ignoring the schedule
```

## Frequency helpers

`everyMinute()`, `everyFiveMinutes()`, `everyFifteenMinutes()`, `hourly()`, `hourlyAt(17)`, `daily()`,
`dailyAt('08:00')`, `twiceDaily('08:00', '18:00')`, `weekly()`, `weeklyOn('monday', '07:00')`, `monthly()`,
`monthlyOn(1, '09:00')`, `cron('*/10 * * * *')`, plus `.weekdays()`, `.between('08:00', '20:00')`,
`.when(() => config('features.checkins'))`, `.environments(['production'])`.

## The fan-out pattern

A scheduled job should find the work and dispatch one job per item, so each item retries independently:

```ts
@inject(BookingRepository, Clock)
export class DispatchDailyCheckinsJob extends Job {
  constructor(private bookings: BookingRepository, private clock: Clock) { super() }

  async handle() {
    const today = this.clock.today('Indian/Antananarivo')
    for await (const booking of this.bookings.onTripOn(today)) {
      await SendCheckinJob.dispatch({ bookingId: booking.id, milestone: 'mid_trip' })
        .unique(`checkin:${booking.id}:mid_trip:${today}`)            // exactly once per booking per day
    }
  }
}
```

## Testing

```ts
const app = testApp({ fakes: ['queue'] })
app.clock.travelTo('2027-05-15T05:00:00Z')          // 08:00 in Antananarivo
await app.schedule.runDue()
app.queue.assertPushed(DispatchDailyCheckinsJob)
```
