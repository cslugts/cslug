import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { Application, type Command, ConsoleIO, Logger, runInContext } from '@cslug/core'
import { RedisProvider } from '@cslug/redis'
import {
  discoverJobs,
  findJob,
  QueueClearCommand,
  QueueFailedCommand,
  QueueForgetCommand,
  QueueProvider,
  QueueRetryCommand,
  QueueStatsCommand,
  QueueWorkCommand,
  RedisQueue,
  Workers,
} from '../src'
import { cleanRedis, FailingJob, prefix, REDIS_URL, RecordJob, reset, until } from './support'

const FIXTURE = join(import.meta.dir, 'fixture')
const keys = prefix()
let app: Application

class Captured extends ConsoleIO {
  out = ''
  override write(text: string) {
    this.out += text
  }
  override error(text: string) {
    this.out += text
  }
}

/** Run a command's handle() the way the CLI kernel does (in a context, with captured output). */
async function run<C extends new () => Command>(cmd: C, args: Record<string, unknown>, on: Application = app) {
  const io = new Captured()
  on.swap(ConsoleIO, io)
  const scope = on.createScope()
  const code = await runInContext({ app: on, scope }, () =>
    (new cmd() as unknown as { handle(a: unknown): unknown }).handle(args),
  )
  on.restoreSwaps()
  return { code: typeof code === 'number' ? code : 0, out: io.out }
}

describe('discovery', () => {
  test('imports app/jobs and app/listeners (subfolders, not *.test.ts) and registers job classes by name', async () => {
    const found = await discoverJobs(new Application({ root: FIXTURE }))
    expect(found).toBe(1)
    expect(findJob('fixture.ping')?.name).toBe('PingJob')
  })
})

describe.skipIf(!REDIS_URL)('queue:* commands', () => {
  beforeAll(async () => {
    app = new Application({
      root: FIXTURE,
      configs: {
        redis: { connections: { default: { url: REDIS_URL } }, prefix: keys },
        queue: { lease: '600ms', block: '50ms', queues: { default: { concurrency: 2 } } },
      },
    }).useProviders([RedisProvider, QueueProvider])
    app.singleton(Logger, () => Logger.null())
    await app.start()
  })
  afterAll(async () => {
    await app.shutdown()
    await cleanRedis(keys)
  })
  beforeEach(reset)

  test('queue:work runs the configured queues with discovered jobs; SIGTERM path stops it', async () => {
    const { PingJob } = await import('./fixture/app/jobs/reports/ping-job')
    await run(QueueWorkCommand, { queues: [], queue: [], concurrency: undefined })
    await PingJob.dispatch({ n: 42 })
    await until(() => ((globalThis as { pinged?: number[] }).pinged ?? []).includes(42), 3000, 'the discovered job')
    await app.resolve(Workers).stopAll()
  })

  test('queue:failed, queue:retry, queue:forget', async () => {
    await app.resolve(Workers).start([{ name: 'default', concurrency: 1 }])
    await FailingJob.dispatch({ n: 1 })
    const queue = app.resolve(RedisQueue)
    await until(async () => (await queue.failed()).length === 1, 3000, 'the failed job')
    await app.resolve(Workers).stopAll()

    const listed = await run(QueueFailedCommand, { json: true })
    const [row] = JSON.parse(listed.out) as { id: string; job: string; error: string }[]
    expect(row).toMatchObject({ job: 'FailingJob', error: 'boom 1' })

    expect((await run(QueueRetryCommand, { id: 'nope' })).code).toBe(1)
    expect((await run(QueueRetryCommand, { id: row?.id })).out).toContain('1 job(s) queued again')
    expect(await queue.failed()).toEqual([])
    expect((await queue.stats('default')).waiting).toBe(1)

    await queue.clear('default')
    expect((await run(QueueForgetCommand, { id: 'nope' })).code).toBe(1)
  })

  test('queue:clear refuses in production without --force; queue:stats', async () => {
    await RecordJob.dispatch({ n: 1 })
    const production = new Application({ configs: { app: { env: 'production' } } })
    const refused = await run(QueueClearCommand, { name: 'default', force: false }, production)
    expect(refused).toMatchObject({ code: 1, out: expect.stringContaining('add --force') })
    const stats = JSON.parse((await run(QueueStatsCommand, { json: true })).out) as { queue: string; waiting: number }[]
    expect(stats.find((s) => s.queue === 'default')?.waiting).toBe(1)
    expect((await run(QueueClearCommand, { name: 'default', force: false })).code).toBe(0)
    expect((await app.resolve(RedisQueue).stats('default')).waiting).toBe(0)
  })
})
