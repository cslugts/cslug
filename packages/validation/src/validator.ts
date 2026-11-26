import { type Issue, ValidationError } from './issue'
import { Schema } from './schema'
import type { StandardSchemaV1 } from './standard-schema'

/** Add an error from `Validator.after()`: `fail('email', 'validation.unique')`. */
export type Fail = (path: string, message: string, params?: Record<string, unknown>) => void

/** The optional hook a Validator subclass may define: runs after the schema passed, with the parsed data. */
export type AfterHook = (data: never, fail: Fail) => void | Promise<void>

/**
 * A validator class, for validation that needs services (database checks) or custom messages. The container
 * builds it (constructor injection with `@inject(...)`), so it can use repositories.
 *
 * ```ts
 * @inject(OperatorRepository)
 * export class RegisterOperatorValidator extends Validator {
 *   constructor(private operators: OperatorRepository) { super() }
 *   schema = v.object({ email: v.email() })
 *   async after(data: v.infer<this['schema']>, fail: Fail) {
 *     if (await this.operators.existsBy({ email: data.email })) fail('email', 'validation.unique')
 *   }
 * }
 * ```
 */
export abstract class Validator {
  abstract readonly schema: Schema

  // `after(data, fail)` is an optional hook that subclasses may define. It is deliberately NOT declared here, so
  // that apps compiled with `noImplicitOverride` don't have to write `override after(...)`.

  /** Parse with the schema, then run `after`. Throws `ValidationError` with every problem found. */
  async validate(input: unknown): Promise<this['schema']['_output']> {
    const data = await this.schema.parseAsync(input)
    const after = (this as { after?: AfterHook }).after
    if (typeof after !== 'function') return data
    const issues: Issue[] = []
    const fail: Fail = (path, message, params) => {
      issues.push({ path: path === '' ? [] : path.split('.'), code: 'custom', message, params })
    }
    await after.call(this, data as never, fail)
    if (issues.length) throw new ValidationError(issues)
    return data
  }
}

/** What `validate()` accepts: a cslug schema, a Validator instance, or any Standard Schema (Zod, Valibot, …). */
export type Validatable = Schema | Validator | StandardSchemaV1

/** The parsed type of a validatable. */
export type Output<T> =
  T extends Schema<infer O, unknown>
    ? O
    : T extends Validator
      ? T['schema']['_output']
      : T extends StandardSchemaV1
        ? StandardSchemaV1.InferOutput<T>
        : never

/**
 * Validate input against a schema, a Validator instance or a Standard Schema. Always async (file sniffing,
 * `after()` hooks). Used by `request.validate()`, job payloads and AI tool inputs.
 */
export async function validate<T extends Validatable>(target: T, input: unknown): Promise<Output<T>> {
  if (target instanceof Schema) return (await target.parseAsync(input)) as Output<T>
  if (target instanceof Validator) return (await target.validate(input)) as Output<T>
  const result = await target['~standard'].validate(input)
  if (result.issues) {
    throw new ValidationError(
      result.issues.map((i) => ({
        path: (i.path ?? []).map((p) => {
          const key = typeof p === 'object' ? p.key : p
          return typeof key === 'number' ? key : String(key)
        }),
        code: 'custom',
        message: i.message,
      })),
    )
  }
  return result.value as Output<T>
}
