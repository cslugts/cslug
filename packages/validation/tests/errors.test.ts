import { describe, expect, test } from 'bun:test'
import { formatMessage, interpolate, ValidationError, v } from '../src'

describe('ValidationError', () => {
  test('from issues: status, code, errors by dot path', () => {
    const r = v.object({ budget: v.money() }).safeParse({ budget: { amount: 'x', currency: 'EUR' } })
    expect(r.success).toBe(false)
    if (r.success) return
    expect(r.error.status).toBe(422)
    expect(r.error.code).toBe('validation.failed')
    expect(r.error.errors).toEqual({ 'budget.amount': ['validation.invalid_type'] })
  })

  test('from a field map, as application code throws it', () => {
    const e = new ValidationError({ email: ['auth.failed'], 'payout.account': 'validation.required' })
    expect(e.errors).toEqual({ email: ['auth.failed'], 'payout.account': ['validation.required'] })
    expect(e.issues[1]).toMatchObject({ path: ['payout', 'account'], code: 'required' })
  })

  test('messages: built-in English with params, or a translator', () => {
    const e = v.object({ groupSize: v.int().max(12) }).safeParse({ groupSize: 20 })
    if (e.success) throw new Error('expected failure')
    expect(e.error.messages()).toEqual({ groupSize: ['Must be at most 12.'] })
    const fr: Record<string, string> = { 'validation.int.max': 'Doit être au plus {max}.' }
    expect(e.error.messages((key, params) => (fr[key] ? interpolate(fr[key], params) : undefined))).toEqual({
      groupSize: ['Doit être au plus 12.'],
    })
  })

  test('unknown keys fall back to the key itself; arrays are joined', () => {
    expect(formatMessage({ message: 'bookings.terms_required' })).toBe('bookings.terms_required')
    expect(formatMessage({ message: 'validation.enum', params: { options: ['a', 'b'] } })).toBe('Must be one of: a, b.')
  })
})
