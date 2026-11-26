import { join } from 'node:path'
import { type Application, Logger, resolve, ServiceProvider } from '@cslug/core'
import {
  type Delivery,
  LogChannel,
  ManualChannel,
  type NotificationConfig,
  type NotificationStore,
  Notifier,
} from './notifier'

/** The `cslug_notifications` and `cslug_notification_deliveries` migrations (registered with @cslug/database). */
export const NOTIFICATION_MIGRATIONS = join(import.meta.dir, '../migrations')

type QueueModule = typeof import('@cslug/queue')
let deliveryJob: Parameters<InstanceType<QueueModule['Queue']>['dispatch']>[0] | undefined

/** The job (`cslug.notification`) that delivers one queued message; defined once, when the queue is installed. */
function notificationJob(q: QueueModule) {
  if (!deliveryJob) {
    class NotificationJob extends q.Job<Delivery> {
      static jobName = 'cslug.notification'
      async handle(delivery: Delivery) {
        await resolve(Notifier).run(delivery)
      }
    }
    q.registerJob(NotificationJob)
    deliveryJob = NotificationJob as never
  }
  return deliveryJob as NonNullable<typeof deliveryJob>
}

/** Rows in the ambient transaction, through @cslug/database. */
async function databaseStore(app: Application): Promise<NotificationStore | undefined> {
  const db = await import('@cslug/database').catch(() => undefined)
  if (!db || !app.has(db.Database)) return undefined
  db.addMigrations(NOTIFICATION_MIGRATIONS)
  const { sql } = db
  const exec = (query: Parameters<InstanceType<typeof db.Database>['exec']>[0]) => app.resolve(db.Database).exec(query)
  return {
    notify: (d) =>
      exec(sql`insert into cslug_notifications (id, recipient_id, type, data)
        values (${d.id}, ${d.recipientId ?? null}, ${d.type}, ${sql.json(d.message ?? null)})`).then(() => {}),
    record: (d, status) =>
      exec(sql`insert into cslug_notification_deliveries (id, recipient_id, type, channel, status, message)
        values (${d.id}, ${d.recipientId ?? null}, ${d.type}, ${d.channel}, ${status}, ${sql.json(d.message ?? null)})`).then(
        () => {},
      ),
    mark: (id, status, error) =>
      exec(sql`update cslug_notification_deliveries set status = ${status}, error = ${error ?? null}, updated_at = now()
        where id = ${id}`).then(() => {}),
  }
}

/**
 * Binds `Notifier` with the `mail` and `database` channels and `whatsapp` / `sms` (driver `log` or `manual`,
 * config `notification`). With @cslug/database: the tables and delivery records; with @cslug/queue: one job per
 * delivery on `notification.queue`.
 */
export class NotificationProvider extends ServiceProvider {
  register() {
    this.app.singleton(Notifier, (c) => {
      const config = this.app.config<NotificationConfig | undefined>('notification') ?? {}
      const log = c.resolve(Logger)
      const notifier = new Notifier(this.app, config, log)
      for (const name of ['whatsapp', 'sms'] as const)
        notifier.extend(name, config[name]?.driver === 'manual' ? new ManualChannel() : new LogChannel(name, log))
      return notifier
    })
  }

  async boot() {
    const notifier = this.app.resolve(Notifier)
    notifier.store = await databaseStore(this.app)
    const q = await import('@cslug/queue').catch(() => undefined)
    if (!q || !this.app.has(q.Queue)) return
    const job = notificationJob(q)
    const queue = this.app.config<string | undefined>('notification.queue') ?? 'default'
    notifier.enqueue = async (delivery) => {
      await this.app
        .resolve(q.Queue)
        .dispatch(job, delivery as never)
        .onQueue(queue)
    }
  }
}
