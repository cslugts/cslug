import { afterAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { Application, Clock, FakeClock, Logger } from '@cslug/core'
import { RedisProvider } from '@cslug/redis'
import { testApp } from '@cslug/testing'
import { buildSchedule, defineSchedule, QueueProvider, RedisQueue, ScheduleProvider, Scheduler } from '../src'
import { PingJob } from './fixture/app/jobs/reports/ping-job'
import { cleanRedis, prefix, REDIS_URL, RecordJob } from './support'

const FIXTURE = join(import.meta.dir, 'fixture')
const keys = prefix()
const apps: Application[] = []

/** An app with the scheduler on real Redis (locks and history in Redis, shared by every app on `keys`). */
async function schedulerApp(define: Parameters<typeof defineSchedule>[0]) {
  const app = new Application({
    configs: {
      redis: { connections: { default: { url: REDIS_URL } }, prefix: keys },
      queue: { lease: '600ms', block: '50ms' },
    },
  }).useProviders([RedisProvider, QueueProvider, ScheduleProvider])
  app.singleton(Logger, () => Logger.null())
  await app.start()
  apps.push(app)
  const scheduler = app.resolve(Scheduler)
  scheduler.entries = buildSchedule(defineSchedule(define))
  return { app, scheduler }
}

afterAll(async () => {
  for (const a of apps) await a.shutdown()
  if (REDIS_URL) await cleanRedis(keys)
})

describe.skipIf(!REDIS_URL)('the scheduler on Redis (guide 12)', () => {
  test('acceptance: two schedulers → one run per tick', async () => {
    const define = (s: Parameters<Parameters<typeof defineSchedule>[0]>[0]) => {
      s.job(RecordJob, { n: 1 }).everyMinute().as('two-instances')
    }
    const [a, b] = await Promise.all([schedulerApp(define), schedulerApp(define)])
    const tick = new Date('2027-05-15T05:00:00Z')
    const [ra, rb] = await Promise.all([a.scheduler.runDue(tick), b.scheduler.runDue(tick)])
    expect([...ra, ...rb].map((r) => r.status)).toEqual(['dispatched'])
    expect((await a.app.resolve(RedisQueue).stats('default')).waiting).toBe(1)
    // the next tick runs again (once); the job is still waiting, so it is skipped (no overlap)
    const next = await Promise.all([
      a.scheduler.runDue(new Date('2027-05-15T05:01:00Z')),
      b.scheduler.runDue(new Date('2027-05-15T05:01:00Z')),
    ])
    expect(next.flat().map((r) => r.status)).toEqual(['skipped'])
    expect((await a.scheduler.history('two-instances')).map((r) => r.status)).toEqual(['skipped', 'dispatched'])
    await a.app.resolve(RedisQueue).clear('default')
  })

  test('history: name, scheduled_for, started_at, finished_at, status, error', async () => {
    const { scheduler } = await schedulerApp((s) => {
      s.call('history-demo', () => {
        throw new Error('nope')
      }).hourly()
    })
    await scheduler.runDue(new Date('2027-05-15T05:00:00Z'))
    const [run] = await scheduler.history('history-demo')
    expect(run).toMatchObject({ name: 'history-demo', status: 'failed', error: 'nope' })
    expect(run?.scheduledFor).toEqual(new Date('2027-05-15T05:00:00Z'))
    expect(run?.finishedAt).toBeInstanceOf(Date)
  })

  test("catchUp('once'): one missed tick runs on recovery; without it, missed ticks are skipped", async () => {
    const ran: string[] = []
    const { scheduler } = await schedulerApp((s) => {
      s.call('catch-up', () => ran.push('catch-up'))
        .dailyAt('07:00')
        .catchUp('once')
      s.call('no-catch-up', () => ran.push('no-catch-up')).dailyAt('07:00')
    })
    await scheduler.run(scheduler.find('catch-up') as never, new Date('2027-05-10T07:00:00Z'))
    await scheduler.run(scheduler.find('no-catch-up') as never, new Date('2027-05-10T07:00:00Z'))
    ran.length = 0
    // down for three days; back at 09:00
    const runs = await scheduler.catchUp(new Date('2027-05-13T09:00:00Z'))
    expect(ran).toEqual(['catch-up'])
    expect(runs[0]?.scheduledFor).toEqual(new Date('2027-05-11T07:00:00Z'))
    expect(await scheduler.catchUp(new Date('2027-05-13T09:01:00Z'))).toHaveLength(1) // still behind: 05-12
  })

  test('the loop: start() ticks in the background, stop() returns promptly, heartbeat recorded', async () => {
    const { scheduler } = await schedulerApp(() => {})
    scheduler.start()
    await Bun.sleep(50)
    const started = Date.now()
    await scheduler.stop()
    expect(Date.now() - started).toBeLessThan(500)
    expect(await scheduler.heartbeat()).toBeGreaterThan(Date.now() - 5000)
  })
})

describe.skipIf(!REDIS_URL)('testApp: t.schedule.runDue() with the queue fake (guide 12 § Testing)', () => {
  const t = testApp({
    create() {
      const app = new Application({
        root: FIXTURE,
        configs: {
          redis: { connections: { default: { url: REDIS_URL } }, prefix: keys },
          schedule: { timezone: 'Indian/Antananarivo' },
        },
      }).useProviders([RedisProvider, QueueProvider, ScheduleProvider])
      app.singleton(Logger, () => Logger.null())
      return app
    },
    fakes: ['queue'],
  })

  test('routes/schedule.ts is loaded; the job is pushed at 07:00 local, not before', async () => {
    t.clock.travelTo('2027-03-01T03:59:00Z') // 06:59 in Antananarivo
    await t.schedule.runDue()
    t.queue?.assertNotPushed(PingJob)
    t.clock.travelTo('2027-03-01T04:00:00Z')
    await t.schedule.runDue()
    await t.schedule.runDue() // tests replay ticks freely (no once-per-tick lock)
    t.queue?.assertPushed(PingJob, (j) => j.payload.n === 7)
    expect(t.resolve(Clock)).toBeInstanceOf(FakeClock)
  })
})
