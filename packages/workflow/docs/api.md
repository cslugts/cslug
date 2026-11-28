# @cslug/workflow API

| Export | |
|---|---|
| `Workflow<I, O>` | Base class: `run(ctx, input)`; statics `workflowName?`, `waitsFor?`; `Workflow.start(input, { id? })` → `{ id, created }` |
| `WorkflowContext` | `runId`, `step(name, fn, { tries?, backoff?, timeout? })`, `sleep(duration)`, `sleepUntil(date)`, `waitFor(Event, match?, { timeout? })`, `waitForSignal(name, { timeout? })`, `now()`, `uuid()` |
| `StepOptions` | `{ tries?: number (3), backoff?: Backoff (30 s doubled, ≤ 1 h), timeout?: Duration }` |
| `Workflows` | `start(Workflow, input, options?)`, `signal(runId, name, data?)`, `find(runId)`, `cancel(runId)`, `resume(runId, { wakeAt? })`, `register(Workflow)`, `store` |
| `WorkflowRun` | `{ id, workflow, status, input, output, error, waitingFor, waitingMatch, wakeAt, createdAt, updatedAt, finishedAt }` |
| `RunStatus`, `FINISHED` | `pending`, `running`, `sleeping`, `waiting`, `completed`, `failed`, `cancelled`; the last three |
| `JournalEntry`, `WorkflowStore` | A journal entry; the SQL (`store.journal(runId)`) |
| `WorkflowResumeJob` | The queue job `cslug.workflow.resume` (`{ runId, wakeAt? }`) |
| `WorkflowProvider`, `WORKFLOW_MIGRATIONS` | |
| `registerWorkflow`, `findWorkflow`, `workflowName`, `isWorkflowClass` | The registry |
| `StepFailedError`, `NondeterminismError`, `Suspension`, `isSuspension` | `workflow.step_failed`, `workflow.nondeterministic`; what `ctx` throws to suspend (rethrow it from a `catch`) |
| `Json<T>` | A value after a JSON round trip |

Error codes: `workflow.step_failed`, `workflow.step_timeout`, `workflow.nondeterministic`, `workflow.unknown`,
`workflow.duplicate`, `workflow.no_provider`, `workflow_run.not_found` (signal to an unknown run).
