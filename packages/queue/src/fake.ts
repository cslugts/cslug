import { type Application, Clock } from '@cslug/core'
import { findJob, type JobClass, type PayloadOf } from './job'
import { type Envelope, type PushOptions, Queue, runJob } from './queue'

/** A job the fake recorded. `delay` is in ms (undefined when the job was not delayed). */
export type PushedJob<P = unknown> = {
  id: string
  job: JobClass
  payload: P
  queue: string
  delay?: number
  runAt?: Date
  priority?: number
  unique?: string
  tries: number
}

/**
 * The queue in tests (`testApp({ fakes: ['queue'] })` → `t.queue`): records jobs instead of sending them.
 * Dispatches inside a transaction are still recorded only at COMMIT, so a rolled-back dispatch is never seen.
 */
export class QueueFake extends Queue {
  readonly pushed: PushedJob[] = []
  private waiting: { record: PushedJob; envelope: Envelope }[] = []

  constructor(private readonly app: Application) {
    super()
  }

  async push(envelope: Envelope, options: PushOptions = {}): Promise<string | null> {
    if (envelope.unique !== undefined && this.waiting.some((w) => w.envelope.unique === envelope.unique)) return null
    const now = this.app.resolve(Clock).now().getTime()
    const job = findJob(envelope.name) as JobClass
    const record: PushedJob = {
      id: envelope.id,
      job,
      payload: envelope.payload,
      queue: envelope.queue,
      tries: envelope.tries,
      ...(options.runAt !== undefined && options.runAt > now
        ? { delay: options.runAt - now, runAt: new Date(options.runAt) }
        : {}),
      ...(envelope.priority !== undefined ? { priority: envelope.priority } : {}),
      ...(envelope.unique !== undefined ? { unique: envelope.unique } : {}),
    }
    this.pushed.push(record)
    this.waiting.push({ record, envelope })
    return envelope.id
  }

  /** Recorded jobs of one class. */
  of<J extends JobClass<never>>(job: J): PushedJob<PayloadOf<J>>[] {
    return this.pushed.filter((p) => p.job === job) as PushedJob<PayloadOf<J>>[]
  }

  assertPushed<J extends JobClass<never>>(job: J, predicate?: (j: PushedJob<PayloadOf<J>>) => boolean): void {
    const all = this.of(job)
    if (!all.filter((j) => !predicate || predicate(j)).length)
      throw new Error(
        `Expected ${job.name} to be pushed${predicate ? ' matching the predicate' : ''}; pushed: ${describe(all.length ? all : this.pushed)}`,
      )
  }

  assertNotPushed<J extends JobClass<never>>(job: J, predicate?: (j: PushedJob<PayloadOf<J>>) => boolean): void {
    const matching = this.of(job).filter((j) => !predicate || predicate(j))
    if (matching.length) throw new Error(`Expected ${job.name} not to be pushed; pushed: ${describe(matching)}`)
  }

  assertPushedCount<J extends JobClass<never>>(job: J, count: number): void {
    const n = this.of(job).length
    if (n !== count) throw new Error(`Expected ${job.name} to be pushed ${count} time(s), got ${n}`)
  }

  assertNothingPushed(): void {
    if (this.pushed.length) throw new Error(`Expected no job to be pushed; pushed: ${describe(this.pushed)}`)
  }

  /**
   * Run every waiting job (delays ignored), including jobs those jobs push, once each. A job that throws stops
   * the drain with its error. Returns how many ran.
   */
  async drain(max = 1000): Promise<number> {
    let ran = 0
    while (this.waiting.length) {
      if (ran >= max) throw new Error(`drain(): more than ${max} jobs; is a job dispatching itself?`)
      const { envelope } = this.waiting.shift() as { envelope: Envelope }
      await runJob(this.app, envelope, 1)
      await this.finished(envelope, true)
      ran++
    }
    return ran
  }
}

const describe = (jobs: PushedJob[]) =>
  jobs.length
    ? jobs.map((j) => `${j.job?.name ?? '?'}(${JSON.stringify(j.payload, bigintSafe)})`).join(', ')
    : 'nothing'
const bigintSafe = (_k: string, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v)

/** For `@cslug/testing`: swap the queue for a fake and return it. */
export function installQueueFake(app: Application): QueueFake {
  const fake = new QueueFake(app)
  app.swap(Queue, fake)
  return fake
}
