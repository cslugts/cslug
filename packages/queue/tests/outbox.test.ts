import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Application, Logger, runInContext } from '@cslug/core'
import { Database, DatabaseProvider, Migrator, sql } from '@cslug/database'
import { RedisProvider } from '@cslug/redis'
import { SQL } from 'bun'
import { OUTBOX_MIGRATIONS, Outbox, QueueProvider, RedisQueue } from '../src'
import { cleanRedis, DATABASE_URL, prefix, REDIS_URL, RecordJob, reset } from './support'

const keys = prefix()
const name = `cslug_queue_${process.pid}_${Math.random().toString(36).slice(2, 8)}`
let admin: SQL | undefined
let app: Application
const waiting = async () => (await app.resolve(RedisQueue).stats('default')).waiting
const rows = async () => Number(await app.resolve(Database).value(sql`select count(*)::int from cslug_queue_outbox`))
const inApp = <T>(fn: () => Promise<T>) => runInContext({ app, scope: app.createScope() }, fn)

describe.skipIf(!REDIS_URL || !DATABASE_URL)('durable dispatch: the outbox (guide 11)', () => {
  beforeAll(async () => {
    admin = new SQL(Object.assign(new URL(DATABASE_URL as string), { pathname: '/postgres' }).toString(), { max: 1 })
    await admin.unsafe(`create database "${name}"`)
    app = new Application({
      configs: {
        database: { url: Object.assign(new URL(DATABASE_URL as string), { pathname: `/${name}` }).toString() },
        redis: { connections: { default: { url: REDIS_URL } }, prefix: keys },
      },
    }).useProviders([DatabaseProvider, RedisProvider, QueueProvider])
    app.singleton(Logger, () => Logger.null())
    await app.start()
    await new Migrator(app.resolve(Database), { packageMigrations: [OUTBOX_MIGRATIONS] }).migrate()
  })
  afterAll(async () => {
    await app?.shutdown()
    await admin?.unsafe(`drop database if exists "${name}" with (force)`)
    await admin?.close()
    if (REDIS_URL) await cleanRedis(keys)
  })
  beforeEach(async () => {
    reset()
    await app.resolve(RedisQueue).clear('default')
  })

  test('the provider found the database: Outbox is bound and its migration registered', () => {
    expect(app.has(Outbox)).toBe(true)
  })

  test('the row is written in the transaction, relayed right after COMMIT, then deleted', async () => {
    const db = app.resolve(Database)
    await inApp(() =>
      db.transaction(async () => {
        await RecordJob.dispatch({ n: 1 }).durable()
        expect(await rows()).toBe(1) // inside the transaction
        expect(await waiting()).toBe(0)
      }),
    )
    expect(await waiting()).toBe(1)
    expect(await rows()).toBe(0)
  })

  test('rolled back: no row, no job', async () => {
    const db = app.resolve(Database)
    await expect(
      inApp(() =>
        db.transaction(async () => {
          await RecordJob.dispatch({ n: 1 }).durable()
          throw new Error('rollback')
        }),
      ),
    ).rejects.toThrow('rollback')
    expect(await rows()).toBe(0)
    expect(await waiting()).toBe(0)
  })

  test('a row left behind (process died after COMMIT) is relayed by relay()', async () => {
    const db = app.resolve(Database)
    const outbox = app.resolve(Outbox)
    // write the row the way .durable() does, but without the fast path
    await inApp(() =>
      db.transaction(async () => {
        await outbox.write(
          {
            id: Bun.randomUUIDv7(),
            name: 'RecordJob',
            queue: 'default',
            payload: { n: 9 },
            attempt: 0,
            tries: 3,
            dispatchedAt: Date.now(),
          },
          {},
        )
      }),
    )
    expect(await rows()).toBe(1)
    expect(await inApp(() => outbox.relay())).toBe(1)
    expect(await rows()).toBe(0)
    expect(await waiting()).toBe(1)
  })
})
