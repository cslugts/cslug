import { type AnyEventClass, CslugError } from '@cslug/core'
import type { WorkflowContext } from './context'

/** The static settings a workflow class may declare (not declared on `Workflow`, so no `override` is needed). */
export type WorkflowSettings = {
  /** Stored with each run (default: the class name). Keep it when you rename the class while runs are in flight. */
  readonly workflowName?: string
  /** The events `ctx.waitFor()` may wait for: only those are watched. */
  readonly waitsFor?: readonly AnyEventClass[]
}

/** A workflow class. */
export type WorkflowClass<I = unknown, O = unknown> = (abstract new (
  ...args: never[]
) => Workflow<I, O>) &
  WorkflowSettings

/** The input type of a workflow class (the second parameter of its `run`). */
export type InputOf<W> = W extends abstract new (...args: never[]) => Workflow<infer I, unknown> ? I : never

export type StartOptions = {
  /** The run's id (default: a UUIDv7). Starting an id that exists returns that run instead of a new one. */
  id?: string
}

/** What `start()` returns: the run's id, and whether this call created it. */
export type StartedRun = { id: string; created: boolean }

/** Set by `WorkflowProvider`: how `Workflow.start()` reaches the app's `Workflows`. */
export const starter: {
  start?: (workflow: WorkflowClass, input: unknown, options: StartOptions) => Promise<StartedRun>
} = {}

/**
 * A durable workflow: an `@inject()` class with `run(ctx, input)`, replayed from its journal each time the run
 * wakes up (guide 25). Optional statics: `workflowName`, `waitsFor`.
 *
 * ```ts
 * @inject(PaymentGateway)
 * export class BookingDepositWorkflow extends Workflow<{ bookingId: string }> {
 *   static waitsFor = [DepositPaid]
 *   constructor(private gateway: PaymentGateway) { super() }
 *   async run(ctx: WorkflowContext, { bookingId }: { bookingId: string }) { … }
 * }
 * await BookingDepositWorkflow.start({ bookingId }, { id: `deposit:${bookingId}` })
 * ```
 */
export abstract class Workflow<I = unknown, O = unknown> {
  abstract run(ctx: WorkflowContext, input: I): Promise<O>

  /** Start a run (after the current transaction commits; a rollback leaves no run). */
  static start<W extends WorkflowClass<never>>(this: W, input: InputOf<W>, options: StartOptions = {}) {
    if (!starter.start) throw new CslugError('workflow.no_provider', 'Workflows need WorkflowProvider')
    // biome-ignore lint/complexity/noThisInStatic: `this` is the concrete workflow class
    return starter.start(this as unknown as WorkflowClass, input, options)
  }
}

// ── the registry: workflow name → class, for workers ─────────────────────────────────────────────────

const registry = new Map<string, WorkflowClass>()

export const workflowName = (workflow: WorkflowClass): string => workflow.workflowName ?? workflow.name

/** Remember a workflow class by name (start and discovery call this). Two classes with one name is an error. */
export function registerWorkflow(workflow: WorkflowClass): void {
  const name = workflowName(workflow)
  const known = registry.get(name)
  if (known && known !== workflow)
    throw new CslugError('workflow.duplicate', `Two workflow classes are named ${name}: set static workflowName`)
  registry.set(name, workflow)
}

export const findWorkflow = (name: string): WorkflowClass | undefined => registry.get(name)
export const registeredWorkflows = (): WorkflowClass[] => [...registry.values()]

export const isWorkflowClass = (value: unknown): value is WorkflowClass =>
  typeof value === 'function' && value.prototype instanceof Workflow
