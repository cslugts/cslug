import { beforeEach, describe, expect, test } from 'bun:test'
import { Application, Clock, CslugError, FakeClock, Logger } from '@cslug/core'
import { buildSchedule, Cron, defineSchedule, localTime, Queue, QueueFake, type ScheduleEntry, Scheduler } from '../src'
import { NoPayloadJob, RecordJob } from './support'

const minutes = (iso: string) => new Date(iso)

describe('Cron', () => {
  test('fields, lists, ranges, steps, names; Sunday is 0 or 7', () => {
    const at = (iso: string) => localTime(new Date(iso))
    expect(new Cron('*/15 * * * *').matches(at('2027-05-14T08:45:00Z'))).toBe(true)
    expect(new Cron('*/15 * * * *').matches(at('2027-05-14T08:46:00Z'))).toBe(false)
    expect(new Cron('0 9-17/4 * * mon-fri').matches(at('2027-05-14T13:00:00Z'))).toBe(true) // a Friday
    expect(new Cron('0 9-17/4 * * mon-fri').matches(at('2027-05-15T13:00:00Z'))).toBe(false) // Saturday
    expect(new Cron('0 0 * * 7').matches(at('2027-05-16T00:00:00Z'))).toBe(true) // Sunday
    expect(new Cron('0 0 1,15 jan *').matches(at('2027-01-15T00:00:00Z'))).toBe(true)
  })

  test('day of month OR day of week when both are restricted (as in cron)', () => {
    const c = new Cron('0 0 13 * 5')
    expect(c.matches(localTime(new Date('2027-05-13T00:00:00Z')))).toBe(true) // the 13th, a Thursday
    expect(c.matches(localTime(new Date('2027-05-14T00:00:00Z')))).toBe(true) // a Friday
    expect(c.matches(localTime(new Date('2027-05-15T00:00:00Z')))).toBe(false)
  })

  test('invalid expressions say why', () => {
    expect(() => new Cron('* * *')).toThrow(/needs 5 fields/)
    expect(() => new Cron('61 * * * *')).toThrow(/minute "61" is not in 0–59/)
    expect(() => new Cron('* * * * funday')).toThrow(CslugError)
    expect(() => new Cron('5-1 * * * *')).toThrow(/backwards/)
  })

  test('next(): in a time zone, across months, and over a DST change', () => {
    expect(new Cron('0 8 * * *').next(minutes('2027-05-14T05:30:00Z'), 'Indian/Antananarivo')?.toISOString()).toBe(
      '2027-05-15T05:00:00.000Z',
    )
    expect(new Cron('0 9 1 * *').next(minutes('2027-01-31T12:00:00Z'), 'Europe/Paris')?.toISOString()).toBe(
      '2027-02-01T08:00:00.000Z', // winter: UTC+1
    )
    // Paris goes to summer time on 2027-03-28: 09:00 is 07:00Z that day
    expect(new Cron('0 9 * * *').next(minutes('2027-03-27T09:00:00Z'), 'Europe/Paris')?.toISOString()).toBe(
      '2027-03-28T07:00:00.000Z',
    )
    expect(new Cron('30 0 * * *').next(minutes('2027-03-27T23:00:00Z'), 'Europe/Paris')?.toISOString()).toBe(
      '2027-03-27T23:30:00.000Z', // 00:30 local on the DST day is not skipped
    )
    expect(new Cron('0 0 29 2 *').next(minutes('2027-03-01T00:00:00Z'))?.toISOString()).toBe('2028-02-29T00:00:00.000Z')
  })
})

// a scheduler over an in-memory lock and the queue fake
let app: Application
let clock: FakeClock
let fake: QueueFake
const ran: string[] = []

function scheduler(define: Parameters<typeof defineSchedule>[0], env = 'production') {
  app = new Application({ configs: { app: { env } } })
  app.singleton(Logger, () => Logger.null())
  clock = new FakeClock('UTC', '2027-05-15T05:00:00Z')
  app.swap(Clock, clock)
  fake = new QueueFake(app)
  app.swap(Queue, fake)
  const s = new Scheduler(app, undefined, 'UTC', Logger.null())
  s.entries = buildSchedule(defineSchedule(define))
  return s
}
beforeEach(() => {
  ran.length = 0
})

