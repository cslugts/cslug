import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Application, currentContext, Event, inject, Logger, listener, runInContext } from '@cslug/core'
import {
  amount,
  currency,
  type Database,
  DatabaseProvider,
  date,
  id,
  integer,
  jsonb,
  RowCountError,
  sql,
  table,
  text,
  UniqueViolationError,
} from '../src'
import { DATABASE_URL, describeDb, testDatabase } from './support'

const ledger = table('ledger_entries', {
  id: id(),
  bookingId: text(),
  kind: text().oneOf(['deposit_held', 'released', 'refunded']),
  amount: amount(),
  currency: currency(),
  entryDate: date(),
  attempt: integer().default(1),
  meta: jsonb<{ reference: string; tags: string[] }>(),
})

let t: Awaited<ReturnType<typeof testDatabase>>
let db: Database
const ctxOf = (requestId: string) => {
  const app = new Application()
  return { app, scope: app.createScope(), requestId }
}

describeDb('Database (real PostgreSQL)', () => {
  beforeAll(async () => {
    t = await testDatabase()
    db = t.db
    await db.exec(sql`create table ledger_entries (
      id uuid primary key, booking_id text not null, kind text not null, amount bigint not null,
      currency char(3) not null, entry_date date not null, attempt integer not null default 1, meta jsonb not null,
      unique (booking_id, kind))`)
  })
  afterAll(async () => {
    await t?.drop()
  })

  const insert = (bookingId: string, kind: string, amountMinor: bigint) =>
    db.exec(sql`insert into ${ledger} (id, booking_id, kind, amount, currency, entry_date, meta)
      values (${Bun.randomUUIDv7()}, ${bookingId}, ${kind}, ${amountMinor}, 'EUR', ${'2027-05-14'}, ${sql.json({ reference: `ref-${bookingId}`, tags: ['a', 'b'] })})`)

  test('the context survives queries and transactions (the open question from spike d)', async () => {
    const wrong = { query: 0, transaction: 0, savepoint: 0, after: 0 }
    await Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        runInContext(ctxOf(`req-${i}`), async () => {
          const check = (key: keyof typeof wrong) => {
            if (currentContext()?.requestId !== `req-${i}`) wrong[key]++
          }
          await db.value(sql`select pg_sleep(${Math.random() * 0.003})`)
          check('query')
          await db.transaction(async () => {
            await db.value(sql`select 1`)
            check('transaction')
            await db.transaction(async () => {
              await db.value(sql`select 1`)
              check('savepoint')
            })
          })
          check('after')
        }),
      ),
    )
    expect(wrong).toEqual({ query: 0, transaction: 0, savepoint: 0, after: 0 })
  })

  test('many / one / maybeOne / value / exec, typed by the table', async () => {
    expect(await insert('b1', 'deposit_held', 66000n)).toBe(1)
    const rows = await db.many(sql`select * from ${ledger} where ${ledger.c.bookingId} = ${'b1'}`, ledger)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      bookingId: 'b1',
      kind: 'deposit_held',
      amount: 66000n,
      currency: 'EUR',
      entryDate: '2027-05-14',
      attempt: 1,
      meta: { reference: 'ref-b1', tags: ['a', 'b'] },
    })
    expect((await db.one(sql`select * from ${ledger} where ${ledger.c.bookingId} = ${'b1'}`, ledger)).amount).toBe(
      66000n,
    )
    expect(await db.maybeOne(sql`select * from ${ledger} where ${ledger.c.bookingId} = ${'nope'}`, ledger)).toBeNull()
    await expect(db.one(sql`select * from ${ledger} where false`)).rejects.toBeInstanceOf(RowCountError)
    expect(await db.value<number>(sql`select count(*)::int from ${ledger}`)).toBe(1)
  })

  test('ad-hoc rows are camelCased; sum() of bigint is numeric in Postgres, so cast it', async () => {
    const [r] = await db.many(
      sql<{
        bookingId: string
        total: bigint
      }>`select booking_id, sum(amount)::bigint as total from ${ledger} group by 1`,
    )
    expect(r).toEqual({ bookingId: 'b1', total: 66000n })
    // without the cast Postgres returns numeric, which arrives as a string
    expect(await db.value(sql`select sum(amount) from ${ledger}`)).toBe('66000')
  })

  test('a unique violation is a typed error naming the constraint', async () => {
    const error = await insert('b1', 'deposit_held', 1n).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(UniqueViolationError)
    expect((error as UniqueViolationError).constraint).toBe('ledger_entries_booking_id_kind_key')
    expect((error as Error).message).not.toContain("'b1'") // parameters are never in messages
  })

  test('commit and rollback; queries inside use the transaction without passing it', async () => {
    await db.transaction(async () => {
      await insert('b2', 'deposit_held', 1n)
    })
    await db
      .transaction(async () => {
        await insert('b3', 'deposit_held', 1n)
        expect(await db.value<number>(sql`select count(*)::int from ${ledger} where booking_id = 'b3'`)).toBe(1) // visible inside
        throw new Error('rollback')
      })
      .catch(() => {})
    expect(await db.value<number>(sql`select count(*)::int from ${ledger} where booking_id in ('b2', 'b3')`)).toBe(1)
    const same = await db.transaction(async (tx) => {
      const a = await db.value(sql`select txid_current()`)
      const b = await tx.value(sql`select txid_current()`)
      return a === b
    })
    expect(same).toBe(true)
  })

  test('nested transactions are savepoints: an inner failure keeps the outer work', async () => {
    await db.transaction(async () => {
      await insert('b4', 'deposit_held', 1n)
      await db
        .transaction(async () => {
          await insert('b4', 'released', 1n)
          throw new Error('inner')
        })
        .catch(() => {})
    })
    const kinds = await db.many(sql<{ kind: string }>`select kind from ${ledger} where booking_id = 'b4'`)
    expect(kinds.map((k) => k.kind)).toEqual(['deposit_held'])
  })

  test('afterCommit hooks run after the outermost commit; never on rollback; dropped with a failed savepoint', async () => {
    const ran: string[] = []
    await db.transaction(async (tx) => {
      tx.afterCommit(() => ran.push('outer'))
      await db.transaction(async (inner) => {
        inner.afterCommit(() => ran.push('kept savepoint'))
      })
      await db
        .transaction(async (inner) => {
          inner.afterCommit(() => ran.push('failed savepoint'))
          throw new Error('x')
        })
        .catch(() => {})
      expect(ran).toEqual([]) // nothing before commit
    })
    expect(ran).toEqual(['outer', 'kept savepoint'])
    await db
      .transaction(async (tx) => {
        tx.afterCommit(() => ran.push('rolled back'))
        throw new Error('rollback')
      })
      .catch(() => {})
    expect(ran).toEqual(['outer', 'kept savepoint'])
  })

  test("core's afterCommit(): a queued listener waits for the database commit", async () => {
    class DepositHeld extends Event<{ bookingId: string }>('test.deposit_held') {}
    const seen: string[] = []
    @inject()
    @listener(DepositHeld, { queued: true })
    class Notify {
      handle({ bookingId }: DepositHeld['payload']) {
        seen.push(bookingId)
      }
    }
    void Notify
    const app = await new Application().start()
    await runInContext({ app, scope: app.createScope() }, () =>
      db.transaction(async () => {
        await DepositHeld.emit({ bookingId: 'b9' })
        await new Promise((r) => setTimeout(r, 20))
        expect(seen).toEqual([]) // still inside the transaction
      }),
    )
    await new Promise((r) => setTimeout(r, 20))
    expect(seen).toEqual(['b9'])
    await app.shutdown()
  })

  test('isolation level and retry on serialization failure', async () => {
    expect(await db.transaction(() => db.value(sql`show transaction_isolation`), { isolation: 'serializable' })).toBe(
      'serializable',
    )
    let attempts = 0
    const result = await db.transaction(
      async () => {
        attempts++
        if (attempts < 3) await db.exec(sql`do $$ begin raise exception 'conflict' using errcode = '40001'; end $$`)
        return 'done'
      },
      { retry: 3 },
    )
    expect([result, attempts]).toEqual(['done', 3])
  })

  test('withoutTransaction runs on the pool even inside a transaction', async () => {
    await db
      .transaction(async () => {
        await db.withoutTransaction(() => insert('audit', 'deposit_held', 1n))
        throw new Error('rollback the rest')
      })
      .catch(() => {})
    expect(await db.value<number>(sql`select count(*)::int from ${ledger} where booking_id = 'audit'`)).toBe(1)
  })

  test('advisory locks serialise concurrent holders (in and out of transactions)', async () => {
    const order: string[] = []
    const work = (name: string, inTx: boolean) => {
      const body = () =>
        db.advisoryLock('payout:op1', async () => {
          order.push(`${name} in`)
          await new Promise((r) => setTimeout(r, 30))
          order.push(`${name} out`)
        })
      return inTx ? db.transaction(body) : body()
    }
    await Promise.all([work('a', false), work('b', true), work('c', false)])
    for (let i = 0; i < order.length; i += 2)
      expect(order[i]?.replace(' in', '')).toBe(order[i + 1]?.replace(' out', ''))
  })

  test('slow queries are logged with the SQL text, never the parameters', async () => {
    const lines: string[] = []
    const slow = (await import('../src')).Database
    const logged = new slow({ url: t.url, slowQueryMs: 0 }, new Logger({ write: (l) => lines.push(l) }))
    await logged.value(sql`select ${'secret-value'}::text`)
    await logged.close()
    const entry = JSON.parse(lines[0] ?? '{}')
    expect(entry).toMatchObject({ level: 'warn', msg: 'slow query', sql: 'select $1::text' })
    expect(lines.join()).not.toContain('secret-value')
  })

  test('DatabaseProvider: boots (ping) and closes', async () => {
    const app = await new Application({ configs: { database: { url: DATABASE_URL ? t.url : '' } } })
      .useProviders([DatabaseProvider])
      .start()
    const provided = app.resolve((await import('../src')).Database)
    expect(await provided.value<number>(sql`select 41 + 1`)).toBe(42)
    await app.shutdown()
  })
})

describe('without DATABASE_URL', () => {
  test('integration tests skip instead of failing', () => {
    expect(typeof describeDb).toBe('function')
  })
})
