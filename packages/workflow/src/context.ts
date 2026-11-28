import { type AnyEventClass, type Clock, CslugError, type Duration, parseDuration } from '@cslug/core'
import type { Database } from '@cslug/database'
import { type Backoff, backoffDelay, Job } from '@cslug/queue'
import { NondeterminismError, StepFailedError, Suspension } from './errors'
import { errorJson, type Json, toJson } from './json'
import type { JournalEntry, WorkflowStore } from './store'

export type StepOptions = {
  /** Attempts in all, the first included (default 3). */
  tries?: number
  /** Wait before retry n: a duration, one per retry, or a function (default: 30 s, doubled each time, at most 1 h). */
  backoff?: Backoff
  /** An attempt longer than this fails (and is retried). */
  timeout?: Duration
}

const DEFAULT_BACKOFF = Job.exponential('30s', { max: '1h' })

/** The event's payload type. */
type PayloadOf<E> = E extends abstract new (payload: infer P) => unknown ? P : never

async function withTimeout<T>(work: Promise<T>, timeout: Duration | undefined, step: string): Promise<T> {
  if (timeout === undefined) return work
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new CslugError('workflow.step_timeout', `Step "${step}" took longer than ${timeout}`)),
          parseDuration(timeout),
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * What `run(ctx, input)` gets. Each call has a place in the run's journal: a call already finished returns its
 * stored result; the first unfinished one runs, or suspends the run (guide 25).
 */
export class WorkflowContext {
  private seq = 0
  private readonly entries: Map<number, JournalEntry>

  constructor(
    /** The run's id. */
    readonly runId: string,
    journal: JournalEntry[],
    private readonly store: WorkflowStore,
    private readonly db: Database,
    private readonly clock: Clock,
  ) {
    this.entries = new Map(journal.map((e) => [e.seq, e]))
  }

  private next(name: string, kind: JournalEntry['kind']): { seq: number; entry?: JournalEntry } {
    const seq = this.seq++
    const entry = this.entries.get(seq)
    if (entry && (entry.name !== name || entry.kind !== kind)) throw new NondeterminismError(seq, entry.name, name)
    return { seq, entry }
  }

  private due(at: Date | null): boolean {
    return at !== null && this.clock.now().getTime() >= new Date(at).getTime()
  }

  private async record(entry: Parameters<WorkflowStore['save']>[1]): Promise<void> {
    await this.store.save(this.runId, entry)
    this.entries.set(entry.seq, { result: null, error: null, ...entry } as JournalEntry)
  }

  /**
   * Run `fn` once and store its result (as JSON). `fn` runs in a database transaction together with the journal
   * entry. A failure is retried after `backoff` without holding a worker; after `tries`, the run fails.
   */
  async step<T>(name: string, fn: () => T | Promise<T>, options: StepOptions = {}): Promise<Json<Awaited<T>>> {
    const { seq, entry } = this.next(name, 'step')
    if (entry?.status === 'completed') return entry.result as Json<Awaited<T>>
    if (entry?.status === 'failed') throw new StepFailedError(name, entry.error)
    if (entry?.status === 'retrying' && !this.due(entry.wakeAt)) throw new Suspension('sleeping', entry.wakeAt)
    const attempts = (entry?.attempts ?? 0) + 1
    try {
      return await this.db.transaction(async () => {
        const value = toJson(await withTimeout(Promise.resolve(fn()), options.timeout, name))
        await this.record({ seq, name, kind: 'step', status: 'completed', result: value, attempts, wakeAt: null })
        return value as Json<Awaited<T>>
      })
    } catch (error) {
      if (error instanceof Suspension) throw error
      if (attempts < (options.tries ?? 3)) {
        const wakeAt = new Date(this.clock.now().getTime() + backoffDelay(options.backoff ?? DEFAULT_BACKOFF, attempts))
        await this.record({ seq, name, kind: 'step', status: 'retrying', error: errorJson(error), attempts, wakeAt })
        throw new Suspension('sleeping', wakeAt)
      }
      await this.record({ seq, name, kind: 'step', status: 'failed', error: errorJson(error), attempts, wakeAt: null })
      throw new StepFailedError(name, error)
    }
  }

