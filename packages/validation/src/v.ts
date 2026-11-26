/**
 * The `v` namespace: `import { v } from '@cslug/validation'`, then `v.object({ … })`, `v.infer<typeof X>`.
 */
import { ArraySchema, ObjectSchema, RecordSchema, type Shape, UnionSchema } from './composites'
import { CountrySchema, CurrencySchema, FileSchema, MoneySchema, PhoneSchema } from './domain'
import {
  BigIntSchema,
  BooleanSchema,
  DateSchema,
  DateTimeSchema,
  EnumSchema,
  LiteralSchema,
  NumberSchema,
  type Primitive,
  StringSchema,
} from './primitives'
import { type Schema, UnknownSchema } from './schema'

/** The parsed type: `v.infer<typeof StoreTodoValidator>`. */
export type infer<T extends Schema> = T['_output']
/** The accepted input type, before parsing (what a form holds): `v.input<typeof StoreTodoValidator>`. */
export type input<T extends Schema> = T['_input']

export const string = () => new StringSchema()
export const email = () => new StringSchema().trim().email()
export const url = () => new StringSchema().trim().url()
export const uuid = () => new StringSchema().uuid()
export const uuid7 = () => new StringSchema().uuid7()
/** A string that must never be logged or shown: redacted by the logger and `cslug config:show`. */
export const secret = () => new StringSchema({ secret: true })
export const number = () => new NumberSchema()
export const int = () => new NumberSchema().int()
/** An integer as bigint; accepts bigint, a safe integer, or a string of digits. */
export const bigint = () => new BigIntSchema()
/** Money in minor units as bigint (`"220000"` → `220000n`). */
export const amount = () => new BigIntSchema()
export const boolean = () => new BooleanSchema()
/** A calendar date, `'YYYY-MM-DD'`. */
export const date = () => new DateSchema()
/** An instant, as a `Date` (ISO 8601 input). */
export const datetime = () => new DateTimeSchema()
export const unknown = () => new UnknownSchema()

const enum_ = <const T extends readonly [string, ...string[]]>(options: T) => new EnumSchema(options)

export { enum_ as enum }
export const literal = <const T extends Primitive>(value: T, options: { message?: string } = {}) =>
  new LiteralSchema(value, options.message)

export const object = <S extends Shape>(shape: S) => new ObjectSchema(shape)
export const array = <T extends Schema>(element: T) => new ArraySchema(element)
export const union = <const T extends readonly [Schema, ...Schema[]]>(options: T) => new UnionSchema(options)
export const record = <T extends Schema>(value: T) => new RecordSchema(value)

export const currency = <const C extends string = string>(only?: readonly C[]) => new CurrencySchema<C>(only)
export const money = <const C extends string = string>(
  options: { currencies?: readonly C[]; min?: bigint | number; max?: bigint | number } = {},
) => new MoneySchema<C>(options)
/** ISO 3166-1 alpha-2, normalised to upper case. */
export const country = () => new CountrySchema()
/** Normalised to E.164 (`+261341234567`). With `defaultCountry`, national numbers are accepted. */
export const phone = (options: { defaultCountry?: string } = {}) => new PhoneSchema(options.defaultCountry)
export const file = (options: { maxSize?: string | number; types?: readonly string[] } = {}) => new FileSchema(options)

/** Schemas that convert strings first: for query strings, form posts and env vars. */
export const coerce = {
  string: () => new StringSchema({ coerce: true }),
  number: () => new NumberSchema({ coerce: true }),
  int: () => new NumberSchema({ coerce: true }).int(),
  /** `'1'`, `'on'`, `'true'`, `'yes'` → true; `'0'`, `'off'`, `'false'`, `'no'`, `''` and absent → false. */
  boolean: () => new BooleanSchema({ coerce: true }),
  bigint: () => new BigIntSchema(),
  /** A Date from an ISO string, a Date, or epoch milliseconds. */
  date: () => new DateTimeSchema({ coerce: true }),
}
