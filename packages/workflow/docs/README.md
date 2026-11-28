# @cslug/workflow

`WorkflowProvider` (after `DatabaseProvider` and `QueueProvider`) registers the migration, the
`cslug.workflow.resume` job and `Workflows`, and imports `app/workflows/` so every process (web, worker) knows every
workflow and watches the events they wait for.

## Tables (migration `00000000_000800`)

| Table | |
|---|---|
| `cslug_workflow_runs` | `id` (text: yours or a UUIDv7), `workflow`, `status`, `input`, `output`, `error`, `waiting_for`, `waiting_match`, `wake_at`, timestamps, `finished_at` |
| `cslug_workflow_steps` | The journal: `(run_id, seq)`, `name`, `kind` (`step`, `sleep`, `wait`, `now`, `uuid`), `status` (`completed`, `pending`, `retrying`, `failed`), `result`, `error`, `attempts`, `wake_at` |
| `cslug_workflow_signals` | Signals and matched events not yet taken by their run |

## Running a run

`start()` inserts the run (`on conflict do nothing`: an existing id returns `{ created: false }`) and dispatches a
resume, through the outbox when inside a transaction. A resume (`Workflows.resume(runId)`):

1. takes the advisory lock `cslug:workflow:<id>` (one process at a time per run);
2. stops if the run is finished or cancelled; fails it with `workflow.unknown` if no workflow has its name;
3. replays `run(ctx, input)` with the journal: each `ctx` call takes the next position, checks its name and kind
   (`workflow.nondeterministic` otherwise) and returns the stored result when it is completed;
4. ends `completed` (output stored), `failed` (error stored), or suspended: `sleeping` / `waiting` with `wake_at`,
   and a delayed resume job for `wake_at` when the suspension point is new (or the job ran early).

A `ctx.step` runs `fn` and writes its journal entry in one database transaction. On failure, the entry becomes
`retrying` with `wake_at` after the backoff, and the run sleeps; after `tries` it is `failed` and the run fails
with `workflow.step_failed`.

## Waiting

`waitForSignal(name)` waits on the channel `signal:<name>`; `workflows.signal(runId, name, data)` stores the signal
and wakes the run, so a signal sent early is kept. `waitFor(Event, match)` waits on `event:<event name>` with
`match` stored as JSON; an `EventBus` listener for each event in a workflow's `static waitsFor` finds the waiting
runs whose match the payload contains (`waiting_match <@ payload`), stores the payload for them and wakes them, in
the emitter's transaction. Timeouts are `wake_at`: the wait then returns `undefined`.

Values cross the journal as JSON: bigint and `Date` become strings (`Json<T>` types it).
