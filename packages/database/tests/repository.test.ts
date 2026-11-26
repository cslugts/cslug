import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Application, inject, NotFoundError, runInContext } from '@cslug/core'
import {
  amount,
  belongsTo,
  between,
  boolean,
  Database,
  date,
  gte,
  hasMany,
  id,
  ilike,
  inList,
  integer,
  jsonb,
  not,
  notNull,
  preload,
  Repository,
  type Row,
  softDeletes,
  sql,
  table,
  text,
  timestamp,
  timestamps,
  uuid,
} from '../src'
import { describeDb, testDatabase } from './support'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
const assertType = <_T extends true>() => {}

const operators = table('operators', {
  id: id(),
  companyName: text(),
  email: text().unique(),
  verificationStatus: text().oneOf(['pending', 'verified', 'suspended']).default('pending'),
  maxSeats: integer().default(4),
  nightDriving: boolean().default(false),
  meta: jsonb<{ tags: string[] }>().nullable(),
  ...timestamps(),
  ...softDeletes(),
})
const todos = table('todos', {
  id: id(),
  operatorId: uuid().references(() => operators),
  title: text(),
  priority: text().oneOf(['low', 'normal', 'high']).default('normal'),
  dueOn: date().nullable(),
  completedAt: timestamp().nullable(),
  ...timestamps(),
})
const bookings = table('bookings', {
  id: id(),
  status: text().oneOf(['deposit_paid', 'released_stage_1']),
  released: amount().default(0n),
})

@inject()
class OperatorRepository extends Repository(operators) {
  verified() {
    return this.where({ verificationStatus: 'verified' }).orderBy('companyName').all()
  }
}
@inject()
class TodoRepository extends Repository(todos) {
  /** the starter kit's forUser() */
  forOperator(operatorId: string, filter: 'all' | 'open' | 'done' = 'all') {
    return this.where({
      operatorId,
      ...(filter === 'open' && { completedAt: null }),
      ...(filter === 'done' && { completedAt: notNull() }),
    })
      .orderBy('completedAt', 'asc', { nulls: 'first' })
      .orderBy('dueOn', 'asc', { nulls: 'last' })
      .all()
  }
}
@inject()
class BookingRepository extends Repository(bookings) {}

let t: Awaited<ReturnType<typeof testDatabase>>
let app: Application
const inApp = <T>(fn: () => Promise<T>) => runInContext({ app, scope: app.createScope() }, fn)
const repo = <R>(cls: new () => R) => app.createScope().resolve(cls as never) as R