  /** Suspend the run for a duration (`'3d'`); a delayed job wakes it. */
  sleep(duration: Duration): Promise<void> {
    return this.sleepUntil(new Date(this.clock.now().getTime() + parseDuration(duration)))
  }

  /** Suspend the run until a moment. */
  async sleepUntil(until: Date): Promise<void> {
    const { seq, entry } = this.next('sleep', 'sleep')
    if (entry?.status === 'completed') return
    const wakeAt = entry?.wakeAt ? new Date(entry.wakeAt) : until
    if (!entry) await this.record({ seq, name: 'sleep', kind: 'sleep', status: 'pending', attempts: 0, wakeAt })
    if (!this.due(wakeAt)) throw new Suspension('sleeping', wakeAt)
    await this.record({ seq, name: 'sleep', kind: 'sleep', status: 'completed', attempts: 0, wakeAt })
  }

  /**
   * Suspend until `event` is emitted with a payload containing `match` (`{ bookingId }`); its payload (as JSON), or
   * undefined after `timeout`. The workflow class lists the event in `static waitsFor`. Only runs already waiting
   * see an event.
   */
  waitFor<E extends AnyEventClass>(
    event: E,
    match: Partial<Json<PayloadOf<E>>> = {},
    options: { timeout?: Duration } = {},
  ): Promise<Json<PayloadOf<E>> | undefined> {
    const channel = `event:${event.eventName}`
    return this.wait(channel, match as Record<string, unknown>, options.timeout) as Promise<
      Json<PayloadOf<E>> | undefined
    >
  }

  /** Suspend until `workflows.signal(runId, name, data)`; its data, or undefined after `timeout`. Kept if early. */
  waitForSignal<T = unknown>(name: string, options: { timeout?: Duration } = {}): Promise<Json<T> | undefined> {
    return this.wait(`signal:${name}`, undefined, options.timeout) as Promise<Json<T> | undefined>
  }

  private async wait(channel: string, match: Record<string, unknown> | undefined, timeout?: Duration) {
    const { seq, entry } = this.next(channel, 'wait')
    if (entry?.status === 'completed') return entry.result ?? undefined
    const wakeAt = entry
      ? entry.wakeAt && new Date(entry.wakeAt)
      : timeout === undefined
        ? null
        : new Date(this.clock.now().getTime() + parseDuration(timeout))
    if (!entry) await this.record({ seq, name: channel, kind: 'wait', status: 'pending', attempts: 0, wakeAt })
    const got = await this.db.transaction(async () => {
      const signal = await this.store.takeSignal(this.runId, channel)
      if (signal)
        await this.record({
          seq,
          name: channel,
          kind: 'wait',
          status: 'completed',
          result: signal.data,
          attempts: 0,
          wakeAt,
        })
      return signal
    })
    if (got) return got.data ?? undefined
    if (this.due(wakeAt)) {
      await this.record({ seq, name: channel, kind: 'wait', status: 'completed', result: null, attempts: 0, wakeAt })
      return undefined
    }
    throw new Suspension('waiting', wakeAt, channel, match)
  }

  /** The current time, recorded the first time (a replay sees the same value). */
  async now(): Promise<Date> {
    const { seq, entry } = this.next('now', 'now')
    if (entry?.status === 'completed') return new Date(entry.result as string)
    const now = this.clock.now()
    await this.record({
      seq,
      name: 'now',
      kind: 'now',
      status: 'completed',
      result: now.toISOString(),
      attempts: 0,
      wakeAt: null,
    })
    return now
  }

  /** A UUIDv7, recorded the first time. */
  async uuid(): Promise<string> {
    const { seq, entry } = this.next('uuid', 'uuid')
    if (entry?.status === 'completed') return entry.result as string
    const id = Bun.randomUUIDv7()
    await this.record({ seq, name: 'uuid', kind: 'uuid', status: 'completed', result: id, attempts: 0, wakeAt: null })
    return id
  }
}
