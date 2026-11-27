import { afterEach, describe, expect, test } from 'bun:test'
import { configure, v } from '../src'
import { assertType, type Equal, errorsOf } from './type-helpers'

describe('string', () => {
  test('accepts strings, rejects other types and missing values', () => {
    expect(v.string().parse('a')).toBe('a')
    expect(errorsOf(() => v.string().parse(1))).toEqual({ '': ['validation.invalid_type'] })
    expect(errorsOf(() => v.string().parse(undefined))).toEqual({ '': ['validation.required'] })
    expect(errorsOf(() => v.string().parse(null))).toEqual({ '': ['validation.required'] })
  })

  test('length rules apply after trim', () => {
    const s = v.string().trim().min(2).max(5)
    expect(s.parse('  ab  ')).toBe('ab')
    expect(errorsOf(() => s.parse(' a '))).toEqual({ '': ['validation.string.min'] })
    expect(errorsOf(() => s.parse('abcdef'))).toEqual({ '': ['validation.string.max'] })
    expect(errorsOf(() => v.string().length(3).parse('ab'))).toEqual({ '': ['validation.string.length'] })
  })

  test('case, regex, nonempty', () => {
    expect(v.string().toLowerCase().parse('AbC')).toBe('abc')
    expect(v.string().toUpperCase().parse('mga')).toBe('MGA')
    expect(errorsOf(() => v.string().regex(/^\d+$/).parse('12a'))).toEqual({ '': ['validation.string.regex'] })
    expect(errorsOf(() => v.string().trim().nonempty().parse('   '))).toEqual({ '': ['validation.string.min'] })
  })

  test('email (trimmed), url, uuid, uuid7', () => {
    expect(v.email().toLowerCase().parse('  ADA@Example.TEST ')).toBe('ada@example.test')
    expect(errorsOf(() => v.email().parse('ada@'))).toEqual({ '': ['validation.email'] })
    expect(v.url().parse('https://example.com/fr')).toBe('https://example.com/fr')
    expect(v.url().parse('postgres://u:p@db:5432/app')).toBe('postgres://u:p@db:5432/app')
    expect(v.url().parse('redis://cache:6379/0')).toBe('redis://cache:6379/0')
    for (const bad of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd', 'not a url']) {
      expect(errorsOf(() => v.url().parse(bad))).toEqual({ '': ['validation.url'] })
    }
    expect(errorsOf(() => v.url().protocols('https').parse('http://example.com'))).toEqual({ '': ['validation.url'] })
    expect(v.url().protocols('https:', 'http:').parse('http://example.com')).toBe('http://example.com')
    const id7 = Bun.randomUUIDv7()
    expect(v.uuid7().parse(id7)).toBe(id7)
    expect(v.uuid().parse(crypto.randomUUID())).toBeString()
    expect(errorsOf(() => v.uuid7().parse(crypto.randomUUID()))).toEqual({ '': ['validation.uuid'] })
    expect(errorsOf(() => v.uuid().parse('123'))).toEqual({ '': ['validation.uuid'] })
  })

  test('secret is a string, marked writeOnly in JSON Schema', () => {
    expect(v.secret().min(3).parse('abcd')).toBe('abcd')
    expect(v.secret().toJSONSchema()).toMatchObject({ type: 'string', writeOnly: true })
  })

  test('schemas are immutable', () => {
    const base = v.string()
    const limited = base.max(2)
    expect(base.parse('abcdef')).toBe('abcdef')
    expect(limited.safeParse('abcdef').success).toBe(false)
  })
})

describe('number, int', () => {
  test('rules and messages per kind', () => {
    expect(v.number().min(1.5).parse(2.5)).toBe(2.5)
    expect(errorsOf(() => v.number().max(10).parse(11))).toEqual({ '': ['validation.number.max'] })
    expect(errorsOf(() => v.int().max(12).parse(20))).toEqual({ '': ['validation.int.max'] })
    expect(errorsOf(() => v.int().parse(1.5))).toEqual({ '': ['validation.int'] })
    expect(errorsOf(() => v.number().parse(Number.NaN))).toEqual({ '': ['validation.invalid_type'] })
    expect(errorsOf(() => v.number().parse(Number.POSITIVE_INFINITY))).toEqual({ '': ['validation.invalid_type'] })
    expect(errorsOf(() => v.int().positive().parse(0))).toEqual({ '': ['validation.int.min'] })
  })

  test('strings are not numbers unless coerced', () => {
    expect(errorsOf(() => v.int().parse('3'))).toEqual({ '': ['validation.invalid_type'] })
    expect(v.coerce.int().parse('3')).toBe(3)
    expect(v.coerce.number().parse(' 2.5 ')).toBe(2.5)
    expect(errorsOf(() => v.coerce.int().parse('3.5'))).toEqual({ '': ['validation.int'] })
    expect(errorsOf(() => v.coerce.int().parse('abc'))).toEqual({ '': ['validation.invalid_type'] })
    expect(errorsOf(() => v.coerce.int().parse(''))).toEqual({ '': ['validation.invalid_type'] })
  })
})

