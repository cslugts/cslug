import type { Class } from '@cslug/core'
import type { TwoFactorConfig } from './two-factor'

/** What auth needs from the users repository (a cslug `Repository` has both). */
export type UserSource = {
  find(id: unknown): Promise<object | null>
  findBy(where: Record<string, unknown>): Promise<object | null>
  /** Used to store a rehashed password on login; without it the old hash stays. */
  update?(id: unknown, values: object): Promise<unknown>
}

export type AuthConfig = {
  /** The users repository class, or a lazy import of it (avoids import cycles from config files). */
  users: Class<UserSource> | (() => Promise<Class<UserSource>>)
  /** Field names on the user row. Default `email` and `passwordHash`. */
  fields?: { email?: string; password?: string }
  passwords?: {
    algorithm?: 'argon2id' | 'argon2i' | 'argon2d' | 'bcrypt'
    memoryCost?: number
    timeCost?: number
    cost?: number
    rehashOnLogin?: boolean
  }
  magicLinks?: { lifetime?: string | number; singleUse?: boolean }
  /** Rate limit for `attempt()`, per email + IP. Default `'5/min'`. */
  throttle?: string
  /** Where `auth()` sends guests on HTML requests: a route name or path. Default the `login` route, else `/login`. */
  loginRoute?: string
  /** Where `guest()` sends signed-in users. Default `/`. */
  home?: string
  /** TOTP two-factor authentication: issuer, drift window, recovery codes, how long a login waits for its code. */
  twoFactor?: TwoFactorConfig
}

/** True for a `class` (not a lazy-import function): `config.users` accepts both. */
export const isClass = (v: unknown): v is Class =>
  typeof v === 'function' && /^class[\s{]/.test(Function.prototype.toString.call(v))

/** Field value from a user row, by name. */
export const field = (user: object, name: string): unknown => (user as Record<string, unknown>)[name]
/** The user's `id` as a string; throws when the row has none. */
export const idOf = (user: object): string => {
  const id = field(user, 'id')
  if (id === undefined || id === null) throw new Error('The user has no id')
  return String(id)
}
