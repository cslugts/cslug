import { formatMessage, type Schema, type Shape, v } from '@cslug/validation'
import { currentApp } from './context'
import { CslugError } from './errors'

/**
 * The app's config, typed by the app itself (config/index.ts):
 *
 * ```ts
 * export const configs = { app, database, payments }
 * declare module '@cslug/core' {
 *   interface Config extends Typed<typeof configs> {}
 * }
 * ```
 */
// biome-ignore lint/suspicious/noEmptyInterface: augmented by applications
export interface Config {}

/** Identity type: lets an interface extend `typeof configs`. */
export type Typed<T> = T

type Leaf =
  | readonly unknown[]
  | ((...args: never[]) => unknown)
  | (abstract new (
      ...args: never[]
    ) => unknown)
  | Date
  | RegExp
type Plain<T> = T extends Leaf ? false : T extends object ? true : false

/** `'payments' | 'payments.driver' | 'payments.mangopay.apiKey' | …` */
export type ConfigPath<T> = {
  [K in keyof T & string]: Plain<T[K]> extends true ? K | `${K}.${ConfigPath<T[K]>}` : K
}[keyof T & string]

/** The type at a dotted path. */
export type ConfigValue<T, P extends string> = P extends `${infer Head}.${infer Rest}`
  ? Head extends keyof T
    ? ConfigValue<T[Head], Rest>
    : never
  : P extends keyof T
    ? T[P]
    : never

/** A config file: `export default defineConfig({ … })`. Returns the object as is, typed. */
export function defineConfig<T extends Record<string, unknown>>(config: T): T {
  return config
}

/** Read config: `config('payments.commissionPercent')`, typed from the app's `Config`. */
export function config<P extends ConfigPath<Config>>(key: P): ConfigValue<Config, P> {
  return currentApp().config(key) as ConfigValue<Config, P>
}

/** Value at a dotted path, or undefined. */
export function getPath(source: unknown, path: string): unknown {
  let current = source
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

/** A copy of `source` with `path` set to `value` (only the objects along the path are copied). */
export function setPath<T>(source: T, path: string, value: unknown): T {
  const [head, ...rest] = path.split('.') as [string, ...string[]]
  const base = (source !== null && typeof source === 'object' ? source : {}) as Record<string, unknown>
  return { ...base, [head]: rest.length ? setPath(base[head], rest.join('.'), value) : value } as T
}

/** Freeze plain objects and arrays, recursively. Classes and functions inside config are left alone. */
export function deepFreeze<T>(value: T): T {
  if (
    value &&
    typeof value === 'object' &&
    !Object.isFrozen(value) &&
    (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype)
  ) {
    Object.freeze(value)
    for (const v of Object.values(value)) deepFreeze(v)
  }
  return value
}

// ── env ────────────────────────────────────────────────────────────────────────────────────────────

/** Thrown at start-up when environment variables are missing or invalid. Lists every problem at once. */
export class EnvError extends CslugError {
  constructor(
    readonly problems: { name: string; message: string }[],
    hints: string[],
  ) {
    const width = Math.max(...problems.map((p) => p.name.length)) + 3
    const lines = problems.map((p) => `  ${p.name.padEnd(width)}${p.message}`)
    super('env.invalid', ['✖ Invalid environment', ...lines, ...hints.map((h) => `  ${h}`)].join('\n'))
  }
}

const HINTS: Record<string, string> = {
  APP_KEY: 'Run `cslug key:generate` to create APP_KEY.',
}

/**
 * The environment schema (config/env.ts). Validated immediately, so a bad environment fails at start-up with
 * every problem listed. Empty values (`FOO=`) count as missing. Secret values are never printed.
 *
 * ```ts
 * export const env = defineEnv({
 *   APP_KEY: v.secret().min(32),
 *   DATABASE_URL: v.url(),
 *   SMTP_PORT: v.coerce.int().default(1025),
 * })
 * ```
 */
export function defineEnv<S extends Shape>(
  shape: S,
  source: Record<string, string | undefined> = process.env,
): Readonly<v.infer<ReturnType<typeof v.object<S>>>> {
  const input: Record<string, string | undefined> = {}
  for (const key of Object.keys(shape)) {
    const raw = source[key]
    input[key] = raw === undefined || raw.trim() === '' ? undefined : raw
  }
  const result = v.object(shape).safeParse(input)
  if (!result.success) {
    const problems = result.error.issues.map((i) => {
      const name = String(i.path[0] ?? '(env)')
      const text = formatMessage(i)
      return {
        name,
        message:
          i.code === 'required' ? 'is required' : `${text.charAt(0).toLowerCase()}${text.slice(1).replace(/\.$/, '')}`,
      }
    })
    const hints = [...new Set(problems.map((p) => HINTS[p.name]).filter((h): h is string => !!h))]
    throw new EnvError(problems, hints)
  }
  return Object.freeze(result.data) as Readonly<v.infer<ReturnType<typeof v.object<S>>>>
}

/** Keys of an env shape whose schemas are secrets (for redaction in logs and `cslug config:show`). */
export function secretKeys(shape: Shape): string[] {
  return Object.entries(shape)
    .filter(([, s]) => isSecret(s))
    .map(([k]) => k)
}

const isSecret = (s: Schema): boolean => {
  if (s._def.secret) return true
  const inner = (s as unknown as { inner?: Schema }).inner
  return inner ? isSecret(inner) : false
}
