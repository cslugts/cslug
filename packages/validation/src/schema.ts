import { formatMessage, type Issue, ValidationError } from './issue'
import type { StandardSchemaV1 } from './standard-schema'

/** Returned by `_run` when the value is invalid (issues were already recorded). */
export const INVALID: unique symbol = Symbol('cslug.invalid')
export type Invalid = typeof INVALID

export type Ctx = {
  path: (string | number)[]
  issues: Issue[]
  /** Async refinements collected during `parseAsync`; null in `parse()` (sync). */
  pending: Promise<void>[] | null
}

export type JsonSchema = Record<string, unknown>

type Refinement<T> = {
  check: (value: T) => boolean | Promise<boolean>
  message: string
  code: string
  path: (string | number)[]
  params?: Record<string, unknown>
  async: boolean
}

export type Def = {
  description?: string
  /** Custom message key used for every issue this schema reports (e.g. `bookings.terms_required`). */
  message?: string
  secret?: boolean
  // biome-ignore lint/suspicious/noExplicitAny: refinements of any output type
  refines?: Refinement<any>[]
  [key: string]: unknown
}

export type RefineOptions = { message?: string; path?: (string | number)[]; params?: Record<string, unknown> }

export type SafeParseResult<T> = { success: true; data: T } | { success: false; error: ValidationError }

/**
 * Base class of every cslug schema. Schemas are immutable: every modifier returns a new schema.
 * `Out` is the parsed type (`v.infer`), `In` the accepted input type (`v.input`).
 */
export abstract class Schema<Out = unknown, In = Out> implements StandardSchemaV1<In, Out> {
  declare readonly _output: Out
  declare readonly _input: In
  _def: Def

  constructor(def: Def = {}) {
    this._def = def
  }

  /** Validate the type and the schema's own rules. Record issues in `ctx` and return INVALID on failure. */
  abstract _run(value: unknown, ctx: Ctx): Out | Invalid

  /** JSON Schema for this schema alone (no `$schema`). */
  abstract _json(): JsonSchema

  /** Run the schema and its refinements. */
  _parse(value: unknown, ctx: Ctx): Out | Invalid {
    const result = this._run(value, ctx)
    if (result === INVALID) return result
    for (const r of this._def.refines ?? []) {
      const at = [...ctx.path, ...r.path]
      const report = () => {
        ctx.issues.push({ path: at, code: r.code, message: r.message, params: r.params })
      }
      if (r.async) {
        if (!ctx.pending) throw new Error('This schema has async refinements: use parseAsync() instead of parse().')
        ctx.pending.push(Promise.resolve(r.check(result)).then((ok) => (ok ? undefined : report())))
        continue
      }
      if (!(r.check(result) as boolean)) report()
    }
    return result
  }

  /** Record an issue at the current path, using the schema's custom message if it has one. */
  protected _issue(ctx: Ctx, code: string, params?: Record<string, unknown>): Invalid {
    ctx.issues.push({ path: [...ctx.path], code, message: this._def.message ?? `validation.${code}`, params })
    return INVALID
  }

  /** Clone with a patched definition (schemas are immutable). */
  protected _with(patch: Def): this {
    const copy = Object.create(Object.getPrototypeOf(this)) as this
    Object.assign(copy, this)
    copy._def = { ...this._def, ...patch }
    return copy
  }

  /** Parse or throw `ValidationError`. */
  parse(value: unknown): Out {
    const ctx: Ctx = { path: [], issues: [], pending: null }
    const result = this._parse(value, ctx)
    if (ctx.issues.length || result === INVALID) throw new ValidationError(ctx.issues)
    return result
  }

  /** Parse with async refinements (for example a file's type sniffed from its bytes). */
  async parseAsync(value: unknown): Promise<Out> {
    const ctx: Ctx = { path: [], issues: [], pending: [] }
    const result = this._parse(value, ctx)
    await Promise.all(ctx.pending ?? [])
    if (ctx.issues.length || result === INVALID) throw new ValidationError(ctx.issues)
    return result
  }

  safeParse(value: unknown): SafeParseResult<Out> {
    try {
      return { success: true, data: this.parse(value) }
    } catch (e) {
      if (e instanceof ValidationError) return { success: false, error: e }
      throw e
    }
  }

  // ── modifiers ────────────────────────────────────────────────────────────────────────────────────
  optional(): OptionalSchema<this> {
    return new OptionalSchema(this)
  }

  nullable(): NullableSchema<this> {
    return new NullableSchema(this)
  }

  /** Value used when the input is `undefined`. Pass a function for fresh objects/arrays. */
  default(value: Exclude<Out, undefined> | (() => Exclude<Out, undefined>)): DefaultSchema<this> {
    return new DefaultSchema(this, value)
  }

