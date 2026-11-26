import { join } from 'node:path'
import type { Application, Logger } from '@cslug/core'
import { decode, encode } from '@cslug/redis'
import { type Envelope, type PushOptions, Queue } from './queue'

type DatabaseModule = typeof import('@cslug/database')

/** The outbox table's migration folder (registered with `addMigrations` when `@cslug/database` is present). */
export const OUTBOX_MIGRATIONS = join(import.meta.dir, '../migrations')

/**
 * Durable dispatch (`.durable()`): the job is written to `cslug_queue_outbox` in the current transaction, so it
 * exists if and only if the transaction commits; it is then relayed to the queue (at once after COMMIT, and by
 * workers every second for anything left behind) and deleted. Relaying is at least once.
 */
export class Outbox {
  constructor(
    private readonly app: Application,
    private readonly db: DatabaseModule,
    private readonly log: Logger,
  ) {}

  /** The outbox when `@cslug/database` is installed and `Database` is bound (optional integration, rule 3). */
  static async detect(app: Application, log: Logger): Promise<Outbox | undefined> {
    try {
      const db = await import('@cslug/database')
      return app.has(db.Database) ? new Outbox(app, db, log) : undefined
    } catch {
      return undefined
    }
  }

  /** The `cslug_queue_outbox` table is created by `cslug migrate`. */
  registerMigrations(): void {
    this.db.addMigrations(OUTBOX_MIGRATIONS)
  }

  /** Insert in the ambient transaction. */
  async write(envelope: Envelope, options: PushOptions): Promise<void> {
    const { sql, Database } = this.db
    await this.app
      .resolve(Database)
      .exec(
        sql`insert into cslug_queue_outbox (id, envelope, options) values (${envelope.id}, ${encode(envelope)}, ${encode(options)})`,
      )
  }

  /** Push waiting rows (one, or up to `limit`) to the queue and delete them. Returns how many. */
  async relay(only?: string, limit = 100): Promise<number> {
    const { sql, Database } = this.db
    const db = this.app.resolve(Database)
    const queue = this.app.resolve(Queue)
    return db.transaction(async () => {
      const rows = await db.many<{ id: string; envelope: string; options: string }>(
        sql`select id, envelope, options from cslug_queue_outbox ${only ? sql`where id = ${only}` : sql``}
            order by created_at limit ${limit} for update skip locked`,
      )
      for (const row of rows) {
        await queue.push(decode<Envelope>(row.envelope) as Envelope, decode<PushOptions>(row.options) ?? {})
        await db.exec(sql`delete from cslug_queue_outbox where id = ${row.id}`)
      }
      if (rows.length) this.log.debug('queue.outbox.relayed', { count: rows.length })
      return rows.length
    })
  }
}