describe('bigint / amount', () => {
  test('accepts bigint, safe integers and digit strings; returns bigint', () => {
    expect(v.amount().parse('220000')).toBe(220000n)
    expect(v.amount().parse(150)).toBe(150n)
    expect(v.amount().parse(9007199254740993n)).toBe(9007199254740993n)
    expect(v.amount().parse('-500')).toBe(-500n)
    expect(errorsOf(() => v.amount().parse('12.50'))).toEqual({ '': ['validation.invalid_type'] })
    expect(errorsOf(() => v.amount().parse(12.5))).toEqual({ '': ['validation.invalid_type'] })
    expect(errorsOf(() => v.amount().nonnegative().parse('-1'))).toEqual({ '': ['validation.bigint.min'] })
  })

  test('types: output bigint, input bigint | number | string', () => {
    const a = v.amount()
    assertType<Equal<v.infer<typeof a>, bigint>>()
    assertType<Equal<v.input<typeof a>, bigint | number | string>>()
  })
})

describe('boolean', () => {
  test('strict by default, coerce for forms', () => {
    expect(v.boolean().parse(false)).toBe(false)
    expect(errorsOf(() => v.boolean().parse('true'))).toEqual({ '': ['validation.invalid_type'] })
    for (const t of ['1', 'on', 'true', 'YES']) expect(v.coerce.boolean().parse(t)).toBe(true)
    for (const f of ['0', 'off', 'false', 'no', '', undefined]) expect(v.coerce.boolean().parse(f)).toBe(false)
    expect(errorsOf(() => v.coerce.boolean().parse('maybe'))).toEqual({ '': ['validation.invalid_type'] })
  })
})

describe('date (calendar) and datetime', () => {
  afterEach(() => configure({ today: () => new Date().toISOString().slice(0, 10) }))

  test('YYYY-MM-DD only, real calendar dates only', () => {
    expect(v.date().parse('2027-05-14')).toBe('2027-05-14')
    expect(v.date().parse('2028-02-29')).toBe('2028-02-29')
    for (const bad of ['2027-02-30', '2027-13-01', '14/05/2027', '2027-5-14', '2027-05-14T00:00:00Z']) {
      expect(errorsOf(() => v.date().parse(bad))).toEqual({ '': ['validation.date'] })
    }
    expect(errorsOf(() => v.date().parse(''))).toEqual({ '': ['validation.required'] })
  })

  test('future/past use the configured clock (core sets it from Clock)', () => {
    configure({ today: () => '2027-05-14' })
    expect(v.date().future().parse('2027-05-15')).toBe('2027-05-15')
    expect(errorsOf(() => v.date().future().parse('2027-05-14'))).toEqual({ '': ['validation.date.future'] })
    expect(errorsOf(() => v.date().past().parse('2027-05-14'))).toEqual({ '': ['validation.date.past'] })
    expect(errorsOf(() => v.date().min('2027-06-01').parse('2027-05-31'))).toEqual({ '': ['validation.date.min'] })
  })

  test('datetime gives a Date; coerce.date also accepts epoch ms', () => {
    expect(v.datetime().parse('2027-05-14T06:00:00Z')).toEqual(new Date('2027-05-14T06:00:00Z'))
    expect(v.coerce.date().parse(0)).toEqual(new Date(0))
    expect(errorsOf(() => v.datetime().parse('2027-05-14'))).toEqual({ '': ['validation.datetime'] })
    expect(errorsOf(() => v.datetime().parse('2027-05-14Tnope'))).toEqual({ '': ['validation.datetime'] })
  })
})

describe('enum, literal', () => {
  test('enum from a readonly tuple, typed as the union', () => {
    const Priority = ['low', 'normal', 'high'] as const
    const p = v.enum(Priority)
    expect(p.parse('high')).toBe('high')
    expect(errorsOf(() => p.parse('urgent'))).toEqual({ '': ['validation.enum'] })
    assertType<Equal<v.infer<typeof p>, 'low' | 'normal' | 'high'>>()
    const inline = v.enum(['mvola', 'bank'])
    assertType<Equal<v.infer<typeof inline>, 'mvola' | 'bank'>>()
  })

  test('literal with a custom message key', () => {
    const terms = v.literal(true, { message: 'bookings.terms_required' })
    expect(terms.parse(true)).toBe(true)
    expect(errorsOf(() => terms.parse(false))).toEqual({ '': ['bookings.terms_required'] })
    expect(errorsOf(() => terms.parse(undefined))).toEqual({ '': ['bookings.terms_required'] })
    assertType<Equal<v.infer<typeof terms>, true>>()
  })
})
