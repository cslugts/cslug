import { CslugError, type Duration, parseDuration } from '@cslug/core'
import { PendingDispatch } from './dispatch'
import type { JobSpec } from './queue'

/** How long to wait before retry `n` (1 = after the first failure): a duration, one per retry, or a function. */
export type Backoff = Duration | readonly Duration[] | ((attempt: number) => number)

/** Anything with `parse()`: a `v` schema from `@cslug/validation`, or your own. */
export type PayloadSchema<T = unknown> = { parse(value: unknown): T }

/** The payload type of a job class (from its `handle` parameter; `undefined` when it takes none). */
export type PayloadOf<J> = J extends abstract new (
  ...args: never[]
) => { handle(...args: infer A): unknown }
  ? A[0]
  : never

/** `dispatch()` arguments: none for `Job` without a payload, the payload otherwise. */
export type PayloadArgs<J> = [PayloadOf<J>] extends [undefined] ? [payload?: undefined] : [payload: PayloadOf<J>]

/**
 * The static settings a job class may declare. They are deliberately not declared on `Job`, so apps compiled
 * with `noImplicitOverride` write `static tries = 5` without `override` (as for providers).
 */
export type JobSettings = {
  /** The name stored with the job (default: the class name). Set it if you rename the class while jobs wait. */
  readonly jobName?: string
  /** Default `'default'`. */
  readonly queue?: string
  /** Attempts in all, the first included. Default 3. */
  readonly tries?: number
  /** Default: exponential from 5 s, capped at 10 min, with jitter. */
  readonly backoff?: Backoff
  /**
   * A run longer than this fails (and is retried). Default `'60s'`. The handler itself cannot be stopped: it keeps
   * running in the background, so keep side effects idempotent.
   */
  readonly timeout?: Duration
  readonly payloadSchema?: PayloadSchema
}

/** A job class. Its instances may also have `failed(payload, error)`, called once after the last attempt. */
export type JobClass<P = unknown> = (abstract new (...args: never[]) => Job<P>) & JobSettings

/** What a job instance may have besides `handle` (not declared on `Job`, so no `override` is needed). */
export type JobHooks<P = unknown> = { failed?(payload: P, error: Error): unknown }

const DEFAULT_BACKOFF = exponential('5s', { max: '10m', jitter: true })

/** A job class's settings with the defaults filled in. */
export function settingsOf(job: JobSettings) {
  return {
    queue: job.queue ?? 'default',
    tries: job.tries ?? 3,
    backoff: job.backoff ?? DEFAULT_BACKOFF,
    timeoutMs: parseDuration(job.timeout ?? '60s'),
  }
}

/**
 * A unit of background work: an `@inject()` class with a typed payload and a `handle` method. Optional statics:
 * `queue`, `tries`, `backoff`, `timeout`, `jobName` ({@link JobSettings}); optional `failed(payload, error)`.
 *
 * ```ts
 * @inject(BookingRepository)
 * export class SendCheckinJob extends Job<{ bookingId: string }> {
 *   static queue = 'notifications'
 *   static tries = 5
 *   constructor(private bookings: BookingRepository) { super() }
 *   async handle({ bookingId }: { bookingId: string }) { … }
 * }
 * await SendCheckinJob.dispatch({ bookingId }).delay('3d')
 * ```
 */
export abstract class Job<P = void> {
  abstract handle(payload: P): unknown

  /** Queue this job (after the current transaction commits). Resolves to the job id, or null for a duplicate `unique()`. */
  static dispatch<J extends JobClass<never>>(this: J, ...[payload]: PayloadArgs<J>): PendingDispatch {
    // biome-ignore lint/complexity/noThisInStatic: `this` is the concrete job class (SendCheckinJob), not Job
    return new PendingDispatch(this as JobClass, payload)
  }

  /** This job with a payload, for `Queue.chain([…])` and `Queue.batch([…])`. */
  static with<J extends JobClass<never>>(this: J, ...[payload]: PayloadArgs<J>): JobSpec {
    // biome-ignore lint/complexity/noThisInStatic: `this` is the concrete job class
    registerJob(this as JobClass)
    // biome-ignore lint/complexity/noThisInStatic: `this` is the concrete job class
    return { name: jobName(this as JobClass), payload }
  }

  /** Exponential backoff: `base`, then ×2 per retry, capped at `max`; `jitter` spreads retries out (±50%). */
  static exponential(base: Duration, options: { max?: Duration; jitter?: boolean } = {}): (attempt: number) => number {
    return exponential(base, options)
  }

  /**
   * A job base class whose payload is checked against `schema` on dispatch and again before it runs:
   * `class ProcessPaymentEventJob extends Job.schema(v.object({ eventId: v.string() })) { … }`
   */
  static schema<T>(schema: PayloadSchema<T>) {
    abstract class SchemaJob extends Job<T> {
      static payloadSchema: PayloadSchema = schema
    }
    return SchemaJob
  }
}

function exponential(base: Duration, options: { max?: Duration; jitter?: boolean }) {
  const first = parseDuration(base)
  const max = options.max === undefined ? Number.POSITIVE_INFINITY : parseDuration(options.max)
  return (attempt: number) => {
    const ms = Math.min(first * 2 ** Math.max(0, attempt - 1), max)
    return Math.round(options.jitter ? ms * (0.5 + Math.random()) : ms)
  }
}

/** Milliseconds to wait before retrying after failed attempt `attempt`. */
export function backoffDelay(backoff: Backoff, attempt: number): number {
  if (typeof backoff === 'function') return Math.max(0, backoff(attempt))
  if (Array.isArray(backoff)) {
    const list = backoff as readonly Duration[]
    return list.length ? parseDuration(list[Math.min(attempt, list.length) - 1] as Duration) : 0
  }
  return parseDuration(backoff as Duration)
}

// ── the registry: job name → class, for workers ────────────────────────────────────────────────────

const registry = new Map<string, JobClass>()

export const jobName = (job: JobClass): string => job.jobName ?? job.name

/** Remember a job class by name (dispatch and discovery call this). Two classes with one name is an error. */
export function registerJob(job: JobClass): void {
  const name = jobName(job)
  const known = registry.get(name)
  if (known && known !== job)
    throw new CslugError('queue.duplicate_job', `Two job classes are named ${name}: set static jobName on one of them`)
  registry.set(name, job)
}

export const findJob = (name: string): JobClass | undefined => registry.get(name)

export const isJobClass = (value: unknown): value is JobClass =>
  typeof value === 'function' && value.prototype instanceof Job && !Object.is(value, Job)
