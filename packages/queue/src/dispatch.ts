import { Clock, currentContext, type Duration, parseDuration, resolve, type TransactionHooks } from '@cslug/core'
import type { JobClass } from './job'
import { type Envelope, envelopeOf, type PushOptions, Queue } from './queue'

/**
 * A dispatch being configured; it is sent when awaited. Inside a database transaction it is held until COMMIT
 * and dropped on rollback, unless `.immediately()`.
 *
 * ```ts
 * await SendCheckinJob.dispatch({ bookingId }).delay('3d').onQueue('urgent').unique(`checkin:${bookingId}`)
 * ```
 */
export class PendingDispatch implements PromiseLike<string | null> {
  private queueName?: string
  private runAt?: Date
  private delayMs?: number
  private uniqueKey?: string
  private uniqueFor?: number
  private priorityLevel?: number
  private triesOverride?: number
  private now = false
  private sent?: Promise<string | null>

  constructor(
    private readonly job: JobClass,
    private readonly payload: unknown,
    private readonly queue?: Queue,
  ) {}

  delay(duration: Duration): this {
    this.delayMs = parseDuration(duration)
    return this
  }
  at(when: Date): this {
    this.runAt = when
    return this
  }
  onQueue(name: string): this {
    this.queueName = name
    return this
  }
  /** 1 (first) … 10 (last); default 5. Jobs are taken in three bands: 1–3, 4–7, 8–10. */
  priority(level: number): this {
    if (!Number.isInteger(level) || level < 1 || level > 10) throw new RangeError('priority() takes 1 … 10')
    this.priorityLevel = level
    return this
  }
  /** Ignored while a job with the same key is waiting or running (the key is held at most `holdFor`, default 1 day). */
  unique(key: string, holdFor: Duration = '1d'): this {
    this.uniqueKey = key
    this.uniqueFor = parseDuration(holdFor)
    return this
  }
  /** Attempts in all (overrides the job's `static tries`). */
  tries(n: number): this {
    this.triesOverride = n
    return this
  }
  /** Send now even inside a transaction (rarely right: the job may run before the data it needs is committed). */
  immediately(): this {
    this.now = true
    return this
  }

  // biome-ignore lint/suspicious/noThenProperty: a dispatch is sent by awaiting it
  then<A = string | null, B = never>(
    onFulfilled?: ((id: string | null) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    this.sent ??= this.send()
    return this.sent.then(onFulfilled, onRejected)
  }

  private async send(): Promise<string | null> {
    const queue = this.queue ?? resolve(Queue)
    const payload = this.job.payloadSchema ? this.job.payloadSchema.parse(this.payload) : this.payload
    const envelope: Envelope = envelopeOf(this.job, payload, this.queueName)
    if (this.priorityLevel !== undefined) envelope.priority = this.priorityLevel
    if (this.uniqueKey !== undefined) envelope.unique = this.uniqueKey
    if (this.triesOverride !== undefined) envelope.tries = this.triesOverride
    const options: PushOptions = { uniqueFor: this.uniqueFor }
    if (this.runAt) options.runAt = this.runAt.getTime()
    else if (this.delayMs) options.runAt = resolve(Clock).now().getTime() + this.delayMs
    if (options.runAt !== undefined && this.uniqueFor !== undefined)
      options.uniqueFor = this.uniqueFor + Math.max(0, options.runAt - resolve(Clock).now().getTime())

    const tx = currentContext()?.tx as TransactionHooks | undefined
    if (!this.now && tx && typeof tx.afterCommit === 'function') {
      tx.afterCommit(() => queue.push(envelope, options))
      return envelope.id
    }
    return queue.push(envelope, options)
  }
}
