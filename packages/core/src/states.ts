import { ConflictError, CslugError } from './errors'

/** What a hook gets: the states, and the row (before the change for `onLeave`, after it for `onEnter`). */
export type StateChange<S extends string> = { from: S; to: S; row?: unknown }
export type StateHook<S extends string> = (change: StateChange<S>) => unknown

export type StatesOptions<S extends string> = {
  /** Used in the error code: `booking` → `booking.invalid_transition` (default `state`). */
  name?: string
  /** Run after a row enters a state, in the caller's transaction (`repo.transition`). */
  onEnter?: Partial<Record<S, StateHook<S>>>
  /** Run before a row leaves a state, in the caller's transaction. */
  onLeave?: Partial<Record<S, StateHook<S>>>
}

/** A set of states and the transitions allowed between them (`states()`). */
export type StateMachine<S extends string> = {
  readonly name: string
  /** Every state, for `text().oneOf(Status.values)`. */
  readonly values: readonly S[]
  /** The union of the states, as a type: `type BookingStatus = typeof BookingStatus.type`. Undefined at runtime. */
  readonly type: S
  /** Whether `value` is one of the states. */
  is(value: unknown): value is S
  /** Whether `from → to` is allowed. */
  can(from: string, to: string): boolean
  /** The states reachable from `from` in one step. */
  next(from: S): readonly S[]
  /** True for a state with no way out (`completed`, `cancelled`). */
  final(state: S): boolean
  /** Throw `ConflictError('<name>.invalid_transition', { from, to })` (409) unless `from → to` is allowed. */
  assert(from: string, to: string): void
  /**
   * Check `from → to`, run `onLeave[from]`, `change()`, then `onEnter[to]` with its result; returns that result.
   * `repo.transition()` calls it inside the transaction.
   */
  transition<R>(from: S, to: S, change: () => R | Promise<R>, row?: unknown): Promise<R>
}

/**
 * A state machine in plain TypeScript: each state lists the states it may move to.
 *
 * ```ts
 * export const BookingStatus = states(
 *   { requested: ['proposed', 'cancelled'], proposed: ['accepted', 'cancelled'], accepted: [], cancelled: [] },
 *   { name: 'booking' },
 * )
 * export type BookingStatus = typeof BookingStatus.type
 * BookingStatus.assert('requested', 'accepted') // ConflictError('booking.invalid_transition'), 409
 * ```
 */
export function states<const M extends { [K in keyof M]: readonly (keyof M & string)[] }>(
  transitions: M,
  options: StatesOptions<keyof M & string> = {},
): StateMachine<keyof M & string> {
  type S = keyof M & string
  const name = options.name ?? 'state'
  const table = transitions as Record<string, readonly string[]>
  const values = Object.keys(table) as S[]
  for (const [from, targets] of Object.entries(table))
    for (const to of targets)
      if (!(to in table))
        throw new CslugError('states.unknown_state', `${name}: "${from}" lists "${to}", which is not a state`)
  const has = (value: unknown): value is S => typeof value === 'string' && Object.hasOwn(table, value)
  const machine: StateMachine<S> = {
    name,
    values,
    type: undefined as unknown as S,
    is: has,
    can: (from, to) => has(from) && (table[from] as readonly string[]).includes(to),
    next: (from) => (table[from] ?? []) as readonly S[],
    final: (state) => (table[state]?.length ?? 0) === 0,
    assert(from, to) {
      if (!machine.can(from, to)) throw new ConflictError(`${name}.invalid_transition`, { from, to })
    },
    async transition(from, to, change, row) {
      machine.assert(from, to)
      await options.onLeave?.[from]?.({ from, to, row })
      const result = await change()
      await options.onEnter?.[to]?.({ from, to, row: result })
      return result
    },
  }
  return Object.freeze(machine)
}
