import { type Database, sql } from '@cslug/database'

export type RunStatus =
  | 'pending'
  | 'running'
  | 'sleeping'
  | 'waiting'
  /** Undoing finished steps after a failure (a compensation may be waiting for its retry). */
  | 'compensating'
  /** Cancelled, not yet stopped: its next wake-up undoes finished steps, then it is `cancelled`. */
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  /** Failed, and every compensation ran. */
  | 'compensated'
  /** Failed (or cancelled), and a compensation failed on its last try. */
  | 'compensation_failed'
export const FINISHED: readonly RunStatus[] = ['completed', 'failed', 'cancelled', 'compensated', 'compensation_failed']

/** A workflow run as stored (`workflows.find(id)`). */
export type WorkflowRun = {
  id: string
  workflow: string
  status: RunStatus
  input: unknown
  output: unknown
  error: { name: string; message: string; code?: string } | null
  /** What a waiting run waits for: `signal:<name>` or `event:<event name>`. */
  waitingFor: string | null
  waitingMatch: Record<string, unknown> | null
  wakeAt: Date | null
  createdAt: Date
  updatedAt: Date
  finishedAt: Date | null
}

/** One journal entry: a `ctx` call of a run, by position. */
export type JournalEntry = {
  seq: number
  name: string
  kind: 'step' | 'sleep' | 'wait' | 'now' | 'uuid' | 'compensate'
  status: 'completed' | 'pending' | 'retrying' | 'failed'
  result: unknown
  error: unknown
  attempts: number
  wakeAt: Date | null
}

const json = (value: unknown) => (value === undefined || value === null ? null : sql.json(value))

/** The SQL behind workflows (tables from migration 000800). Every call uses the ambient transaction. */
export class WorkflowStore {
  constructor(private readonly db: () => Database) {}

  /** Insert a run; false when the id exists already. */
  async insert(id: string, workflow: string, input: unknown): Promise<boolean> {
    const n = await this.db().exec(sql`insert into cslug_workflow_runs (id, workflow, input)
      values (${id}, ${workflow}, ${json(input)}) on conflict (id) do nothing`)
    return n > 0
  }

  find(id: string): Promise<WorkflowRun | null> {
    return this.db().maybeOne<WorkflowRun>(sql`select * from cslug_workflow_runs where id = ${id}`)
  }

  async setStatus(id: string, status: RunStatus): Promise<void> {
    await this.db().exec(sql`update cslug_workflow_runs set status = ${status}, updated_at = now() where id = ${id}`)
  }

  async suspend(
    id: string,
    s: { status: RunStatus; wakeAt: Date | null; waitingFor?: string; match?: Record<string, unknown> },
  ): Promise<void> {
    await this.db().exec(sql`update cslug_workflow_runs set status = ${s.status}, wake_at = ${s.wakeAt},
      waiting_for = ${s.waitingFor ?? null}, waiting_match = ${json(s.match)}, updated_at = now() where id = ${id}`)
  }

  async finish(id: string, status: RunStatus, values: { output?: unknown; error?: unknown }): Promise<void> {
    await this.db().exec(sql`update cslug_workflow_runs set status = ${status}, output = ${json(values.output)},
      error = ${json(values.error)}, wake_at = null, waiting_for = null, waiting_match = null, updated_at = now(),
      finished_at = now() where id = ${id}`)
  }

  /** Mark a run that has not finished `cancelling`; false when it had finished or was being cancelled. */
  async cancel(id: string): Promise<boolean> {
    const n = await this.db().exec(sql`update cslug_workflow_runs set status = 'cancelling', updated_at = now()
      where id = ${id} and status not in ('completed', 'failed', 'cancelled', 'compensated', 'compensation_failed',
        'cancelling')`)
    return n > 0
  }

  async journal(runId: string): Promise<JournalEntry[]> {
    return this.db().many<JournalEntry>(sql`select seq, name, kind, status, result, error, attempts, wake_at
      from cslug_workflow_steps where run_id = ${runId} order by seq`)
  }

  async save(runId: string, e: Omit<JournalEntry, 'result' | 'error'> & { result?: unknown; error?: unknown }) {
    await this.db().exec(sql`insert into cslug_workflow_steps
        (run_id, seq, name, kind, status, result, error, attempts, wake_at)
      values (${runId}, ${e.seq}, ${e.name}, ${e.kind}, ${e.status}, ${json(e.result)}, ${json(e.error)},
        ${e.attempts}, ${e.wakeAt})
      on conflict (run_id, seq) do update set status = excluded.status, result = excluded.result,
        error = excluded.error, attempts = excluded.attempts, wake_at = excluded.wake_at, updated_at = now()`)
  }

  async addSignal(runId: string, name: string, data: unknown): Promise<void> {
    await this.db().exec(sql`insert into cslug_workflow_signals (id, run_id, name, data)
      values (${Bun.randomUUIDv7()}, ${runId}, ${name}, ${json(data)})`)
  }

  /** The oldest signal `name` not yet taken by the run, marked taken (in the caller's transaction). */
  async takeSignal(runId: string, name: string): Promise<{ data: unknown } | null> {
    const row = await this.db().maybeOne<{ id: string; data: unknown }>(sql`select id, data
      from cslug_workflow_signals where run_id = ${runId} and name = ${name} and consumed_at is null
      order by created_at, id limit 1 for update skip locked`)
    if (!row) return null
    await this.db().exec(sql`update cslug_workflow_signals set consumed_at = now() where id = ${row.id}`)
    return { data: row.data }
  }

  /** Runs waiting for `channel` whose match is contained in `payload`. */
  async waitingFor(channel: string, payload: unknown): Promise<string[]> {
    const rows = await this.db().many<{ id: string }>(sql`select id from cslug_workflow_runs
      where status = 'waiting' and waiting_for = ${channel}
        and (waiting_match is null or waiting_match <@ ${json(payload ?? {})})`)
    return rows.map((r) => r.id)
  }
}
