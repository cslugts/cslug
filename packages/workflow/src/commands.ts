import { arg, Command, flag, resolve } from '@cslug/core'
import type { RunStatus } from './store'
import { Workflows } from './workflows'

const when = (d: Date | null) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 19) : '')

/** `cslug workflow:list [--status=failed] [--workflow=booking.deposit] [--limit=50]`. */
export class WorkflowListCommand extends Command {
  static signature = 'workflow:list'
  static description = 'List workflow runs, newest first'
  static args = {
    status: flag.string().optional().describe('pending, sleeping, waiting, failed, completed, …'),
    workflow: flag.string().optional().describe('A workflow name'),
    limit: flag.number().default(50),
    json: flag.boolean(),
  }

  async handle({ status, workflow, limit, json }: Command.Args<typeof WorkflowListCommand>) {
    const runs = await resolve(Workflows).list({ status: status as RunStatus | undefined, workflow, limit })
    if (json) return this.line(JSON.stringify(runs))
    if (!runs.length) return this.info('No runs')
    this.table(
      runs.map((r) => ({
        id: r.id,
        workflow: r.workflow,
        status: r.status,
        wakeAt: when(r.wakeAt),
        waitingFor: r.waitingFor ?? '',
        updated: when(r.updatedAt),
      })),
    )
  }
}

/** `cslug workflow:show <id>`: a run and its journal. */
export class WorkflowShowCommand extends Command {
  static signature = 'workflow:show'
  static description = 'Show a workflow run and its journal'
  static args = { id: arg.string(), json: flag.boolean() }

  async handle({ id, json }: Command.Args<typeof WorkflowShowCommand>) {
    const workflows = resolve(Workflows)
    const run = await workflows.find(id)
    if (!run) {
      this.error(`No workflow run ${id}`)
      return 1
    }
    const journal = await workflows.store.journal(id)
    if (json) {
      this.line(JSON.stringify({ run, journal }))
      return 0
    }
    this.line(`${run.id}  ${run.workflow}  ${run.status}`)
    if (run.wakeAt) this.line(`wakes at ${when(run.wakeAt)}${run.waitingFor ? `, waiting for ${run.waitingFor}` : ''}`)
    if (run.error) this.line(`error: ${run.error.code ?? run.error.name}: ${run.error.message}`)
    this.line(`input: ${JSON.stringify(run.input)}`)
    if (run.output !== null) this.line(`output: ${JSON.stringify(run.output)}`)
    this.line()
    this.table(
      journal.map((e) => ({
        seq: e.seq,
        kind: e.kind,
        name: e.name,
        status: e.status,
        attempts: e.attempts,
        wakeAt: when(e.wakeAt),
        error: (e.error as { message?: string } | null)?.message ?? '',
      })),
    )
    return 0
  }
}

/** `cslug workflow:retry <id>`: a failed run, again from the step (or compensation) that failed. */
export class WorkflowRetryCommand extends Command {
  static signature = 'workflow:retry'
  static description = 'Retry a failed workflow run from where it failed'
  static args = { id: arg.string() }

  async handle({ id }: Command.Args<typeof WorkflowRetryCommand>) {
    if (!(await resolve(Workflows).retry(id))) {
      this.error(`${id} is not a failed run (failed or compensation_failed)`)
      return 1
    }
    this.success(`${id} queued again`)
    return 0
  }
}

/** `cslug workflow:cancel <id>`. */
export class WorkflowCancelCommand extends Command {
  static signature = 'workflow:cancel'
  static description = 'Cancel a workflow run (its finished steps are compensated)'
  static args = { id: arg.string() }

  async handle({ id }: Command.Args<typeof WorkflowCancelCommand>) {
    if (!(await resolve(Workflows).cancel(id))) {
      this.error(`${id} has finished, is being cancelled, or does not exist`)
      return 1
    }
    this.success(`${id} is cancelling`)
    return 0
  }
}

/** `cslug workflow:prune --older-than=90d`: delete finished runs and their journals. */
export class WorkflowPruneCommand extends Command {
  static signature = 'workflow:prune'
  static description = 'Delete finished workflow runs older than a duration'
  static args = { olderThan: flag.string().default('90d').describe('A duration: 30d, 12w') }

  async handle({ olderThan }: Command.Args<typeof WorkflowPruneCommand>) {
    const n = await resolve(Workflows).prune(olderThan)
    this.success(`Deleted ${n} finished run(s) older than ${olderThan}`)
    return 0
  }
}

export const workflowCommands = [
  WorkflowListCommand,
  WorkflowShowCommand,
  WorkflowRetryCommand,
  WorkflowCancelCommand,
  WorkflowPruneCommand,
]
