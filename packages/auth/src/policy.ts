import { type AuthUser, type Class, resolve } from '@cslug/core'

/**
 * Base of policies: one `@inject()` class per resource whose methods `(user, resource, …) => boolean`. An
 * optional `before(user)` runs first; returning true/false decides, undefined continues. (Not declared here,
 * so no `override` is needed.)
 */
export abstract class Policy {}

type Fn = (user: never, ...args: never[]) => unknown
/** The ability names of a policy: its methods, except `before`. */
export type Abilities<P> = Exclude<{ [K in keyof P]: P[K] extends Fn ? K : never }[keyof P], 'before' | 'constructor'> &
  string
/** The arguments of an ability after the user. */
export type AbilityArgs<P, A extends keyof P> = P[A] extends (user: never, ...args: infer R) => unknown ? R : never

type GateFn = (user: AuthUser, ...args: never[]) => boolean | Promise<boolean>

/** Abilities without a resource: `gate.define('admin.access', (user) => user.role === 'admin')`. */
export class Gate {
  private readonly abilities = new Map<string, GateFn>()

  define(name: string, check: (user: AuthUser, ...args: never[]) => boolean | Promise<boolean>): this {
    this.abilities.set(name, check)
    return this
  }

  has(name: string): boolean {
    return this.abilities.has(name)
  }

  async allows(user: AuthUser, name: string, args: unknown[]): Promise<boolean> {
    const check = this.abilities.get(name)
    if (!check) throw new Error(`No gate named "${name}" (define it with gate.define in a provider's boot())`)
    return (await (check as (u: AuthUser, ...a: unknown[]) => boolean | Promise<boolean>)(user, ...args)) === true
  }
}

/**
 * The current app's `Gate` (a static shortcut, D9): `gate.define('admin.access', (user) => user.role === 'admin')` in
 * a provider's `boot()`. Same as `resolve(Gate).define(…)`.
 */
export const gate = {
  define(name: string, check: (user: AuthUser, ...args: never[]) => boolean | Promise<boolean>): Gate {
    return resolve(Gate).define(name, check)
  },
  has: (name: string): boolean => resolve(Gate).has(name),
  allows: (user: AuthUser, name: string, ...args: unknown[]): Promise<boolean> =>
    resolve(Gate).allows(user, name, args),
}

/** Run a policy ability for a user: `before`, then the method. Only `true` allows. */
export async function checkPolicy(policy: object, ability: string, user: AuthUser, args: unknown[]): Promise<boolean> {
  const p = policy as Record<string, (...a: unknown[]) => unknown>
  if (typeof p.before === 'function') {
    const decided = await p.before.call(policy, user, ability, ...args)
    if (decided === true || decided === false) return decided
  }
  const method = p[ability]
  if (typeof method !== 'function') throw new Error(`${policy.constructor.name} has no ability "${ability}"`)
  return (await method.call(policy, user, ...args)) === true
}

export type PolicyClass<P = object> = Class<P>
