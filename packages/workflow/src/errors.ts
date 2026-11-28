import { CslugError } from '@cslug/core'

/** A step failed on its last try; the run fails with it. */
export class StepFailedError extends CslugError {
  constructor(
    readonly step: string,
    cause: unknown,
  ) {
    super('workflow.step_failed', `Step "${step}" failed: ${cause instanceof Error ? cause.message : String(cause)}`, {
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

export const isSuspension = (value: unknown): value is Suspension => value instanceof Suspension
