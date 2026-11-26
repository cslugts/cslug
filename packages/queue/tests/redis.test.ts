import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { Application } from '@cslug/core'
import { QueueStatsCommand, RedisQueue, Workers } from '../src'
import {
  cleanRedis,
  FailingJob,
  failures,
  HangOnFirstAttemptJob,
  NoPayloadJob,
  prefix,
  REDIS_URL,
  RecordJob,
  redisApp,
  reset,
  runs,
  SlowJob,
  TodoCompleted,
  until,
} from './support'

const keys = prefix()
let app: Application

describe.skipIf(!REDIS_URL)('the queue on Redis Streams (guide 11)', () => {
  beforeAll(async () => {
    app = redisApp(keys, { queues: { default: { concurrency: 3 }, listeners: { concurrency: 1 } } })
    await app.start()
  })
  afterAll(async () => {
    await app.shutdown()
    await cleanRedis(keys)
  })
  beforeEach(reset)
  afterEach(async () => {
    await app.resolve(Workers).stopAll()
    for (const q of await app.resolve(RedisQueue).queues()) await app.resolve(RedisQueue).clear(q)
  })

  const work = (...queues: string[]) =>
    app.resolve(Workers).start((queues.length ? queues : ['default']).map((name) => ({ name, concurrency: 3 })))
  const queue = () => app.resolve(RedisQueue)

  test('a dispatched job runs in a worker, payload intact (bigint, Date); the stream is emptied', async () => {
    await work()
    const at = new Date('2027-05-14T08:00:00Z')
    await RecordJob.dispatch({ n: 1, at, big: 12_000n })
    await NoPayloadJob.dispatch()
    await until(() => runs.length === 2, 3000, 'both jobs')
    expect(runs).toContainEqual({ job: 'record', payload: { n: 1, at, big: 12_000n } })
    await until(async () => (await queue().stats('default')).waiting + (await queue().stats('default')).active === 0)
  })

  test('delay(): the job waits in the delayed set until it is due', async () => {
    await work()
    await RecordJob.dispatch({ n: 1 }).delay('400ms')
    await Bun.sleep(150)
    expect(runs).toEqual([])
    expect((await queue().stats('default')).delayed).toBe(1)
    await until(() => runs.length === 1, 3000, 'the delayed job')
  })

  test('unique(): a duplicate is ignored while the first is waiting or running, allowed after it finished', async () => {
    expect(await RecordJob.dispatch({ n: 1 }).unique('report:1')).not.toBeNull()
    expect(await RecordJob.dispatch({ n: 2 }).unique('report:1')).toBeNull()
    await work()
    await until(() => runs.length === 1)
    await until(async () => (await RecordJob.dispatch({ n: 3 }).unique('report:1')) !== null, 3000, 'the key released')
    await until(() => runs.length === 2)
    expect(runs.map((r) => (r.payload as { n: number }).n)).toEqual([1, 3])
  })

  test('priority(): within a queue, bands 1–3 before 4–7 before 8–10', async () => {
    await RecordJob.dispatch({ n: 9 }).priority(9)
    await RecordJob.dispatch({ n: 5 })
    await RecordJob.dispatch({ n: 1 }).priority(1)
    await app.resolve(Workers).start([{ name: 'default', concurrency: 1 }])
    await until(() => runs.length === 3)
    expect(runs.map((r) => (r.payload as { n: number }).n)).toEqual([1, 5, 9])
  })

  test('retries with backoff, then failed(payload, error) once and the failed store; retry and forget', async () => {
    await work()
    await FailingJob.dispatch({ n: 7 })
    await until(() => failures.length === 1, 3000, 'the failed hook')
    expect(runs.filter((r) => r.job === 'failing')).toHaveLength(3)
    expect(failures).toEqual([{ payload: { n: 7 }, error: 'boom 7' }])
    let failed = await queue().failed()
    await until(async () => {
      failed = await queue().failed()
      return failed.length === 1
    })
    expect(failed[0]?.envelope.name).toBe('FailingJob')
    expect(failed[0]?.error).toBe('boom 7')

    const id = failed[0]?.envelope.id as string
    expect(await queue().retryFailed(id)).toBe(true)
    await until(() => failures.length === 2, 3000, 'the retried job to fail again')
    await until(async () => (await queue().failed()).length === 1)
    expect(await queue().forget((await queue().failed())[0]?.envelope.id as string)).toBe(true)
    expect(await queue().failed()).toEqual([])
  })

  test('timeout: a run longer than static timeout fails with JobTimeoutError', async () => {
    await work()
    await SlowJob.dispatch({ ms: 1000 })
    await until(async () => (await queue().failed()).length === 1, 3000, 'the timed-out job')
    expect((await queue().failed())[0]?.error).toContain('ran longer than its timeout (150 ms)')
    // the timeout fails the attempt but cannot stop the handler: it finishes in the background
    await until(() => runs.length === 1, 3000, 'the abandoned handler to finish')
  })

  test('queued listeners run as jobs on their queue', async () => {
    await work('listeners')
    await TodoCompleted.emit({ todoId: 't1' })
    await until(() => runs.length === 1, 3000, 'the listener')
    expect(runs).toEqual([{ job: 'listener', payload: { todoId: 't1' } }])
  })

  test('stop(): running jobs finish before it resolves; nothing new is taken', async () => {
    await work()
    await SlowJob.dispatch({ ms: 100 })
    await until(async () => (await queue().stats('default')).active === 1, 3000, 'the job to start')
    await app.resolve(Workers).stopAll()
    expect(runs).toEqual([{ job: 'slow', payload: { ms: 100 } }])
    await RecordJob.dispatch({ n: 1 })
    await Bun.sleep(150)
    expect(runs).toHaveLength(1)
  })

  test('queue:stats', async () => {
    await RecordJob.dispatch({ n: 1 })
    await RecordJob.dispatch({ n: 2 }).delay('1h')
    const rows = await queue().stats('default')
    expect(rows).toMatchObject({ queue: 'default', waiting: 1, active: 0, delayed: 1 })
    expect(QueueStatsCommand.signature).toBe('queue:stats')
  })

  test('acceptance: a killed worker’s job is taken over by another worker after its lease', async () => {
    await HangOnFirstAttemptJob.dispatch({ n: 1 })
    const child = Bun.spawn(['bun', join(import.meta.dir, 'fixture/crash-worker.ts'), keys], {
      stdout: 'pipe',
      stderr: 'inherit',
      env: process.env,
    })
    const reader = child.stdout.getReader()
    let out = ''
    while (!out.includes('started')) {
      const { value, done } = await reader.read()
      if (done) throw new Error(`the child worker exited before starting the job: ${out}`)
      out += new TextDecoder().decode(value)
    }
    child.kill('SIGKILL')
    await child.exited
    // not taken over before the lease (600 ms) expires
    await work()
    await Bun.sleep(200)
    expect(runs).toEqual([])
    await until(() => runs.length === 1, 5000, 'the reclaimed job')
    expect(runs).toEqual([{ job: 'hang', payload: { n: 1 }, attempt: 2 }])
  }, 15_000)
})
