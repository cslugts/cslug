import { join } from 'node:path'
import { Clock, type Duration, inject, NotFoundError, parseDuration } from '@cslug/core'
import { Database, sql } from '@cslug/database'

export const WEBHOOK_MIGRATIONS = join(import.meta.dir, '../migrations')

/** What processes an event: run in the receiving transaction, and again by `webhooks:replay`. */
export type WebhookProcessor = (externalId: string, payload: unknown) => unknown

/**
 * Exactly-once receipt of webhook events: each `(source, externalId)` is stored once (`cslug_webhook_inbox`,
 * unique); a replay of the same event does nothing. Respond 200 fast and do the work in a (durable) job.
 */
@inject(Database, Clock)
export class WebhookInbox {
  private readonly processors = new Map<string, WebhookProcessor>()

  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  /** The processor of a source (in a provider's `boot()`), used by `receive()` without `then` and by replays. */
  process(source: string, processor: WebhookProcessor): this {
    this.processors.set(source, processor)
    return this
  }

  /**
   * Store the event; if it is new, run `then` (else the source's processor) in the same transaction, so a durable
   * job and the inbox row commit together. Returns false for a replay (nothing runs).
   *
   * ```ts
   * await this.inbox.receive('payments', event.id, event, () => ProcessPaymentEventJob.dispatch({ eventId: event.id }).durable())
   * ```
   */
  async receive(source: string, externalId: string, payload: unknown, then?: () => unknown): Promise<boolean> {
    return this.db.transaction(async () => {
      const id = await this.db.value(
        sql`insert into cslug_webhook_inbox (id, source, external_id, payload)
            values (${Bun.randomUUIDv7()}, ${source}, ${externalId}, ${sql.json(payload)})
            on conflict (source, external_id) do nothing returning id`,
      )
      if (id === undefined) return false
      if (then) await then()
      else await this.processors.get(source)?.(externalId, payload)
      return true
    })
  }

  /** The stored payload, validated by `schema` if given (`v` schema or anything with `parse`). */
  async payload<T = unknown>(source: string, externalId: string, schema?: { parse(value: unknown): T }): Promise<T> {
    const row = await this.db.maybeOne<{ payload: unknown }>(
      sql`select payload from cslug_webhook_inbox where source = ${source} and external_id = ${externalId}`,
    )
    if (!row) throw new NotFoundError('webhook.not_found', `No ${source} webhook event ${externalId}`)
    return schema ? schema.parse(row.payload) : (row.payload as T)
  }

  /** Run the source's processor again for a stored event (after a bug fix), in a transaction. */
  async replay(source: string, externalId: string): Promise<void> {
    const processor = this.processors.get(source)
    if (!processor)
      throw new NotFoundError('webhook.no_processor', `No processor for ${source}: register one with inbox.process()`)
    const payload = await this.payload(source, externalId)
    await this.db.transaction(async () => {
      await processor(externalId, payload)
      await this.db.exec(
        sql`update cslug_webhook_inbox set replayed_at = ${this.clock.now()}
            where source = ${source} and external_id = ${externalId}`,
      )
    })
  }

  /** Delete events received more than `olderThan` ago (a replay after that is processed again). Returns the count. */
  async prune(olderThan: Duration, source?: string): Promise<number> {
    const before = new Date(this.clock.now().getTime() - parseDuration(olderThan))
    return this.db.exec(
      sql`delete from cslug_webhook_inbox where received_at < ${before}${source ? sql` and source = ${source}` : sql``}`,
    )
  }
}