  /** Human description, exported to JSON Schema (and so to AI tools and OpenAPI). */
  describe(description: string): this {
    return this._with({ description })
  }

  /** Extra rule on the parsed value. Fails with `message` (a translation key) at `path` (relative). */
  refine(check: (value: Out) => boolean, options: RefineOptions = {}): this {
    return this._addRefine(check, options, false)
  }

  /** Async rule; requires `parseAsync()`. */
  refineAsync(check: (value: Out) => Promise<boolean>, options: RefineOptions = {}): this {
    return this._addRefine(check, options, true)
  }

  protected _addRefine(check: Refinement<Out>['check'], options: RefineOptions, async: boolean): this {
    const refinement: Refinement<Out> = {
      check,
      message: options.message ?? this._def.message ?? 'validation.custom',
      code: 'custom',
      path: options.path ?? [],
      params: options.params,
      async,
    }
    return this._with({ refines: [...(this._def.refines ?? []), refinement] })
  }

  /** Map the parsed value to another type. */
  transform<T>(fn: (value: Out) => T): TransformSchema<T, In> {
    return new TransformSchema<T, In>(this as unknown as Schema<unknown, In>, fn as (value: unknown) => T)
  }

  /** JSON Schema (draft 2020-12) describing the accepted input. */
  toJSONSchema(): JsonSchema {
    return { $schema: 'https://json-schema.org/draft/2020-12/schema', ...this._json() }
  }

  /** Shared JSON Schema fields: description, writeOnly for secrets. */
  protected _jsonMeta(schema: JsonSchema): JsonSchema {
    return {
      ...schema,
      ...(this._def.description ? { description: this._def.description } : {}),
      ...(this._def.secret ? { writeOnly: true } : {}),
    }
  }

  // ── Standard Schema ──────────────────────────────────────────────────────────────────────────────
  get '~standard'(): StandardSchemaV1.Props<In, Out> {
    return {
      version: 1,
      vendor: 'cslug',
      validate: async (value: unknown) => {
        try {
          return { value: await this.parseAsync(value) }
        } catch (e) {
          if (!(e instanceof ValidationError)) throw e
          return { issues: e.issues.map((i) => ({ message: formatMessage(i), path: i.path })) }
        }
      },
    }
  }
}

/** `undefined` is accepted and returned as is. */
export class OptionalSchema<S extends Schema> extends Schema<S['_output'] | undefined, S['_input'] | undefined> {
  constructor(readonly inner: S) {
    super({})
  }
  _run(value: unknown, ctx: Ctx) {
    return value === undefined ? undefined : this.inner._parse(value, ctx)
  }
  _json() {
    return this._jsonMeta(this.inner._json())
  }
}

/** `null` is accepted and returned as is. */
export class NullableSchema<S extends Schema> extends Schema<S['_output'] | null, S['_input'] | null> {
  constructor(readonly inner: S) {
    super({})
  }
  _run(value: unknown, ctx: Ctx) {
    return value === null ? null : this.inner._parse(value, ctx)
  }
  _json() {
    return this._jsonMeta({ anyOf: [this.inner._json(), { type: 'null' }] })
  }
}

/** `undefined` becomes the default value; the output is never undefined. */
export class DefaultSchema<S extends Schema> extends Schema<Exclude<S['_output'], undefined>, S['_input'] | undefined> {
  constructor(
    readonly inner: S,
    readonly fallback: Exclude<S['_output'], undefined> | (() => Exclude<S['_output'], undefined>),
  ) {
    super({})
  }
  _run(value: unknown, ctx: Ctx) {
    if (value === undefined) {
      return typeof this.fallback === 'function'
        ? (this.fallback as () => Exclude<S['_output'], undefined>)()
        : this.fallback
    }
    return this.inner._parse(value, ctx) as Exclude<S['_output'], undefined> | Invalid
  }
  _json() {
    const fallback = typeof this.fallback === 'function' ? undefined : this.fallback
    const serializable = typeof fallback === 'bigint' ? String(fallback) : fallback
    return this._jsonMeta({ ...this.inner._json(), ...(serializable === undefined ? {} : { default: serializable }) })
  }
}

export class TransformSchema<Out, In> extends Schema<Out, In> {
  constructor(
    readonly inner: Schema<unknown, In>,
    readonly fn: (value: unknown) => Out,
  ) {
    super({})
  }
  _run(value: unknown, ctx: Ctx) {
    const r = this.inner._parse(value, ctx)
    return r === INVALID ? r : this.fn(r)
  }
  _json() {
    return this._jsonMeta(this.inner._json())
  }
}

/** Accepts anything (escape hatch). */
export class UnknownSchema extends Schema<unknown> {
  _run(value: unknown) {
    return value
  }
  _json() {
    return this._jsonMeta({})
  }
}
