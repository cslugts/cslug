import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Application, ConflictError, inject, runInContext, states } from '@cslug/core'
import { amount, Database, id, Repository, sql, table, text } from '../src'
import { describeDb, testDatabase } from './support'

const calls: string[] = []
const BookingStatus = states(
  {
    accepted: ['deposit_paid', 'cancelled'],
    deposit_paid: ['completed', 'refunded'],
    completed: [],
    cancelled: [],
    refunded: [],
  },
  {
    name: 'booking',
    onLeave: { accepted: ({ row }) => calls.push(`leave accepted (${(row as { status: string }).status})`) },
    onEnter: { deposit_paid: ({ row }) => calls.push(`enter deposit_paid (${(row as { status: string }).status})`) },
  },
)

const bookings = table('bookings', {
  id: id(),
  status: text().oneOf(BookingStatus.values).default('accepted'),
  deposit: amount().default(0n),
})
const ledger = table('ledger', { id: id(), bookingId: text(), amount: amount() })

@inject()
class BookingRepository extends Repository(bookings) {}
@inject()
class LedgerRepository extends Repository(ledger) {}

let t: Awaited<ReturnType<typeof testDatabase>>
let app: Application
const inApp = <T>(fn: () => Promise<T>) => runInContext({ app, scope: app.createScope() }, fn)
const repo = <R>(cls: new () => R) => app.createScope().resolve(cls as never) as R

describeDb('repo.transition() (guide 00, real PostgreSQL)', () => {
  beforeAll(async () => {
    t = await testDatabase()
    app = new Application().instance(Database, t.db)
    await t.db.exec(
      sql`create table bookings (id uuid primary key, status text not null, deposit bigint not null default 0)`,
    )
    await t.db.exec(sql`create table ledger (id uuid primary key, booking_id text not null, amount bigint not null)`)
  })
  afterAll(async () => {
    await t?.drop()
  })

  /** Without a context of its own: inside `t.db.transaction`, it runs in that transaction. */
  const deposit = (bookingId: string, amount: bigint) =>
    repo(BookingRepository).transition(bookingId, 'status', BookingStatus, 'deposit_paid', async (booking, from) => {
      calls.push(`fn from ${from}`)
      await repo(BookingRepository).update(booking.id, { deposit: amount })
      await repo(LedgerRepository).create({ bookingId, amount })
    })
  const confirmDeposit = (bookingId: string, amount: bigint) => inApp(() => deposit(bookingId, amount))

  test('moves the row: onLeave, update, onEnter, then fn, in one transaction of its own', async () => {
    calls.length = 0
    const b = await inApp(() => repo(BookingRepository).create({}))
    const moved = await confirmDeposit(b.id, 66_000n)
    expect(moved.status).toBe('deposit_paid')
    expect(calls).toEqual(['leave accepted (accepted)', 'enter deposit_paid (deposit_paid)', 'fn from accepted'])
    expect((await inApp(() => repo(BookingRepository).findOrFail(b.id))).deposit).toBe(66_000n)
  })

  test('already there: the row as it is, no hooks, no fn (safe to repeat)', async () => {
    const b = await inApp(() => repo(BookingRepository).create({}))
    await confirmDeposit(b.id, 66_000n)
    calls.length = 0
    const again = await confirmDeposit(b.id, 99_000n)
    expect(again).toMatchObject({ status: 'deposit_paid', deposit: 66_000n })
    expect(calls).toEqual([])
    expect(await inApp(() => repo(LedgerRepository).count({ bookingId: b.id }))).toBe(1)
  })

  test('an invalid transition is a 409 and changes nothing', async () => {
    const b = await inApp(() => repo(BookingRepository).create({ status: 'cancelled' }))
    calls.length = 0
    const error = await confirmDeposit(b.id, 1n).catch((e) => e)
    expect(error).toBeInstanceOf(ConflictError)
    expect(error).toMatchObject({
      code: 'booking.invalid_transition',
      params: { from: 'cancelled', to: 'deposit_paid' },
    })
    expect(calls).toEqual([])
    expect((await inApp(() => repo(BookingRepository).findOrFail(b.id))).status).toBe('cancelled')
  })

  test('fn throws: the state change rolls back with it; inside an outer transaction, it is part of it', async () => {
    const b = await inApp(() => repo(BookingRepository).create({}))
    await expect(
      inApp(() =>
        repo(BookingRepository).transition(b.id, 'status', BookingStatus, 'deposit_paid', () => {
          throw new Error('gateway down')
        }),
      ),
    ).rejects.toThrow('gateway down')
    expect((await inApp(() => repo(BookingRepository).findOrFail(b.id))).status).toBe('accepted')

    await expect(
      inApp(() =>
        t.db.transaction(async () => {
          await deposit(b.id, 5n)
          throw new Error('later failure')
        }),
      ),
    ).rejects.toThrow('later failure')
    expect((await inApp(() => repo(BookingRepository).findOrFail(b.id))).status).toBe('accepted')
    expect(await inApp(() => repo(LedgerRepository).count({ bookingId: b.id }))).toBe(0)
  })

  test('acceptance: the same deposit confirmed twice at once → one ledger entry (row lock)', async () => {
    const b = await inApp(() => repo(BookingRepository).create({}))
    calls.length = 0
    const slow = () =>
      inApp(() =>
        repo(BookingRepository).transition(b.id, 'status', BookingStatus, 'deposit_paid', async (booking) => {
          await Bun.sleep(30) // the window where a race would record twice
          await repo(LedgerRepository).create({ bookingId: booking.id, amount: 66_000n })
        }),
      )
    await Promise.all([slow(), slow()])
    expect(await inApp(() => repo(LedgerRepository).count({ bookingId: b.id }))).toBe(1)
    expect(calls.filter((c) => c.startsWith('enter'))).toHaveLength(1)
  })
})
