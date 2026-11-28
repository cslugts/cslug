import { describe, expect, test } from 'bun:test'
import { ConflictError, CslugError, states } from '../src'

const BookingStatus = states(
  {
    requested: ['proposed', 'cancelled'],
    proposed: ['accepted', 'cancelled'],
    accepted: ['deposit_paid', 'cancelled'],
    deposit_paid: ['completed', 'refunded'],
    completed: [],
    cancelled: [],
    refunded: [],
  },
  { name: 'booking' },
)
type BookingStatus = typeof BookingStatus.type

describe('states() (guide 00)', () => {
  test('values, type, can, next, final, is', () => {
    expect(BookingStatus.values).toEqual([
      'requested',
      'proposed',
      'accepted',
      'deposit_paid',
      'completed',
      'cancelled',
      'refunded',
    ])
    const s: BookingStatus = 'deposit_paid'
    // @ts-expect-error not a state
    const bad: BookingStatus = 'paid'
    expect([s, bad]).toHaveLength(2)
    expect(BookingStatus.can('accepted', 'deposit_paid')).toBe(true)
    expect(BookingStatus.can('accepted', 'completed')).toBe(false)
    expect(BookingStatus.can('nope', 'completed')).toBe(false)
    expect(BookingStatus.can('toString', 'completed')).toBe(false) // own keys only
    expect(BookingStatus.next('deposit_paid')).toEqual(['completed', 'refunded'])
    expect(BookingStatus.final('refunded')).toBe(true)
    expect(BookingStatus.final('accepted')).toBe(false)
    expect(BookingStatus.is('proposed')).toBe(true)
    expect(BookingStatus.is('constructor')).toBe(false)
    expect(BookingStatus.name).toBe('booking')
    expect(Object.isFrozen(BookingStatus)).toBe(true)
  })

  test('assert throws a 409 ConflictError with the name in its code', () => {
    expect(() => BookingStatus.assert('accepted', 'deposit_paid')).not.toThrow()
    try {
      BookingStatus.assert('accepted', 'completed')
      throw new Error('expected a throw')
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictError)
      expect(error).toMatchObject({
        code: 'booking.invalid_transition',
        status: 409,
        params: { from: 'accepted', to: 'completed' },
      })
    }
    expect(() => states({ a: ['b'], b: [] }).assert('b', 'a')).toThrow(
      expect.objectContaining({ code: 'state.invalid_transition' }),
    )
  })

  test('a target that is not a state: a type error, and an error at definition', () => {
    // @ts-expect-error 'shipped' is not one of the states
    expect(() => states({ draft: ['shipped'], sent: [] }, { name: 'order' })).toThrow(CslugError)
  })

  test('transition: onLeave, the change, then onEnter with its result; nothing on an invalid one', async () => {
    const calls: string[] = []
    const Order = states(
      { draft: ['sent'], sent: ['paid'], paid: [] },
      {
        name: 'order',
        onLeave: { draft: ({ from, to, row }) => calls.push(`leave ${from}→${to} ${JSON.stringify(row)}`) },
        onEnter: { sent: ({ row }) => calls.push(`enter sent ${JSON.stringify(row)}`) },
      },
    )
    const result = await Order.transition(
      'draft',
      'sent',
      () => {
        calls.push('change')
        return { status: 'sent' }
      },
      { status: 'draft' },
    )
    expect(result).toEqual({ status: 'sent' })
    expect(calls).toEqual(['leave draft→sent {"status":"draft"}', 'change', 'enter sent {"status":"sent"}'])

    calls.length = 0
    await expect(Order.transition('draft', 'paid', () => calls.push('change'))).rejects.toThrow(ConflictError)
    expect(calls).toEqual([])
  })
})
