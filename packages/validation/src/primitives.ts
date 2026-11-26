import { settings } from './config'
import { type Ctx, INVALID, type Invalid, type JsonSchema, Schema } from './schema'

const typeOf = (value: unknown) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value)

// ── string ───────────────────────────────────────────────────────────────────────────────────────────
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type StringFormat = 'email' | 'url' | 'uuid' | 'uuid7'
/** Rejected by `v.url()` unless explicitly allowed with `.protocols(...)`. */
const UNSAFE_PROTOCOLS = new Set(['javascript:', 'data:', 'vbscript:', 'file:', 'blob:'])

export class StringSchema extends Schema<string> {
  _run(input: unknown, ctx: Ctx): string | Invalid {
    let value = input
    if (this._def.coerce && value !== undefined && value !== null && typeof value !== 'object') value = String(value)
    if (value === undefined || value === null) return this._issue(ctx, 'required')
    if (typeof value !== 'string')
      return this._issue(ctx, 'invalid_type', { expected: 'string', received: typeOf(value) })
    let s = value
    if (this._def.trim) s = s.trim()
    if (this._def.case === 'lower') s = s.toLowerCase()
    if (this._def.case === 'upper') s = s.toUpperCase()
    const min = this._def.min as number | undefined
    const max = this._def.max as number | undefined
    const length = this._def.length as number | undefined
    if (min !== undefined && s.length < min) return this._issue(ctx, 'string.min', { min })
    if (max !== undefined && s.length > max) return this._issue(ctx, 'string.max', { max })
    if (length !== undefined && s.length !== length) return this._issue(ctx, 'string.length', { length })
    const regex = this._def.regex as RegExp | undefined
    if (regex && !regex.test(s)) return this._issue(ctx, 'string.regex', { pattern: regex.source })
    switch (this._def.format as StringFormat | undefined) {
      case 'email':
        if (!EMAIL.test(s)) return this._issue(ctx, 'email')
        break
      case 'url': {
        if (!URL.canParse(s)) return this._issue(ctx, 'url')
        const protocol = new URL(s).protocol
        const allowed = this._def.protocols as string[] | undefined
        if (allowed ? !allowed.includes(protocol) : UNSAFE_PROTOCOLS.has(protocol)) return this._issue(ctx, 'url')
        break
      }
      case 'uuid':
        if (!UUID.test(s)) return this._issue(ctx, 'uuid')
        break
      case 'uuid7':
        if (!UUID7.test(s)) return this._issue(ctx, 'uuid')
        break
    }
    return s
  }

  min(min: number) {
    return this._with({ min })
  }
  max(max: number) {
    return this._with({ max })
  }
  length(length: number) {
    return this._with({ length })
  }
  /** At least one character (after trimming, if trimmed). */
  nonempty() {
    return this._with({ min: 1 })
  }
  regex(regex: RegExp) {
    return this._with({ regex })
  }
  trim() {
    return this._with({ trim: true })
  }
  toLowerCase() {
    return this._with({ case: 'lower' })
  }
  toUpperCase() {
    return this._with({ case: 'upper' })
  }
  email() {
    return this._with({ format: 'email' })
  }
  /** Any absolute URL (`https://…`, `postgres://…`, `redis://…`) except javascript:, data:, vbscript:, file:, blob:. */
  url() {
    return this._with({ format: 'url' })
  }
  /** Restrict a URL to these protocols, e.g. `.protocols('https:')` for links shown to users. */
  protocols(...protocols: string[]) {
    return this._with({ format: 'url', protocols: protocols.map((p) => (p.endsWith(':') ? p : `${p}:`)) })
  }
  uuid() {
    return this._with({ format: 'uuid' })
  }
  uuid7() {
    return this._with({ format: 'uuid7' })
  }

