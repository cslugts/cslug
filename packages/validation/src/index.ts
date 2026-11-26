/**
 * @cslug/validation: schemas and validators with a Zod-like API, no dependencies.
 * Standard Schema compatible; every schema exports JSON Schema.
 */

export {
  ArraySchema,
  type ObjectInput,
  type ObjectOutput,
  ObjectSchema,
  RecordSchema,
  type Shape,
  UnionSchema,
} from './composites'
export { configure } from './config'
export {
  CountrySchema,
  CurrencySchema,
  FileSchema,
  MoneySchema,
  type MoneyValue,
  PhoneSchema,
  parseSize,
  sniffType,
} from './domain'
export { formatMessage, type Issue, interpolate, type Translate, ValidationError } from './issue'
export {
  BigIntSchema,
  BooleanSchema,
  DateSchema,
  DateTimeSchema,
  EnumSchema,
  LiteralSchema,
  NumberSchema,
  StringSchema,
} from './primitives'
export {
  type Ctx,
  DefaultSchema,
  type JsonSchema,
  NullableSchema,
  OptionalSchema,
  type RefineOptions,
  type SafeParseResult,
  Schema,
  TransformSchema,
  UnknownSchema,
} from './schema'
export type { StandardSchemaV1 } from './standard-schema'
export * as v from './v'
export { type AfterHook, type Fail, type Output, type Validatable, Validator, validate } from './validator'
