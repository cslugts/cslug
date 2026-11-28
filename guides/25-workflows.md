# 25. Workflows

Some work takes days and must not be lost halfway: a deposit that waits for the payment partner, a refund that
waits for an operator's decision, an onboarding that sends reminders over a week. A job (guide 11) is the right tool
for one step. A workflow is for the whole story: it remembers which steps are done, sleeps for days without holding a
worker, waits for events and people, and picks up where it stopped after a deploy or a crash.

`@cslug/workflow` (`cslug add workflow`) is built on what the app already has: PostgreSQL for the journal, the queue
for wake-ups, core events for waiting. No other server.

## A workflow

```ts
// app/workflows/booking-deposit-workflow.ts
import { inject } from '@cslug/core'
import { Workflow, type WorkflowContext } from '@cslug/workflow'

type Input = { bookingId: string }

@inject(PaymentGateway, BookingRepository, Notifier)
export class BookingDepositWorkflow extends Workflow<Input, { outcome: string }> {
  static workflowName = 'booking.deposit' // stored with each run; keep it when you rename the class
  static waitsFor = [DepositPaid] // the events ctx.waitFor() may wait for

  constructor(private gateway: PaymentGateway, private bookings: BookingRepository, private notifier: Notifier) {
    super()
  }

  async run(ctx: WorkflowContext, { bookingId }: Input) {
    const hold = await ctx.step('create-hold', () => this.gateway.createHold(bookingId), { tries: 5, backoff: '1m' })

    const paid = await ctx.waitFor(DepositPaid, { bookingId }, { timeout: '3d' })
    if (!paid) {
      await ctx.step('cancel', () => this.bookings.transition(bookingId, 'status', BookingStatus, 'cancelled'))
      return { outcome: 'expired' }
    }

    await ctx.sleep('1d')
    await ctx.step('remind', () => this.notifier.send(…))

    const decision = await ctx.waitForSignal<{ approved: boolean }>('operator.decision', { timeout: '2d' })
    return { outcome: decision?.approved ? 'approved' : 'pending-review' }
  }
}
```

Start it from anywhere: a controller, a listener, a job.

```ts
const run = await BookingDepositWorkflow.start({ bookingId }, { id: `deposit:${bookingId}` })
```

- **`id`** (optional, default a UUIDv7) makes the start idempotent: starting `deposit:b1` twice gives the same run.
- **Inside a transaction** the run is created with your changes and starts after COMMIT; a rollback leaves no run.
- The input and every step result are stored as JSON: bigint and `Date` come back as strings.

## How it runs

`run()` is replayed from the top each time the run wakes up. Every `ctx` call has a place in a journal
(`cslug_workflow_steps`): a call that already finished returns its stored result at once, without running again, so
the replay reaches the first unfinished call in milliseconds and carries on from there.

| Call | What it does |
|---|---|
| `ctx.step(name, fn, { tries?, backoff?, timeout? })` | Runs `fn` once and stores its result. `fn` runs in a database transaction with the journal entry, so its database changes and "done" commit together. A failure is retried `tries` times (default 3) after `backoff` (default `'30s'`, doubled each time) without holding a worker; then the run fails |
| `ctx.sleep('3d')` / `ctx.sleepUntil(date)` | Suspends the run; a delayed job wakes it |
| `ctx.waitFor(Event, match, { timeout? })` | Suspends until the event is emitted with a payload containing `match` (`{ bookingId }`); returns the payload, or `undefined` after the timeout |
| `ctx.waitForSignal(name, { timeout? })` | Suspends until `workflows.signal(runId, name, data)`; returns `data`, or `undefined` after the timeout |
| `ctx.now()` / `ctx.uuid()` | The time and a UUID, recorded the first time so a replay sees the same value |

The rules that follow from replaying:

- **Everything with an effect goes through `ctx`.** Code between steps runs again on every replay: keep it to
  decisions on step results. Read the time with `ctx.now()`, not `new Date()`.
- **External calls are at least once.** A step that crashed after calling the gateway but before committing runs
  again: pass the gateway an idempotency key (the run id and step name).
- **Signals wait for the run; events do not.** A signal sent before the run reaches `waitForSignal` is kept for it.
  An event is only seen by runs already waiting for it.

Each wake-up is one queue job (`cslug.workflow.resume`), and a run is resumed by one process at a time (a Postgres
advisory lock). Workers need nothing more than `cslug add queue` already gave them.

## Changing a workflow

Runs already in progress replay the new code against their journal. Each `ctx` call is matched by position and
name:

- adding calls **after** the last one a run has reached is safe;
- renaming, removing or reordering calls before it is not: the run fails with `workflow.nondeterministic`.

For a deeper change, keep the old class for the runs in flight and start new runs with a new `workflowName`
(`booking.deposit.v2`).

## Signals, status and cancelling

```ts
@inject(Workflows)
export class ReviewController {
  constructor(private workflows: Workflows) {}

  async decide({ params, request }: HttpContext) {
    const { approved } = await request.validate(DecisionValidator)
    await this.workflows.signal(`deposit:${params.id}`, 'operator.decision', { approved })
    return redirect().back()
  }
}

const run = await workflows.find('deposit:b1')
// { id, workflow, status: 'pending' | 'running' | 'sleeping' | 'waiting' | 'completed' | 'failed' | 'cancelled',
//   input, output, error, wakeAt, waitingFor, createdAt, updatedAt, finishedAt }
await workflows.cancel('deposit:b1') // it stops at its next wake-up; a finished run stays as it is
```

## Sagas: undoing what was done

When a later step fails for good, the earlier ones may need undoing: release the hold, refund the deposit. Give
those steps a `compensate`:

```ts
const hold = await ctx.step('create-hold', () => this.gateway.createHold(bookingId), {
  compensate: (hold) => this.gateway.releaseHold(hold.id),
})
const charge = await ctx.step('charge', () => this.gateway.capture(hold.id), {
  compensate: (charge) => this.gateway.refund(charge.id),
})
await ctx.step('confirm-with-operator', () => this.operators.confirm(bookingId)) // fails for good
```

The run then runs the compensations of the finished steps in reverse order (`refund`, then `releaseHold`), each
journaled and retried like a step, and ends `compensated`, or `compensation_failed` if one of them gives up. Cancelling
a run compensates the same way.

## Operations

```bash
cslug workflow:list --status=failed      # runs, filtered by workflow or status
cslug workflow:show deposit:b1           # a run and its journal
cslug workflow:retry deposit:b1          # a failed run: retry from the failed step
cslug workflow:cancel deposit:b1
cslug workflow:prune --older-than=90d    # finished runs and their journals
```

Each step is a span in traces (guide 23), and with `@cslug/security` each run's start, end and failure is in the audit
log. `cslug describe workflows` lists the registered workflows.

## Testing

```ts
const t = testApp({ fakes: ['workflow'] })

test('an unpaid deposit expires after 3 days', async () => {
  const run = await BookingDepositWorkflow.start({ bookingId: booking.id })
  await t.workflows.runUntilIdle()          // runs steps now; sleeps and timeouts are fast-forwarded
  expect(await t.workflows.find(run.id)).toMatchObject({ status: 'completed', output: { outcome: 'expired' } })
})
```

`WorkflowFake` runs workflows synchronously on the test's database, fast-forwards sleeps and timeouts on the test
clock, and delivers signals and events as they are sent.