  _json(): JsonSchema {
    const d = this._def
    const format = { email: 'email', url: 'uri', uuid: 'uuid', uuid7: 'uuid' }[d.format as StringFormat]
    return this._jsonMeta({
      type: 'string',
      ...(d.min !== undefined ? { minLength: d.min } : {}),
      ...(d.max !== undefined ? { maxLength: d.max } : {}),
      ...(d.length !== undefined ? { minLength: d.length, maxLength: d.length } : {}),
      ...(d.regex ? { pattern: (d.regex as RegExp).source } : {}),
      ...(format ? { format } : {}),
    })
  }
}

// ── number / int ─────────────────────────────────────────────────────────────────────────────────────
export class NumberSchema extends Schema<number> {
  _run(input: unknown, ctx: Ctx): number | Invalid {
    let value = input
    if (this._def.coerce && typeof value === 'string' && value.trim() !== '') value = Number(value)
    if (value === undefined || value === null) return this._issue(ctx, 'required')
    const kind = this._def.int ? 'int' : 'number'
    if (typeof value !== 'number' || Number.isNaN(value)) {
      return this._issue(ctx, 'invalid_type', {
        expected: kind === 'int' ? 'whole number' : 'number',
        received: typeOf(input),
      })
    }
    if (!Number.isFinite(value))
      return this._issue(ctx, 'invalid_type', { expected: 'finite number', received: 'infinity' })
    if (this._def.int && !Number.isSafeInteger(value)) return this._issue(ctx, 'int')
    const min = this._def.min as number | undefined
    const max = this._def.max as number | undefined
    if (min !== undefined && value < min) return this._issue(ctx, `${kind}.min`, { min })
    if (max !== undefined && value > max) return this._issue(ctx, `${kind}.max`, { max })
    return value
  }
  int() {
    return this._with({ int: true })
  }
  min(min: number) {
    return this._with({ min })
  }
  max(max: number) {
    return this._with({ max })
  }
  positive() {
    return this._with({ min: this._def.int ? 1 : Number.MIN_VALUE })
  }
  nonnegative() {
    return this._with({ min: 0 })
  }
  _json(): JsonSchema {
    const d = this._def
    return this._jsonMeta({
      type: d.int ? 'integer' : 'number',
      ...(d.min !== undefined ? { minimum: d.min } : {}),
      ...(d.max !== undefined ? { maximum: d.max } : {}),
    })
  }
}

// ── bigint (money minor units) ───────────────────────────────────────────────────────────────────────
/**
 * Integer as `bigint`. Accepts a bigint, a safe integer number, or a string of digits, because JSON has no
 * bigint and amounts travel as strings (`"220000"`).
 */
export class BigIntSchema extends Schema<bigint, bigint | number | string> {
  _run(value: unknown, ctx: Ctx): bigint | Invalid {
    if (value === undefined || value === null) return this._issue(ctx, 'required')
    let n: bigint
    if (typeof value === 'bigint') n = value
    else if (typeof value === 'number' && Number.isSafeInteger(value)) n = BigInt(value)
    else if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) n = BigInt(value.trim())
    else return this._issue(ctx, 'invalid_type', { expected: 'whole number', received: typeOf(value) })
    const min = this._def.min as bigint | undefined
    const max = this._def.max as bigint | undefined
    if (min !== undefined && n < min) return this._issue(ctx, 'bigint.min', { min: String(min) })
    if (max !== undefined && n > max) return this._issue(ctx, 'bigint.max', { max: String(max) })
    return n
  }
  min(min: bigint | number) {
    return this._with({ min: BigInt(min) })
  }
  max(max: bigint | number) {
    return this._with({ max: BigInt(max) })
  }
  nonnegative() {
    return this._with({ min: 0n })
  }
  _json(): JsonSchema {
    return this._jsonMeta({ type: ['string', 'integer'], pattern: '^-?\\d+$' })
  }
}

// ── boolean ──────────────────────────────────────────────────────────────────────────────────────────
const TRUE = new Set(['true', '1', 'on', 'yes'])
const FALSE = new Set(['false', '0', 'off', 'no', ''])

