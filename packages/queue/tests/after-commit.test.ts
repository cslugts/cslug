import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Application, Logger } from '@cslug/core'
import { Database, DatabaseProvider } from '@cslug/database'
import { RedisProvider } from '@cslug/redis'
import { QueueProvider, RedisQueue, Workers } from '../src'
import { cleanRedis, DATABASE_URL, prefix, REDIS_URL, RecordJob, reset, runs, until } from './support'

const keys = prefix()
let app: Application
const waiting = async () => (await app.resolve(RedisQueue).stats('default')).waiting

describe.skipIf(!REDIS_URL || !DATABASE_URL)('after-commit dispatch (guide 11, D7)', () => {
  beforeAll(async () => {
    app = new Application({
      configs: {
        database: { url: DATABASE_URL },
        redis: { connections: { default: { url: REDIS_URL } }, prefix: keys },
        queue: { lease: '600ms', block: '50ms' },
      },
    }).useProviders([DatabaseProvider, RedisProvider, QueueProvider])
    app.singleton(Logger, () => Logger.null())
    await app.start()
  })
  afterAll(async () => {
    await app.shutdown()
    await cleanRedis(keys)
  })
  beforeEach(reset)

  test('inside a transaction the job is held until COMMIT', async () => {
    const db = app.resolve(Database)
    await db.transaction(async () => {
      await RecordJob.dispatch({ n: 1 })
      expect(await waiting()).toBe(0) // not in Redis yet
    })
    expect(await waiting()).toBe(1)
    await app.resolve(RedisQueue).clear('default')
  })

  test('acceptance: a rolled-back dispatch never runs', async () => {
    await app.resolve(Workers).start([{ name: 'default', concurrency: 2 }])
    const db = app.resolve(Database)
    await expect(
      db.transaction(async () => {
        await RecordJob.dispatch({ n: 1 })
        await db.transaction(async () => RecordJob.dispatch({ n: 2 })) // a savepoint inside it
        throw new Error('rollback')
      }),
    ).rejects.toThrow('rollback')
    await RecordJob.dispatch({ n: 3 }) // proves the worker is running
    await until(() => runs.length === 1, 3000, 'the committed job')
    await Bun.sleep(200)
    expect(runs.map((r) => (r.payload as { n: number }).n)).toEqual([3])
    await app.resolve(Workers).stopAll()
  })

  test('immediately() sends at once even inside a transaction (and survives its rollback)', async () => {
    const db = app.resolve(Database)
    await expect(
      db.transaction(async () => {
        await RecordJob.dispatch({ n: 1 }).immediately()
        expect(await waiting()).toBe(1)
        throw new Error('rollback')
      }),
    ).rejects.toThrow('rollback')
    expect(await waiting()).toBe(1)
    await app.resolve(RedisQueue).clear('default')
  })
})
