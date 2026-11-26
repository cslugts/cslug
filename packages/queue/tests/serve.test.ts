import { afterAll, describe, expect, test } from 'bun:test'
import { Application, ConsoleIO, Logger, runInContext } from '@cslug/core'
import { HttpProvider, ServeCommand } from '@cslug/http'
import { RedisProvider } from '@cslug/redis'
import { QueueProvider, ScheduleProvider, Scheduler } from '../src'
import { cleanRedis, prefix, REDIS_URL, RecordJob, reset, runs, until } from './support'

const keys = prefix()
const apps: Application[] = []
afterAll(async () => {
  for (const a of apps) await a.shutdown()
  if (REDIS_URL) await cleanRedis(keys)
})

class Quiet extends ConsoleIO {
  out = ''
  override write(text: string) {
    this.out += text
  }
  override error(text: string) {
    this.out += text
  }
}

async function serve(
  providers: ConstructorParameters<typeof Application>[0] & { list: never[] },
  flags: Record<string, unknown>,
) {
  const app = new Application({
    configs: {
      redis: { connections: { default: { url: REDIS_URL } }, prefix: keys },
      queue: { block: '50ms', queues: { default: { concurrency: 2 } } },
      ...providers.configs,
    },
  }).useProviders(providers.list)
  app.singleton(Logger, () => Logger.null())
  const io = new Quiet()
  app.instance(ConsoleIO, io)
  await app.start()
  apps.push(app)
  const code = await runInContext({ app, scope: app.createScope() }, () =>
    new ServeCommand().handle({ port: 0, host: '127.0.0.1', reusePort: false, ...flags } as never),
  )
  return { app, code, io }
}

describe.skipIf(!REDIS_URL)('cslug serve --with-worker --with-scheduler (guide 21, model 1)', () => {
  test('one process: HTTP, the queue worker and the scheduler', async () => {
    reset()
    const { app, code } = await serve(
      { list: [RedisProvider, QueueProvider, ScheduleProvider, HttpProvider] as never[] },
      { withWorker: true, withScheduler: true },
    )
    expect(code).toBe(0)
    await runInContext({ app, scope: app.createScope() }, () => RecordJob.dispatch({ n: 1 }))
    await until(() => runs.length === 1, 3000, 'the job, run in the web process')
    expect(await app.resolve(Scheduler).heartbeat()).toBeGreaterThan(Date.now() - 5000)
  })

  test('without @cslug/queue the flag is an error, not a silent no-op', async () => {
    const { code, io } = await serve({ list: [HttpProvider] as never[] }, { withWorker: true })
    expect(code).toBe(1)
    expect(io.out).toContain('--with-worker: no queue:work command')
  })
})
