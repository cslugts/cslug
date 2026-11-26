import { type Application, CslugError, runInContext } from '@cslug/core'
import { PendingDispatch } from './dispatch'
import {
  findJob,
  type Job,
  type JobClass,
  type JobHooks,
  jobName,
  type PayloadArgs,
  registerJob,
  settingsOf,
} from './job'

/** A job as stored in the queue. */
export type Envelope = {
  id: string
  name: string
  queue: string
  payload: unknown
  /** Attempts already made before this delivery. */
  attempt: number
  tries: number
  priority?: number
  unique?: string
  dispatchedAt: number
}

/** Where and when to push. */
export type PushOptions = {
  /** Epoch ms; absent or past = now. */
  runAt?: number
  /** How long a `unique` key holds (ms). */
  uniqueFor?: number
}

/**
 * The queue: `resolve(Queue).dispatch(SendCheckinJob, payload)`, or `SendCheckinJob.dispatch(payload)`.
 * `RedisQueue` is the real one, `QueueFake` records jobs in tests.
 */
export abstract class Queue {
  dispatch<J extends JobClass<never>>(job: J, ...[payload]: PayloadArgs<J>): PendingDispatch {
    return new PendingDispatch(job as JobClass, payload, this)
  }

  /** Store the job. Resolves to its id, or null when its `unique` key is already held. */
  abstract push(envelope: Envelope, options?: PushOptions): Promise<string | null>
}

/** The envelope of a new job. */
export function envelopeOf(job: JobClass, payload: unknown, queue?: string): Envelope {
  registerJob(job)
  return {
    id: Bun.randomUUIDv7(),
    name: jobName(job),
    queue: queue ?? settingsOf(job).queue,
    payload,
    attempt: 0,
    tries: settingsOf(job).tries,
    dispatchedAt: Date.now(),
  }
}

export class JobNotFoundError extends CslugError {
  constructor(name: string) {
    super(
      'queue.job_not_found',
      `No job class named ${name}. Workers load app/jobs/ and app/listeners/; is the file there, and does it export the class?`,
    )
  }
}

export class JobTimeoutError extends CslugError {
  constructor(name: string, ms: number) {
    super('queue.job_timeout', `${name} ran longer than its timeout (${ms} ms)`)
  }
}

/**
 * Run one delivery in its own scope and context ({ jobId, attempt }): validate the payload, build the job (a fresh
 * instance; `@inject` only when its constructor takes dependencies), call
 * `handle`, under the job's timeout. Throws what the job threw.
 */
export async function runJob(app: Application, envelope: Envelope, attempt: number): Promise<void> {
  const cls = findJob(envelope.name)
  if (!cls) throw new JobNotFoundError(envelope.name)
  const timeout = settingsOf(cls).timeoutMs
  const scope = app.createScope()
  const context = { app, scope, jobId: envelope.id, attempt, requestId: `job:${envelope.id}` }
  let timer: Timer | undefined
  try {
    const run = runInContext(context, async () => {
      const payload = cls.payloadSchema ? cls.payloadSchema.parse(envelope.payload) : envelope.payload
      await (scope.build(cls as never) as Job<unknown>).handle(payload)
    })
    const expire = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new JobTimeoutError(envelope.name, timeout)), timeout)
    })
    await Promise.race([run, expire])
  } finally {
    clearTimeout(timer)
    await scope.dispose()
  }
}

/** Call the job's `failed(payload, error)` hook after its last attempt; its own errors are returned, not thrown. */
export async function runFailedHook(app: Application, envelope: Envelope, error: Error): Promise<unknown> {
  const cls = findJob(envelope.name)
  if (!cls || typeof (cls.prototype as JobHooks).failed !== 'function') return undefined
  const scope = app.createScope()
  try {
    await runInContext({ app, scope, jobId: envelope.id, requestId: `job:${envelope.id}` }, async () => {
      await (scope.build(cls as never) as JobHooks).failed?.(envelope.payload, error)
    })
    return undefined
  } catch (hookError) {
    return hookError
  } finally {
    await scope.dispose()
  }
}
