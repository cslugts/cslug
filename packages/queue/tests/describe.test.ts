import { afterAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { Application, DESCRIBE, type DescribeSection, Logger } from '@cslug/core'
import { RedisProvider } from '@cslug/redis'
import { QueueProvider, ScheduleProvider } from '../src'
import { prefix, REDIS_URL } from './support'

describe.skipIf(!REDIS_URL)('cslug describe: jobs and schedules', async () => {
  const app = new Application({
    root: join(import.meta.dir, 'fixture'),
    configs: { redis: { connections: { default: { url: REDIS_URL } }, prefix: prefix() } },
  }).useProviders([RedisProvider, QueueProvider, ScheduleProvider])
  app.singleton(Logger, () => Logger.null())
  await app.start()
  afterAll(() => app.shutdown())
  const section = (name: string) =>
    app
      .tagged<DescribeSection>(DESCRIBE)
      .find((s) => s.name === name)
      ?.collect()

  test('jobs: discovered from app/jobs, with their settings', async () => {
    const jobs = (await section('jobs')) as { name: string; queue: string; tries: number }[]
    expect(jobs.find((j) => j.name === 'fixture.ping')).toMatchObject({ queue: 'default', tries: 3, timeoutMs: 60_000 })
  })

  test('schedules: from routes/schedule.ts', async () => {
    expect(await section('schedules')).toEqual([
      { name: 'ping', when: 'daily 07:00', job: 'fixture.ping', overlap: false },
      { name: 'tidy', when: 'hourly', overlap: false },
    ])
  })
})
