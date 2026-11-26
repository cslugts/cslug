import { type Ctx, INVALID, type Invalid, type JsonSchema, OptionalSchema, Schema } from './schema'

type Flatten<T> = { [K in keyof T]: T[K] } & {}
export type Shape = Record<string, Schema>

type OptionalOutKeys<S extends Shape> = { [K in keyof S]: undefined extends S[K]['_output'] ? K : never }[keyof S]
type OptionalInKeys<S extends Shape> = { [K in keyof S]: undefined extends S[K]['_input'] ? K : never }[keyof S]

/** Keys whose schema accepts `undefined` become optional (`key?:`), as you would write the type by hand. */
export type ObjectOutput<S extends Shape> = Flatten<
  { [K in Exclude<keyof S, OptionalOutKeys<S>>]: S[K]['_output'] } & { [K in OptionalOutKeys<S>]?: S[K]['_output'] }
>
export type ObjectInput<S extends Shape> = Flatten<
  { [K in Exclude<keyof S, OptionalInKeys<S>>]: S[K]['_input'] } & { [K in OptionalInKeys<S>]?: S[K]['_input'] }
>

type UnknownKeys = 'strip' | 'strict' | 'passthrough'

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date)

export class ObjectSchema<S extends Shape> extends Schema<ObjectOutput<S>, ObjectInput<S>> {
  constructor(
    readonly shape: S,
    def: Record<string, unknown> = {},
  ) {
    super(def)
  }

  _run(value: unknown, ctx: Ctx): ObjectOutput<S> | Invalid {
    if (value === undefined || value === null) return this._issue(ctx, 'required')
    if (!isPlainObject(value)) {
      return this._issue(ctx, 'invalid_type', {
        expected: 'object',
        received: Array.isArray(value) ? 'array' : typeof value,
      })
    }
    const out: Record<string, unknown> = {}
    let ok = true
    for (const [key, schema] of Object.entries(this.shape)) {
      ctx.path.push(key)
      const r = schema._parse(value[key], ctx)
      ctx.path.pop()
      if (r === INVALID) ok = false
      else if (r !== undefined || key in value) out[key] = r
    }
    const mode = (this._def.unknownKeys as UnknownKeys | undefined) ?? 'strip'
    if (mode !== 'strip') {
      const extra = Object.keys(value).filter((k) => !(k in this.shape))
      if (mode === 'strict' && extra.length) {
        this._issue(ctx, 'unrecognized_keys', { keys: extra })
        ok = false
      }
      if (mode === 'passthrough') for (const k of extra) out[k] = value[k]
    }
    return ok ? (out as ObjectOutput<S>) : INVALID
  }

  /** Reject unknown keys (the default is to drop them silently). */
  strict(): this {
    return this._with({ unknownKeys: 'strict' })
  }
  /** Keep unknown keys as they are. */
  passthrough(): this {
    return this._with({ unknownKeys: 'passthrough' })
  }

  /** Every field optional, for PATCH-style updates. Refinements of the original object are not kept. */
  partial(): ObjectSchema<{ [K in keyof S]: OptionalSchema<S[K]> }> {
    const shape = Object.fromEntries(Object.entries(this.shape).map(([k, s]) => [k, s.optional()]))
    return new ObjectSchema(shape as { [K in keyof S]: OptionalSchema<S[K]> }, { unknownKeys: this._def.unknownKeys })
  }

  pick<K extends keyof S & string>(...keys: K[]): ObjectSchema<Pick<S, K>> {
    const shape = Object.fromEntries(keys.map((k) => [k, this.shape[k]]))
    return new ObjectSchema(shape as Pick<S, K>, { unknownKeys: this._def.unknownKeys })
  }

  omit<K extends keyof S & string>(...keys: K[]): ObjectSchema<Omit<S, K>> {
    const shape = Object.fromEntries(Object.entries(this.shape).filter(([k]) => !keys.includes(k as K)))
    return new ObjectSchema(shape as unknown as Omit<S, K>, { unknownKeys: this._def.unknownKeys })
  }

