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

## Sagas and cancelling

`step(name, fn, { compensate })`: compensations are functions, so they are not stored; the replay registers each
finished step's `compensate` as it passes it. When the replay ends with an error other than
`workflow.nondeterministic`, the same resume runs the registered compensations last first. Each is journaled at
seq `-(step seq + 1)` (kind `compensate`), runs in a transaction with its entry, and is retried with the step's
`tries` and `backoff`: the run is `compensating` and sleeps until then. It ends `compensated` (the original error
kept) or, on a compensation's last try, `compensation_failed` (that error). Without compensations it ends `failed`.

`cancel(id)` sets `cancelling` and queues a resume. That replay runs in cancel mode: the first `ctx` call whose
entry is not completed throws `Cancellation`; the finished steps are compensated the same way, and the run ends
`cancelled` (or `compensation_failed`).

## Operations

`Workflows.list({ status, workflow, limit })`, `retry(id)` (a `failed` run back to `pending`, a
`compensation_failed` one to `compensating`; its failed journal entries become `retrying` with no wake-up time and
zero attempts, so they run at once), `prune(olderThan)` (finished runs, with their journals and signals, by
`finished_at`). Commands: `workflow:list [--status] [--workflow] [--limit] [--json]`, `workflow:show <id> [--json]`,
`workflow:retry <id>`, `workflow:cancel <id>`, `workflow:prune [--older-than=90d]`. `cslug describe workflows`: name,
class and events waited for.

Traces: a span `workflow.step <name>` (attributes `cslug.workflow.run_id`, `.step`, `.attempt`) around each step or
compensation that runs, failed ones recorded. Audit (with `@cslug/security`, loaded at runtime): `workflow.started`
in `start()`, and `workflow.<final status>` when a run ends, subject `{ type: 'workflow_run', id }`, data
`{ workflow }`; `Workflows.audit` can be set to any `{ record(action, options) }`.

## Testing

`testApp({ fakes: ['workflows'] })` → `t.workflows`, a `WorkflowFake`: `runUntilIdle({ max?, fastForward? })`,
`assertStatus(id, status, output?)`, `find`, `journal`, `signal`. See guide 25 § Testing.
