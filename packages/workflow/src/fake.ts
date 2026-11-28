import { type Application, Clock, FakeClock } from '@cslug/core'
import { FINISHED, type JournalEntry, type WorkflowRun } from './store'
import { Workflows } from './workflows'

/**
 * Workflows in tests (`testApp({ fakes: ['workflows'] })` → `t.workflows`): `runUntilIdle()` resumes every run that
 * can move, synchronously, on the test's database, and fast-forwards the test clock (a `FakeClock`) over sleeps,
 * retries and timeouts. Starting, signals and events work as in the app; nothing waits for a worker.
 */
export class WorkflowFake {
  constructor(private readonly app: Application) {}

  private get workflows(): Workflows {
    return this.app.resolve(Workflows)
  }

  /**
   * Resume runs until none can move: each unfinished run is resumed; when none moved, the clock jumps to the
   * earliest wake-up and they are resumed again. Stops when the only runs left wait without a timeout (for a
   * signal or an event). Returns how many resumes moved a run.
   */
  async runUntilIdle(options: { max?: number; fastForward?: boolean } = {}): Promise<number> {
    const max = options.max ?? 1000
    let moved = 0
    for (let round = 0; ; round++) {
      if (round >= max) throw new Error(`runUntilIdle(): still busy after ${max} rounds; does a workflow loop?`)
      const runs = await this.unfinished()
      let progressed = false
      for (const run of runs) {
        const before = await this.fingerprint(run.id)
        await this.workflows.resume(run.id)
        if ((await this.fingerprint(run.id)) !== before) {
          progressed = true
          moved++
        }
      }
      if (progressed) continue
      const next = (await this.unfinished())
        .map((r) => r.wakeAt?.getTime())
        .filter((t): t is number => t !== undefined)
        .sort((a, b) => a - b)[0]
      const clock = this.app.resolve(Clock)
      if (next === undefined || options.fastForward === false || !(clock instanceof FakeClock)) return moved
      if (next > clock.now().getTime()) clock.travelTo(next)
      else return moved // due but did not move: nothing more will happen
    }
  }

  find(runId: string): Promise<WorkflowRun | null> {
    return this.workflows.find(runId)
  }

  journal(runId: string): Promise<JournalEntry[]> {
    return this.workflows.store.journal(runId)
  }

  signal(runId: string, name: string, data?: unknown): Promise<void> {
    return this.workflows.signal(runId, name, data)
  }

  /** Throw unless the run has this status (and, when given, this output). */
  async assertStatus(runId: string, status: WorkflowRun['status'], output?: unknown): Promise<void> {
    const run = await this.find(runId)
    if (!run) throw new Error(`No workflow run ${runId}`)
    const outputMatches = output === undefined || JSON.stringify(run.output) === JSON.stringify(output)
    if (run.status !== status || !outputMatches)
      throw new Error(
        `Expected run ${runId} to be ${status}${output === undefined ? '' : ` with ${JSON.stringify(output)}`}, ` +
          `got ${run.status}${run.error ? ` (${run.error.message})` : ''} with ${JSON.stringify(run.output)}`,
      )
  }

  private async unfinished(): Promise<WorkflowRun[]> {
    const all = await this.workflows.list({ limit: 10_000 })
    return all.filter((r) => !FINISHED.includes(r.status))
  }

  private async fingerprint(runId: string): Promise<string> {
    const run = await this.workflows.find(runId)
    const journal = await this.workflows.store.journal(runId)
    return JSON.stringify([run?.status, run?.wakeAt, journal.map((e) => [e.seq, e.status, e.attempts])])
  }
}

/** For `@cslug/testing`: `t.workflows`. */
export function installWorkflowFake(app: Application): WorkflowFake {
  return new WorkflowFake(app)
}