  extend<E extends Shape>(extra: E): ObjectSchema<Flatten<Omit<S, keyof E> & E>> {
    return new ObjectSchema({ ...this.shape, ...extra } as Flatten<Omit<S, keyof E> & E>, {
      unknownKeys: this._def.unknownKeys,
    })
  }

  _json(): JsonSchema {
    const properties: Record<string, JsonSchema> = {}
    const required: string[] = []
    for (const [k, s] of Object.entries(this.shape)) {
      properties[k] = s._json()
      if (!(s instanceof OptionalSchema) && !('fallback' in s)) required.push(k)
    }
    return this._jsonMeta({
      type: 'object',
      properties,
      ...(required.length ? { required } : {}),
      additionalProperties: this._def.unknownKeys === 'passthrough',
    })
  }
}

export class ArraySchema<T extends Schema> extends Schema<T['_output'][], T['_input'][]> {
  constructor(readonly element: T) {
    super({})
  }
  _run(value: unknown, ctx: Ctx): T['_output'][] | Invalid {
    if (value === undefined || value === null) return this._issue(ctx, 'required')
    if (!Array.isArray(value)) return this._issue(ctx, 'invalid_type', { expected: 'array', received: typeof value })
    const min = this._def.min as number | undefined
    const max = this._def.max as number | undefined
    if (min !== undefined && value.length < min) return this._issue(ctx, 'array.min', { min })
    if (max !== undefined && value.length > max) return this._issue(ctx, 'array.max', { max })
    const out: T['_output'][] = []
    let ok = true
    value.forEach((item, i) => {
      ctx.path.push(i)
      const r = this.element._parse(item, ctx)
      ctx.path.pop()
      if (r === INVALID) ok = false
      else out.push(r)
    })
    return ok ? out : INVALID
  }
  min(min: number) {
    return this._with({ min })
  }
  max(max: number) {
    return this._with({ max })
  }
  nonempty() {
    return this._with({ min: 1 })
  }
  _json(): JsonSchema {
    return this._jsonMeta({
      type: 'array',
      items: this.element._json(),
      ...(this._def.min !== undefined ? { minItems: this._def.min } : {}),
      ...(this._def.max !== undefined ? { maxItems: this._def.max } : {}),
    })
  }
}

/** The first matching option wins. If none matches, one `union` issue is reported (not every option's issues). */
export class UnionSchema<T extends readonly [Schema, ...Schema[]]> extends Schema<
  T[number]['_output'],
  T[number]['_input']
> {
  constructor(readonly options: T) {
    super({})
  }
  _run(value: unknown, ctx: Ctx): T[number]['_output'] | Invalid {
    for (const option of this.options) {
      const trial: Ctx = { path: [...ctx.path], issues: [], pending: ctx.pending }
      const r = option._parse(value, trial)
      if (r !== INVALID && trial.issues.length === 0) return r
    }
    return this._issue(ctx, value === undefined ? 'required' : 'union')
  }
  _json(): JsonSchema {
    return this._jsonMeta({ anyOf: this.options.map((o) => o._json()) })
  }
}

/** An object with arbitrary keys whose values all match one schema. */
export class RecordSchema<T extends Schema> extends Schema<Record<string, T['_output']>, Record<string, T['_input']>> {
  constructor(readonly value: T) {
    super({})
  }
  _run(input: unknown, ctx: Ctx): Record<string, T['_output']> | Invalid {
    if (input === undefined || input === null) return this._issue(ctx, 'required')
    if (!isPlainObject(input)) return this._issue(ctx, 'invalid_type', { expected: 'object', received: typeof input })
    const out: Record<string, T['_output']> = {}
    let ok = true
    for (const [k, v] of Object.entries(input)) {
      ctx.path.push(k)
      const r = this.value._parse(v, ctx)
      ctx.path.pop()
      if (r === INVALID) ok = false
      else out[k] = r
    }
    return ok ? out : INVALID
  }
  _json(): JsonSchema {
    return this._jsonMeta({ type: 'object', additionalProperties: this.value._json() })
  }
}
