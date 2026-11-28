import { CslugError } from '@cslug/core'

/** The message of an error, or of an error stored as JSON. */
const messageOf = (cause: unknown) =>
  typeof (cause as { message?: unknown })?.message === 'string' ? (cause as { message: string }).message : String(cause)

/** A step failed on its last try; the run fails with it. */
export class StepFailedError extends CslugError {
  constructor(
    readonly step: string,
    cause: unknown,
  ) {
    super('workflow.step_failed', `Step "${step}" failed: ${messageOf(cause)}`, {
      cause,
    })
  }
}

/** The code no longer matches the run's journal (a call renamed, removed or moved before where the run is). */
export class NondeterminismError extends CslugError {
  constructor(seq: number, expected: string, found: string) {
    super(
      'workflow.nondeterministic',
      `Call #${seq + 1} is "${found}" in the code but "${expected}" in the run's journal: steps before where a run is must not change (guide 25)`,
    )
  }
}

/**
 * Thrown by `ctx` calls to stop a replay where the run must wait. Not an `Error`: let it through (a `catch`
 * around `ctx` calls must rethrow it, or check `isSuspension`).
 */
export class Suspension {
  constructor(
    readonly status: 'sleeping' | 'waiting',
    readonly wakeAt: Date | null,
    readonly waitingFor?: string,
    readonly match?: Record<string, unknown>,
  ) {}
}

/** Thrown by `ctx` calls of a run being cancelled, at the first call that has not run yet. */
export class Cancellation {}

/** A compensation failed on its last try. */
export class CompensationFailedError extends CslugError {
  constructor(
    readonly step: string,
    cause: unknown,
  ) {
    super('workflow.compensation_failed', `Compensating "${step}" failed: ${messageOf(cause)}`, { cause })
  }
}

/** True for what `ctx` throws to stop a replay (a suspension or a cancellation): rethrow it from a `catch`. */
export const isSuspension = (value: unknown): value is Suspension | Cancellation =>
  value instanceof Suspension || value instanceof Cancellation