export class BooleanSchema extends Schema<boolean> {
  _run(input: unknown, ctx: Ctx): boolean | Invalid {
    let value = input
    if (this._def.coerce) {
      if (value === undefined || value === null)
        value = false // an unchecked checkbox is absent
      else if (typeof value === 'string' && TRUE.has(value.toLowerCase())) value = true
      else if (typeof value === 'string' && FALSE.has(value.toLowerCase())) value = false
      else if (value === 1 || value === 0) value = value === 1
    }
    if (value === undefined || value === null) return this._issue(ctx, 'required')
    if (typeof value !== 'boolean')
      return this._issue(ctx, 'invalid_type', { expected: 'boolean', received: typeOf(input) })
    return value
  }
  _json(): JsonSchema {
    return this._jsonMeta({ type: 'boolean' })
  }
}

// ── calendar date: 'YYYY-MM-DD' string ───────────────────────────────────────────────────────────────
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/** A calendar date without time, as a `'YYYY-MM-DD'` string. Invalid dates (Feb 30) are rejected. */
export class DateSchema extends Schema<string> {
  _run(value: unknown, ctx: Ctx): string | Invalid {
    if (value === undefined || value === null || value === '') return this._issue(ctx, 'required')
    if (typeof value !== 'string' || !DATE.test(value)) return this._issue(ctx, 'date')
    const d = new Date(`${value}T00:00:00Z`)
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) return this._issue(ctx, 'date')
    const today = settings.today()
    if (this._def.future && !(value > today)) return this._issue(ctx, 'date.future')
    if (this._def.past && !(value < today)) return this._issue(ctx, 'date.past')
    const min = this._def.min as string | undefined
    const max = this._def.max as string | undefined
    if (min && value < min) return this._issue(ctx, 'date.min', { min })
    if (max && value > max) return this._issue(ctx, 'date.max', { max })
    return value
  }
  /** After today (in the app's time zone, via the configured clock). */
  future() {
    return this._with({ future: true })
  }
  past() {
    return this._with({ past: true })
  }
  min(min: string) {
    return this._with({ min })
  }
  max(max: string) {
    return this._with({ max })
  }
  _json(): JsonSchema {
    return this._jsonMeta({ type: 'string', format: 'date' })
  }
}

/** An instant as a `Date`. Accepts a Date, an ISO 8601 string, or (with coerce) epoch milliseconds. */
export class DateTimeSchema extends Schema<Date, Date | string | number> {
  _run(value: unknown, ctx: Ctx): Date | Invalid {
    if (value === undefined || value === null || value === '') return this._issue(ctx, 'required')
    let d: Date | undefined
    if (value instanceof Date) d = value
    else if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) d = new Date(value)
    else if (this._def.coerce && typeof value === 'number') d = new Date(value)
    if (!d || Number.isNaN(d.getTime())) return this._issue(ctx, 'datetime')
    return d
  }
  _json(): JsonSchema {
    return this._jsonMeta({ type: 'string', format: 'date-time' })
  }
}

// ── enum / literal ───────────────────────────────────────────────────────────────────────────────────
export class EnumSchema<const T extends readonly [string, ...string[]]> extends Schema<T[number]> {
  constructor(readonly options: T) {
    super({})
  }
  _run(value: unknown, ctx: Ctx): T[number] | Invalid {
    if (value === undefined || value === null || value === '') return this._issue(ctx, 'required')
    if (typeof value !== 'string' || !this.options.includes(value)) {
      return this._issue(ctx, 'enum', { options: [...this.options] })
    }
    return value as T[number]
  }
  _json(): JsonSchema {
    return this._jsonMeta({ type: 'string', enum: [...this.options] })
  }
}

export type Primitive = string | number | boolean | null

export class LiteralSchema<const T extends Primitive> extends Schema<T> {
  constructor(
    readonly value: T,
    message?: string,
  ) {
    super(message ? { message } : {})
  }
  _run(value: unknown, ctx: Ctx): T | Invalid {
    if (value === this.value) return this.value
    if (value === undefined) return this._issue(ctx, 'required')
    return this._issue(ctx, 'literal', { expected: JSON.stringify(this.value) })
  }
  _json(): JsonSchema {
    return this._jsonMeta({ const: this.value })
  }
}

export { INVALID }
