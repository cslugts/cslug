import {
  type AnyEventClass,
  type Application,
  Clock,
  currentContext,
  EventBus,
  Logger,
  NotFoundError,
  resolve,
} from '@cslug/core'
import { Database } from '@cslug/database'
import { Job, Outbox } from '@cslug/queue'
import { WorkflowContext } from './context'
import { Cancellation, NondeterminismError, Suspension } from './errors'
import { errorJson, toJson } from './json'
import { FINISHED, type RunStatus, type WorkflowRun, WorkflowStore } from './store'
import {
  findWorkflow,
  registerWorkflow,
  type StartedRun,
  type StartOptions,
  type WorkflowClass,
  workflowName,
} from './workflow'

/** Wakes a run up: replays it from its journal (one at a time per run). */
export class WorkflowResumeJob extends Job<{ runId: string; wakeAt?: string }> {
  static jobName = 'cslug.workflow.resume'
  static tries = 5
  static timeout = '1h'

  async handle({ runId, wakeAt }: { runId: string; wakeAt?: string }) {
    await resolve(Workflows).resume(runId, { wakeAt })
  }
}

/**
 * Starts, resumes, signals, finds and cancels workflow runs (guide 25). Runs are rows in `cslug_workflow_runs`; their
 * journals in `cslug_workflow_steps`.
 */
export class Workflows {
  readonly store: WorkflowStore
  private readonly watched = new Set<AnyEventClass>()

  constructor(private readonly app: Application) {
    this.store = new WorkflowStore(() => app.resolve(Database))
  }

  /** Start a run of `workflow` (idempotent by `id`); it begins after the current transaction commits. */
  async start(workflow: WorkflowClass, input: unknown, options: StartOptions = {}): Promise<StartedRun> {
    this.register(workflow)
    const id = options.id ?? Bun.randomUUIDv7()
    const created = await this.store.insert(id, workflowName(workflow), toJson(input))
    if (created) await this.wake(id, undefined, true)
    return { id, created }
  }

  /** Send a signal to a run: `ctx.waitForSignal(name)` returns `data`. Kept until the run asks for it. */
  async signal(runId: string, name: string, data?: unknown): Promise<void> {
    const run = await this.store.find(runId)
    if (!run) throw new NotFoundError('workflow_run', runId)
    if (FINISHED.includes(run.status)) return
    await this.store.addSignal(runId, `signal:${name}`, toJson(data))
    await this.wake(runId)
  }

  find(runId: string): Promise<WorkflowRun | null> {
    return this.store.find(runId)
  }

  /**
   * Cancel a run that has not finished: it is `cancelling` until its next wake-up (queued now), which undoes its
   * finished steps (their `compensate`) and ends it `cancelled`. False when it had finished or was being cancelled.
   */
  async cancel(runId: string): Promise<boolean> {
    if (!(await this.store.cancel(runId))) return false
    await this.wake(runId)
    return true
  }

  /** Remember a workflow class, and watch the events it waits for. */
  register(workflow: WorkflowClass): void {
    registerWorkflow(workflow)
    for (const event of workflow.waitsFor ?? []) this.watch(event)
  }

  /** Runs waiting for this event (and whose match the payload contains) get it, and wake up. */
  private watch(event: AnyEventClass): void {
    if (this.watched.has(event)) return
    this.watched.add(event)
    const channel = `event:${event.eventName}`
    this.app.resolve(EventBus).on(event as never, async (payload: unknown) => {
      const data = toJson(payload)
      for (const runId of await this.store.waitingFor(channel, data)) {
        await this.store.addSignal(runId, channel, data)
        await this.wake(runId)
      }
    })
  }

  /** Queue a resume (now, or at `at`); durable through the outbox when started inside a transaction. */
  private async wake(runId: string, at?: Date, durable = false): Promise<void> {
    const dispatch = WorkflowResumeJob.dispatch(at ? { runId, wakeAt: at.toISOString() } : { runId })
    if (at) dispatch.at(at)
    const tx = currentContext()?.tx
    if (durable && tx && this.app.has(Outbox)) dispatch.durable()
    await dispatch
  }

  /**
   * Replay a run from its journal until it finishes or suspends. One process at a time per run (advisory lock).
   * `wakeAt`: the moment the job that called it was scheduled for.
   */
  async resume(runId: string, options: { wakeAt?: string } = {}): Promise<void> {
    const db = this.app.resolve(Database)
    await db.advisoryLock(`cslug:workflow:${runId}`, async () => {
      const run = await this.store.find(runId)
      if (!run || FINISHED.includes(run.status)) return
      const workflow = findWorkflow(run.workflow)
      if (!workflow) {
        await this.store.finish(runId, 'failed', {
          error: { name: 'CslugError', code: 'workflow.unknown', message: `No workflow named ${run.workflow}` },
        })
        return
      }
      this.register(workflow)
      const cancelling = run.status === 'cancelling'
      if (!cancelling) await this.store.setStatus(runId, 'running')
      const ctx = new WorkflowContext(
        runId,
        await this.store.journal(runId),
        this.store,
        db,
        this.app.resolve(Clock),
        cancelling,
      )
      const scope = currentContext()?.scope ?? this.app
      const suspend = async (s: Suspension, status = s.status as RunStatus) => {
        await this.store.suspend(runId, { ...s, status })
        const at = s.wakeAt?.getTime()
        // one job per suspension point; again if this job ran before its time (the queue's clock was ahead)
        if (at !== undefined && (at !== run.wakeAt?.getTime() || options.wakeAt === s.wakeAt?.toISOString()))
          await this.wake(runId, s.wakeAt as Date)
      }
      let failure: unknown
      try {
        const instance = scope.resolve(workflow as never) as { run(c: WorkflowContext, input: unknown): unknown }
        const output = await instance.run(ctx, run.input)
        if (!cancelling) return await this.store.finish(runId, 'completed', { output: toJson(output) })
      } catch (error) {
        if (error instanceof Suspension) return await suspend(error)
        if (!(error instanceof Cancellation)) failure = error
      }
      // failed or cancelled: undo the finished steps (a saga); a nondeterministic run cannot be trusted to
      if (failure !== undefined && !cancelling)
        this.app.resolve(Logger).error('workflow.failed', { runId, workflow: run.workflow, error: failure })
      const error = cancelling || failure === undefined ? undefined : errorJson(failure)
      if (!ctx.hasCompensations || failure instanceof NondeterminismError)
        return await this.store.finish(runId, cancelling ? 'cancelled' : 'failed', { error })
      try {
        if (!cancelling) await this.store.setStatus(runId, 'compensating')
        await ctx.compensate()
        await this.store.finish(runId, cancelling ? 'cancelled' : 'compensated', { error })
      } catch (compensation) {
        if (compensation instanceof Suspension)
          return await suspend(compensation, cancelling ? 'cancelling' : 'compensating')
        this.app.resolve(Logger).error('workflow.compensation_failed', { runId, error: compensation })
        await this.store.finish(runId, 'compensation_failed', { error: errorJson(compensation) })
      }
    })
  }
}
