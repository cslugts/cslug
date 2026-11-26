import { describe, expect, test } from 'bun:test'
import { type Fail, type StandardSchemaV1, ValidationError, Validator, v, validate } from '../src'
import { assertType, type Equal, errorsOfAsync } from './type-helpers'

describe('Validator class', () => {
  class FakeOperators {
    taken = new Set(['taken@example.test'])
    async existsByEmail(email: string) {
      return this.taken.has(email)
    }
  }

  class RegisterOperatorValidator extends Validator {
    constructor(private operators: FakeOperators) {
      super()
    }
    schema = v.object({ email: v.email().toLowerCase(), company: v.string().min(2) })
    async after(data: v.infer<this['schema']>, fail: Fail) {
      if (await this.operators.existsByEmail(data.email)) fail('email', 'validation.unique')
    }
  }

  test('schema first, then after() with the parsed data', async () => {
    const validator = new RegisterOperatorValidator(new FakeOperators())
    const data = await validator.validate({ email: 'NEW@example.test', company: 'Ravinala' })
    expect(data).toEqual({ email: 'new@example.test', company: 'Ravinala' })
    assertType<Equal<typeof data, { email: string; company: string }>>()
    expect(await errorsOfAsync(() => validator.validate({ email: 'taken@example.test', company: 'X1' }))).toEqual({
      email: ['validation.unique'],
    })
  })

  test('after() is skipped when the schema fails', async () => {
    let called = false
    class V extends Validator {
      schema = v.object({ a: v.int() })
      after() {
        called = true
      }
    }
    await expect(new V().validate({ a: 'x' })).rejects.toBeInstanceOf(ValidationError)
    expect(called).toBe(false)
  })
})

describe('validate() and Standard Schema', () => {
  test('validate() takes a schema, a Validator, or any Standard Schema, typed', async () => {
    const n = await validate(v.int(), 3)
    assertType<Equal<typeof n, number>>()

    // a foreign Standard Schema (what Zod/Valibot expose), hand-written here
    const upper: StandardSchemaV1<string, string> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: (x) =>
          typeof x === 'string'
            ? { value: x.toUpperCase() }
            : { issues: [{ message: 'not a string', path: ['name'] }] },
      },
    }
    expect(await validate(upper, 'mg')).toBe('MG')
    const e = await validate(upper, 1).catch((err) => err as ValidationError)
    expect(e).toBeInstanceOf(ValidationError)
    expect((e as ValidationError).errors).toEqual({ name: ['not a string'] })
  })

  test('cslug schemas implement Standard Schema v1', async () => {
    const S = v.object({ size: v.int().max(12) })
    const std = S['~standard']
    expect(std.version).toBe(1)
    expect(std.vendor).toBe('cslug')
    expect(await std.validate({ size: 3 })).toEqual({ value: { size: 3 } })
    expect(await std.validate({ size: 13 })).toEqual({ issues: [{ message: 'Must be at most 12.', path: ['size'] }] })
  })
})
