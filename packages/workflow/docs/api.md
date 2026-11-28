# @cslug/workflow API

| Export | |
|---|---|
| `Workflow<I, O>` | Base class: `run(ctx, input)`; statics `workflowName?`, `waitsFor?`; `Workflow.start(input, { id? })` → `{ id, created }` |
| `WorkflowContext` | `runId`, `step(name, fn, { tries?, backoff?, timeout? })`, `sleep(duration)`, `sleepUntil(date)`, `waitFor(Event, match?, { timeout? })`, `waitForSignal(name, { timeout? })`, `now()`, `uuid()` |
| `StepOptions<T>` | `{ tries?: number (3), backoff?: Backoff (30 s doubled, ≤ 1 h), timeout?: Duration, compensate?: (result: Json<T>) => unknown }` |
| `Workflows` | `start(Workflow, input, options?)`, `signal(runId, name, data?)`, `find(runId)`, `list({ status?, workflow?, limit? })`, `retry(runId)`, `prune(olderThan)`, `audit?`, `cancel(runId)` (→ `cancelling`, compensates, → `cancelled`), `resume(runId, { wakeAt? })`, `register(Workflow)`, `store` |
| `WorkflowRun` | `{ id, workflow, status, input, output, error, waitingFor, waitingMatch, wakeAt, createdAt, updatedAt, finishedAt }` |
| `RunStatus`, `FINISHED` | `pending`, `running`, `sleeping`, `waiting`, `compensating`, `cancelling`, `completed`, `failed`, `cancelled`, `compensated`, `compensation_failed`; the last five |
| `JournalEntry`, `WorkflowStore` | A journal entry; the SQL (`store.journal(runId)`) |
| `WorkflowFake`, `installWorkflowFake` | `t.workflows`: `runUntilIdle({ max?, fastForward? })`, `assertStatus(id, status, output?)`, `find`, `journal`, `signal` |
| `workflowCommands` | `WorkflowListCommand`, `WorkflowShowCommand`, `WorkflowRetryCommand`, `WorkflowCancelCommand`, `WorkflowPruneCommand` |
| `WorkflowAudit` | `{ record(action, { subject, data }) }` (what `Workflows.audit` takes) |
| `WorkflowResumeJob` | The queue job `cslug.workflow.resume` (`{ runId, wakeAt? }`) |
| `WorkflowProvider`, `WORKFLOW_MIGRATIONS` | |
| `registerWorkflow`, `findWorkflow`, `workflowName`, `isWorkflowClass` | The registry |
| `StepFailedError`, `CompensationFailedError`, `NondeterminismError` | `workflow.step_failed`, `workflow.compensation_failed`, `workflow.nondeterministic` |
| `Suspension`, `Cancellation`, `isSuspension` | What `ctx` throws to stop a replay (suspend, or a run being cancelled): rethrow it from a `catch` |
| `Json<T>` | A value after a JSON round trip |

Error codes: `workflow.step_failed`, `workflow.compensation_failed`, `workflow.step_timeout`, `workflow.nondeterministic`, `workflow.unknown`,
`workflow.duplicate`, `workflow.no_provider`, `workflow_run.not_found` (signal to an unknown run).
