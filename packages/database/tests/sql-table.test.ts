import { describe, expect, test } from 'bun:test'
import {
  amount,
  currency,
  date,
  id,
  integer,
  jsonb,
  type NewRow,
  numeric,
  type Row,
  shortCode,
  sql,
  table,
  text,
  timestamp,
  timestamps,
  uuid,
} from '../src'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
const assertType = <_T extends true>() => {}

const BookingStatus = ['requested', 'accepted', 'deposit_paid'] as const
const bookings = table(
  'bookings',
  {
    id: id(),
    ref: shortCode('ALB'),
    travellerId: uuid(),
    status: text().oneOf(BookingStatus).default('requested'),
    startDate: date(),
    groupSize: integer(),
    currency: currency(),
    deposit: amount(),
    rating: numeric(3, 2).nullable(),
    notes: text().nullable(),
    meta: jsonb<{ source: string }>(),
    paidAt: timestamp().nullable(),
    ...timestamps(),
  },
  { indexes: (t) => [t.index('travellerId'), t.index('status', 'startDate')] },
)
type Booking = Row<typeof bookings>
type NewBooking = NewRow<typeof bookings>

describe('the sql tag', () => {
  test('values become parameters, tables/columns become quoted identifiers, fragments nest', () => {
    const since = new Date('2027-01-01T00:00:00Z')
    const extra = sql`and ${bookings.c.status} = ${'accepted'}`
    const q = sql`select ${bookings.star} from ${bookings} where ${bookings.c.startDate} >= ${'2027-05-01'} ${extra} and ${bookings.c.createdAt} > ${since}`
    expect(q.compile()).toEqual({
      text: 'select "bookings".* from "bookings" where "bookings"."start_date" >= $1 and "bookings"."status" = $2 and "bookings"."created_at" > $3',
      params: ['2027-05-01', 'accepted', since],
    })
  })

  test('user input can never become SQL', () => {
    const evil = "x'; drop table bookings; --"
    expect(sql`select 1 where name = ${evil}`.compile()).toEqual({ text: 'select 1 where name = $1', params: [evil] })
  })

  test('join, ident, raw, json, undefined → null', () => {
    const ids = ['a', 'b', 'c']
    expect(sql`select * from t where id in (${sql.join(ids)})`.compile()).toEqual({
      text: 'select * from t where id in ($1, $2, $3)',
      params: ids,
    })
    expect(sql`set search_path to ${sql.ident('tenant_1')}`.compile().text).toBe('set search_path to "tenant_1"')
    expect(sql`select ${sql.ident('we"ird')}`.compile().text).toBe('select "we""ird"')
    expect(sql`order by 1 ${sql.raw('desc')}`.compile().text).toBe('order by 1 desc')
    expect(sql`select ${sql.json({ a: 1n })}`.compile()).toEqual({
      text: 'select ($1::text)::jsonb',
      params: ['{"a":"1"}'],
    })
    expect(sql`select ${undefined}`.compile().params).toEqual([null])
    expect(sql.join([]).compile().text).toBe('')
  })
})

describe('tables', () => {
  test('Row: every column; nullable as T | null; oneOf narrows; jsonb typed', () => {
    assertType<Equal<Booking['status'], 'requested' | 'accepted' | 'deposit_paid'>>()
    assertType<Equal<Booking['deposit'], bigint>>()
    assertType<Equal<Booking['rating'], string | null>>()
    assertType<Equal<Booking['startDate'], string>>()
    assertType<Equal<Booking['paidAt'], Date | null>>()
    assertType<Equal<Booking['meta'], { source: string }>>()
    assertType<Equal<Booking['createdAt'], Date>>()
  })

  test('NewRow: NOT NULL without default required; defaults, generated and nullable optional', () => {
    type RequiredKeys<T> = { [K in keyof T]-?: undefined extends T[K] ? never : K }[keyof T]
    assertType<
      Equal<RequiredKeys<NewBooking>, 'travellerId' | 'startDate' | 'groupSize' | 'currency' | 'deposit' | 'meta'>
    >()
    const ok: NewBooking = {
      travellerId: 'u',
      startDate: '2027-05-14',
      groupSize: 2,
      currency: 'EUR',
      deposit: 1n,
      meta: { source: 'web' },
    }
    expect(ok.groupSize).toBe(2)
  })

  test('column refs, star, snake_case names, indexes', () => {
    expect(String(sql`${bookings.c.travellerId}`)).toBe('"bookings"."traveller_id"')
    expect(bookings.c.startDate.name).toBe('start_date')
    expect(bookings.indexes.map((i) => i.name)).toEqual(['bookings_traveller_id_idx', 'bookings_status_start_date_idx'])
    expect(bookings.primaryKey).toBe('id')
    expect(bookings.softDeletes).toBe(false)
  })

  test('fromDb: snake → camel; date → YYYY-MM-DD; numeric → string; char(3) trimmed', () => {
    const row = bookings.fromDb({
      start_date: new Date('2027-05-14T00:00:00Z'),
      group_size: 2,
      deposit: 66000n,
      rating: '4.50',
      currency: 'EUR',
      paid_at: null,
    })
    expect(row).toEqual({
      startDate: '2027-05-14',
      groupSize: 2,
      deposit: 66000n,
      rating: '4.50',
      currency: 'EUR',
      paidAt: null,
    } as never)
  })

  test('generated values: UUIDv7 ids, short codes', () => {
    const newId = bookings.columns.id.def.generate?.() as string
    expect(newId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/)
    expect(bookings.columns.ref.def.generate?.()).toMatch(/^ALB-[0-9A-HJKMNP-TV-Z]{6}$/)
  })
})
