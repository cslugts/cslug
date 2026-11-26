import { token } from './token'

/** A readiness check: resolves when the dependency is usable, throws otherwise. */
export type HealthCheck = { name: string; check: () => Promise<void> }

/** Container tag under which packages register their checks; `/health/ready` runs them all. */
export const HEALTH_CHECKS = 'health'

const tokens = new Map<string, ReturnType<typeof token<HealthCheck>>>()

/**
 * The token for a named check: the **same** token for the same name, so binding and tagging agree.
 * `app.singleton(healthCheck('database'), () => ({ name: 'database', check: () => db.ping() }))`
 * `app.tag([healthCheck('database')], HEALTH_CHECKS)`
 */
export const healthCheck = (name: string) => {
  let t = tokens.get(name)
  if (!t) {
    t = token<HealthCheck>(`health.${name}`)
    tokens.set(name, t)
  }
  return t
}