describeDb('repositories and the query builder (real PostgreSQL)', () => {
  beforeAll(async () => {
    t = await testDatabase()
    app = new Application().instance(Database, t.db)
    await t.db.exec(sql`create table operators (id uuid primary key, company_name text not null, email text not null unique,
      verification_status text not null default 'pending', max_seats integer not null default 4, night_driving boolean not null default false,
      meta jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz)`)
    await t.db.exec(sql`create table todos (id uuid primary key, operator_id uuid not null references operators(id), title text not null,
      priority text not null default 'normal', due_on date, completed_at timestamptz,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now())`)
    await t.db.exec(
      sql`create table bookings (id uuid primary key, status text not null, released bigint not null default 0)`,
    )
  })
  afterAll(async () => {
    await t?.drop()
  })

  test('create fills ids, defaults and timestamps; returns the typed row', async () => {
    const ops = repo(OperatorRepository)
    const op = await ops.create({
      companyName: 'Ravinala Tours',
      email: 'hello@ravinala.test',
      meta: { tags: ['4x4'] },
    })
    expect(op.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(op).toMatchObject({
      verificationStatus: 'pending',
      maxSeats: 4,
      nightDriving: false,
      meta: { tags: ['4x4'] },
      deletedAt: null,
    })
    expect(op.createdAt).toBeInstanceOf(Date)
    assertType<Equal<typeof op, Row<typeof operators>>>()
    const many = await ops.createMany([
      { companyName: 'Zebu Trails', email: 'z@trails.test', verificationStatus: 'verified' },
      { companyName: 'Baobab Drive', email: 'b@drive.test', verificationStatus: 'verified', maxSeats: 7 },
    ])
    expect(many.map((o) => o.companyName)).toEqual(['Zebu Trails', 'Baobab Drive'])
  })

  test('find / findOrFail / findBy / existsBy / count / domain queries', async () => {
    const ops = repo(OperatorRepository)
    const op = await ops.findByOrFail({ email: 'hello@ravinala.test' })
    expect((await ops.find(op.id))?.companyName).toBe('Ravinala Tours')
    expect(await ops.find(Bun.randomUUIDv7())).toBeNull()
    const missing = await ops.findOrFail(Bun.randomUUIDv7()).catch((e: unknown) => e as NotFoundError)
    expect(missing).toBeInstanceOf(NotFoundError)
    expect((missing as NotFoundError).code).toBe('operator.not_found')
    expect(await ops.existsBy({ email: 'z@trails.test' })).toBe(true)
    expect(await ops.count({ verificationStatus: 'verified' })).toBe(2)
    expect((await ops.verified()).map((o) => o.companyName)).toEqual(['Baobab Drive', 'Zebu Trails'])
  })

  test('operators: inList, not, gte, ilike, between, orWhere, select (typed narrowing)', async () => {
    const ops = repo(OperatorRepository)
    expect(await ops.where({ verificationStatus: inList(['verified', 'suspended']) }).count()).toBe(2)
    expect(await ops.where({ verificationStatus: not(inList(['verified'])) }).count()).toBe(1)
    expect(await ops.where({ maxSeats: gte(5) }).count()).toBe(1)
    expect(await ops.where({ companyName: ilike('%tours%') }).count()).toBe(1)
    expect(await ops.where({ maxSeats: between(4, 6) }).count()).toBe(2)
    expect(await ops.where({ maxSeats: 7 }).orWhere({ companyName: 'Ravinala Tours' }).count()).toBe(2)
    expect(await ops.where({ verificationStatus: inList([]) }).count()).toBe(0) // empty list matches nothing
    const names = await ops.query().select('companyName').orderBy('companyName').all()
    expect(names).toEqual([
      { companyName: 'Baobab Drive' },
      { companyName: 'Ravinala Tours' },
      { companyName: 'Zebu Trails' },
    ])
    assertType<Equal<(typeof names)[number], { companyName: string }>>()
  })

  test('update touches updatedAt; bulk update/delete return counts', async () => {
    const ops = repo(OperatorRepository)
    const op = await ops.findByOrFail({ email: 'hello@ravinala.test' })
    await Bun.sleep(5)
    const updated = await ops.update(op.id, { verificationStatus: 'verified' })
    expect(updated.verificationStatus).toBe('verified')
    expect(updated.updatedAt.getTime()).toBeGreaterThan(op.updatedAt.getTime())
    expect(await ops.where({ maxSeats: 4 }).update({ nightDriving: true })).toBe(2)
    await expect(ops.update(Bun.randomUUIDv7(), { maxSeats: 1 })).rejects.toBeInstanceOf(NotFoundError)
  })

  test('soft deletes: hidden by default, withTrashed / onlyTrashed, restore, forceDelete', async () => {
    const ops = repo(OperatorRepository)
    const temp = await ops.create({ companyName: 'Temp', email: 'temp@x.test' })
    await ops.delete(temp.id)
    expect(await ops.find(temp.id)).toBeNull()
    expect(await ops.withTrashed().where({ id: temp.id }).count()).toBe(1)
    expect((await ops.onlyTrashed().all()).map((o) => o.email)).toEqual(['temp@x.test'])
    expect((await ops.restore(temp.id)).deletedAt).toBeNull()
    await ops.forceDelete(temp.id)
    expect(await ops.withTrashed().where({ id: temp.id }).count()).toBe(0)
  })

  test("the starter kit's filters: open first, then by due date, nulls last", async () => {
    const ops = repo(OperatorRepository)
    const tds = repo(TodoRepository)
    const op = await ops.findByOrFail({ email: 'z@trails.test' })
    await tds.createMany([
      { operatorId: op.id, title: 'done', completedAt: new Date() },
      { operatorId: op.id, title: 'no date' },
      { operatorId: op.id, title: 'soon', dueOn: '2027-05-14' },
      { operatorId: op.id, title: 'later', dueOn: '2027-06-01', priority: 'high' },
    ])
    expect((await tds.forOperator(op.id)).map((x) => x.title)).toEqual(['soon', 'later', 'no date', 'done'])
    expect((await tds.forOperator(op.id, 'open')).length).toBe(3)
    expect((await tds.forOperator(op.id, 'done')).map((x) => x.title)).toEqual(['done'])
    expect((await tds.where({ dueOn: '2027-05-14' }).first())?.dueOn).toBe('2027-05-14')
  })

  test('paginate, cursor (keyset), each (streaming)', async () => {
    const tds = repo(TodoRepository)
    const page = await tds.paginate({ page: 2, perPage: 3, orderBy: 'title' })
    expect(page.meta).toEqual({ page: 2, perPage: 3, total: 4, lastPage: 2 })
    expect(page.data.map((x) => x.title)).toEqual(['soon'])
    const first = await tds.query().cursor({ limit: 3, orderBy: 'title' })
    const second = await tds.query().cursor({ limit: 3, orderBy: 'title', after: first.next })
    expect([...first.data, ...second.data].map((x) => x.title)).toEqual(['done', 'later', 'no date', 'soon'])
    expect(second.next).toBeNull()
    const seen: string[] = []
    for await (const todo of tds.query().each({ batch: 2 })) seen.push(todo.title)
    expect(seen.sort()).toEqual(['done', 'later', 'no date', 'soon'])
  })

  test('preload: belongsTo and hasMany, one query each', async () => {
    const tds = repo(TodoRepository)
    await inApp(async () => {
      const list = await tds.where({ priority: 'high' }).all()
      const withOperator = await preload(list, { operator: belongsTo(operators, 'operatorId') })
      expect(withOperator[0]?.operator?.companyName).toBe('Zebu Trails')
      const ops = await repo(OperatorRepository).where({ email: 'z@trails.test' }).all()
      const withTodos = await preload(ops, { todos: hasMany(todos, 'operatorId', { orderBy: 'title' }) })
      expect(withTodos[0]?.todos.map((x) => x.title)).toEqual(['done', 'later', 'no date', 'soon'])
      assertType<Equal<(typeof withTodos)[number]['todos'], Row<typeof todos>[]>>()
    })
  })

  test('upsert on a unique key', async () => {
    const ops = repo(OperatorRepository)
    const a = await ops.upsert({ companyName: 'Lemur Co', email: 'lemur@x.test' }, { conflict: ['email'] })
    const b = await ops.upsert({ companyName: 'Lemur Company', email: 'lemur@x.test' }, { conflict: ['email'] })
    expect(b.id).toBe(a.id)
    expect(b.companyName).toBe('Lemur Company')
  })

  test('lockForUpdate outside a transaction is a clear error', async () => {
    const b = await repo(BookingRepository).create({ status: 'deposit_paid' })
    await expect(repo(BookingRepository).lockForUpdate(b.id)).rejects.toThrow(/only makes sense inside db.transaction/)
  })

  test('acceptance: two concurrent releases of the same stage → exactly one release (row lock)', async () => {
    const booking = await repo(BookingRepository).create({ status: 'deposit_paid' })
    const release = () =>
      inApp(() =>
        t.db.transaction(async () => {
          const bookingsRepo = repo(BookingRepository)
          const locked = await bookingsRepo.lockForUpdate(booking.id)
          if (locked.status !== 'deposit_paid') return 'skipped'
          await Bun.sleep(30) // the window where a race would double-release
          await bookingsRepo.update(booking.id, { status: 'released_stage_1', released: locked.released + 30000n })
          return 'released'
        }),
      )
    const results = await Promise.all([release(), release()])
    expect(results.sort()).toEqual(['released', 'skipped'])
    expect((await repo(BookingRepository).findOrFail(booking.id)).released).toBe(30000n)
  })

  test('using(tx): an explicit transaction handle', async () => {
    const bookingsRepo = repo(BookingRepository)
    const before = await bookingsRepo.count()
    await t.db
      .transaction(async (tx) => {
        await bookingsRepo.using(tx).create({ status: 'deposit_paid' })
        expect(await bookingsRepo.using(tx).count()).toBe(before + 1) // visible inside the transaction
        throw new Error('rollback')
      })
      .catch(() => {})
    expect(await bookingsRepo.count()).toBe(before) // rolled back with it
  })
})
