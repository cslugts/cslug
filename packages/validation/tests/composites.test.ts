import { describe, expect, test } from 'bun:test'
import { v } from '../src'
import { assertType, type Equal, errorsOf } from './type-helpers'

describe('object', () => {
  const Todo = v.object({
    title: v.string().trim().min(1),
    notes: v.string().optional(),
    priority: v.enum(['low', 'normal', 'high']).default('normal'),
    dueOn: v.date().nullable(),
  })

  test('parses, applies defaults, strips unknown keys', () => {
    expect(Todo.parse({ title: ' Buy bread ', dueOn: null, hacker: true })).toEqual({
      title: 'Buy bread',
      priority: 'normal',
      dueOn: null,
    })
  })

  test('reports every invalid field at its path', () => {
    expect(errorsOf(() => Todo.parse({ title: '', priority: 'urgent' }))).toEqual({
      title: ['validation.string.min'],
      priority: ['validation.enum'],
      dueOn: ['validation.required'],
    })
  })

  test('types: optional and defaulted keys', () => {
    assertType<
      Equal<
        v.infer<typeof Todo>,
        { title: string; priority: 'low' | 'normal' | 'high'; dueOn: string | null; notes?: string | undefined }
      >
    >()
    assertType<
      Equal<
        v.input<typeof Todo>,
        {
          title: string
          dueOn: string | null
          notes?: string | undefined
          priority?: 'low' | 'normal' | 'high' | undefined
        }
      >
    >()
  })

  test('strict rejects unknown keys; passthrough keeps them', () => {
    expect(errorsOf(() => Todo.strict().parse({ title: 'a', dueOn: null, x: 1 }))).toEqual({
      '': ['validation.unrecognized_keys'],
    })
    expect(Todo.passthrough().parse({ title: 'a', dueOn: null, x: 1 })).toMatchObject({ x: 1 })
  })

  test('partial (PATCH): all optional, defaults not applied to missing keys', () => {
    const Patch = Todo.partial()
    expect(Patch.parse({ notes: 'x' })).toEqual({ notes: 'x' })
    expect(errorsOf(() => Patch.parse({ title: '' }))).toEqual({ title: ['validation.string.min'] })
    assertType<Equal<v.infer<typeof Patch>['title'], string | undefined>>()
  })

  test('pick, omit, extend', () => {
    expect(Object.keys(Todo.pick('title', 'notes').shape)).toEqual(['title', 'notes'])
    expect(Object.keys(Todo.omit('notes').shape)).toEqual(['title', 'priority', 'dueOn'])
    const WithTag = Todo.extend({ tag: v.string() })
    expect(WithTag.parse({ title: 'a', dueOn: null, tag: 't' }).tag).toBe('t')
  })

  test('refine on the object with a path (password confirmation)', () => {
    const Register = v
      .object({ password: v.string().min(3), passwordConfirmation: v.string() })
      .refine((d) => d.password === d.passwordConfirmation, {
        path: ['passwordConfirmation'],
        message: 'auth.password_mismatch',
      })
    expect(Register.parse({ password: 'abc', passwordConfirmation: 'abc' })).toBeTruthy()
    expect(errorsOf(() => Register.parse({ password: 'abc', passwordConfirmation: 'abd' }))).toEqual({
      passwordConfirmation: ['auth.password_mismatch'],
    })
  })

  test('nested paths', () => {
    const S = v.object({ payout: v.object({ method: v.enum(['mvola', 'bank']), account: v.string() }) })
    expect(errorsOf(() => S.parse({ payout: { method: 'cash' } }))).toEqual({
      'payout.method': ['validation.enum'],
      'payout.account': ['validation.required'],
    })
  })

  test('rejects arrays, dates and primitives as objects', () => {
    for (const bad of [[], new Date(), 'x', 3])
      expect(errorsOf(() => Todo.parse(bad))).toEqual({ '': ['validation.invalid_type'] })
  })
})

describe('array, union, record', () => {
  test('array rules and item paths', () => {
    const Interests = v
      .array(v.enum(['wildlife', 'hiking']))
      .max(1)
      .default([])
    expect(Interests.parse(undefined)).toEqual([])
    expect(errorsOf(() => Interests.parse(['wildlife', 'hiking']))).toEqual({ '': ['validation.array.max'] })
    expect(errorsOf(() => v.array(v.int()).parse([1, 'x', 3]))).toEqual({ '1': ['validation.invalid_type'] })
    expect(errorsOf(() => v.array(v.int()).nonempty().parse([]))).toEqual({ '': ['validation.array.min'] })
  })

  test('default with a function gives a fresh value each time', () => {
    const S = v.array(v.string()).default(() => [])
    const a = S.parse(undefined)
    a.push('x')
    expect(S.parse(undefined)).toEqual([])
  })

  test('union: first match wins, one issue when none matches', () => {
    const Id = v.union([v.uuid(), v.int()])
    expect(Id.parse(3)).toBe(3)
    expect(errorsOf(() => Id.parse('nope'))).toEqual({ '': ['validation.union'] })
    assertType<Equal<v.infer<typeof Id>, string | number>>()
  })

  test('record', () => {
    const Translated = v.record(v.string())
    expect(Translated.parse({ fr: 'Bonjour', en: 'Hello' })).toEqual({ fr: 'Bonjour', en: 'Hello' })
    expect(errorsOf(() => Translated.parse({ fr: 1 }))).toEqual({ fr: ['validation.invalid_type'] })
  })

  test('transform', () => {
    const Csv = v.string().transform((s) => s.split(','))
    expect(Csv.parse('a,b')).toEqual(['a', 'b'])
    assertType<Equal<v.infer<typeof Csv>, string[]>>()
  })
})