describe('defineSchedule (guide 12)', () => {
  test('dailyAt in a time zone: 08:00 in Antananarivo is 05:00Z', async () => {
    const s = scheduler((s) => {
      s.job(RecordJob, { n: 1 }).dailyAt('08:00').timezone('Indian/Antananarivo')
    })
    expect((await s.runDue(minutes('2027-05-15T05:00:00Z'))).map((r) => r.status)).toEqual(['dispatched'])
    fake.assertPushed(RecordJob, (j) => j.payload.n === 1)
    expect(await s.runDue(minutes('2027-05-15T08:00:00Z'))).toEqual([])
  })

  test('helpers and their descriptions; names from the job class', () => {
    const s = scheduler((s) => {
      s.job(NoPayloadJob).weeklyOn('monday', '07:00')
      s.job(RecordJob, { n: 1 }).monthlyOn(1, '09:00').timezone('Europe/Paris')
      s.call('cache:prune-fx', () => {}).hourly()
      s.cron('0 */6 * * *', 'db:vacuum', NoPayloadJob)
      s.job(RecordJob, { n: 2 }).twiceDaily('08:00', '18:30').as('record-twice')
    })
    const rows = s.entries.map((e: ScheduleEntry) => [e.name, e.description, s.tzOf(e)])
    expect(rows).toEqual([
      ['no-payload', 'mondays 07:00', 'UTC'],
      ['record', 'monthly 1st 09:00', 'Europe/Paris'],
      ['cache:prune-fx', 'hourly', 'UTC'],
      ['db:vacuum', '0 */6 * * *', 'UTC'],
      ['record-twice', 'daily 08:00 and 18:30', 'UTC'],
    ])
    expect(s.next(s.entries[0] as ScheduleEntry, minutes('2027-05-15T05:00:00Z'))?.toISOString()).toBe(
      '2027-05-17T07:00:00.000Z',
    )
    expect(s.next(s.entries[4] as ScheduleEntry, minutes('2027-05-15T09:00:00Z'))?.toISOString()).toBe(
      '2027-05-15T18:30:00.000Z',
    )
  })

  test('two entries with one name are refused', () => {
    expect(() =>
      scheduler((s) => {
        s.job(RecordJob, { n: 1 }).daily()
        s.job(RecordJob, { n: 2 }).hourly()
      }),
    ).toThrow(/Two schedule entries are named "record"/)
  })

  test('weekdays(), between(), when(), environments()', async () => {
    let enabled = false
    const s = scheduler((s) => {
      s.call('weekdays', () => ran.push('weekdays'))
        .everyMinute()
        .weekdays()
      s.call('office', () => ran.push('office'))
        .everyMinute()
        .between('08:00', '20:00')
      s.call('flag', () => ran.push('flag'))
        .everyMinute()
        .when(() => enabled)
      s.call('prod', () => ran.push('prod'))
        .everyMinute()
        .environments(['production'])
      s.call('staging', () => ran.push('staging'))
        .everyMinute()
        .environments(['staging'])
    })
    await s.runDue(minutes('2027-05-15T05:00:00Z')) // Saturday, 05:00
    expect(ran).toEqual(['prod'])
    ran.length = 0
    enabled = true
    await s.runDue(minutes('2027-05-17T09:00:00Z')) // Monday, 09:00
    expect(ran).toEqual(['weekdays', 'office', 'flag', 'prod'])
  })

  test('s.call runs inline with resolve(); a failure is recorded as failed, not thrown', async () => {
    const s = scheduler((s) => {
      s.call('reads-clock', ({ resolve }) => ran.push(resolve(Clock).now().toISOString())).everyMinute()
      s.call('breaks', () => {
        throw new Error('nope')
      }).everyMinute()
    })
    const runs = await s.runDue()
    expect(ran).toEqual(['2027-05-15T05:00:00.000Z'])
    expect(runs.map((r) => [r.name, r.status, r.error])).toEqual([
      ['reads-clock', 'ok', undefined],
      ['breaks', 'failed', 'nope'],
    ])
  })

  test('no overlap by default: a job still waiting, or a task still running, is skipped', async () => {
    let release = () => {}
    const s = scheduler((s) => {
      s.job(RecordJob, { n: 1 }).everyMinute()
      s.call('slow', () => new Promise<void>((r) => (release = r))).everyMinute()
      s.job(NoPayloadJob).everyMinute().allowOverlap()
    })
    const first = s.runDue(minutes('2027-05-15T05:00:00Z'))
    await Bun.sleep(5)
    const second = await s.runDue(minutes('2027-05-15T05:01:00Z'))
    expect(second.map((r) => [r.name, r.status])).toEqual([
      ['record', 'skipped'],
      ['slow', 'skipped'],
      ['no-payload', 'dispatched'],
    ])
    release()
    await first
    fake.assertPushedCount(RecordJob, 1)
    fake.assertPushedCount(NoPayloadJob, 2)
  })

  test('once per tick: the same tick run twice runs once (the lock)', async () => {
    const s = scheduler((s) => {
      s.call('once', () => ran.push('once')).everyMinute()
    })
    await Promise.all([s.runDue(), s.runDue()])
    expect(ran).toEqual(['once'])
  })
})
