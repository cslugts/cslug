import {
  type Application,
  afterCommit,
  type Class,
  CslugError,
  currentLocale,
  type Logger,
  withLocale,
} from '@cslug/core'
import { type Notification, type Recipient, routeOf } from './notification'

/** Delivers one message. A `manual` channel only records it, for staff to send (status `manual`). */
export interface Channel {
  readonly manual?: boolean
  send(to: Recipient, message: unknown, delivery: Delivery): Promise<void>
}

/** One notification on one channel (a `cslug_notification_deliveries` row; the queued job's payload). */
export type Delivery = {
  id: string
  recipientId?: string
  type: string
  channel: string
  to: Recipient
  message: unknown
}
export type DeliveryStatus = 'queued' | 'sent' | 'manual' | 'failed'

/** Where deliveries and `database` notifications are stored; set by `NotificationProvider` with @cslug/database. */
export interface NotificationStore {
  notify(delivery: Delivery): Promise<void>
  record(delivery: Delivery, status: DeliveryStatus): Promise<void>
  mark(id: string, status: DeliveryStatus, error?: string): Promise<void>
}

/** `config/notification.ts`. */
export type NotificationConfig = {
  /** Queue the deliveries (default true, when @cslug/queue is installed). */
  queued?: boolean
  queue?: string
  /** Drivers of the built-in channels: `log` (default) or `manual`. */
  whatsapp?: { driver?: 'log' | 'manual' }
  sms?: { driver?: 'log' | 'manual' }
}

/** Writes each message to the log (development, and the default driver of `whatsapp` and `sms`). */
export class LogChannel implements Channel {
  constructor(
    private readonly name: string,
    private readonly log: Logger,
  ) {}
  async send(to: Recipient, message: unknown) {
    this.log.info('notification.logged', { channel: this.name, to, message })
  }
}

/** Leaves the message for staff to send by hand (status `manual` in `cslug_notification_deliveries`). */
export class ManualChannel implements Channel {
  readonly manual = true
  async send() {}
}

/**
 * Sends notifications: `notifier.send(traveller, new CheckinDueNotification(booking, 'mid_trip'))`. Each channel's
 * message is built now, in the recipient's locale; `mail` goes to the Mailer (queued), `database` is written in the
 * current transaction, other channels are delivered by a job each (`cslug.notification`) after COMMIT.
 */
export class Notifier {
  private readonly channels = new Map<string, Channel | Class<Channel>>()
  /** Set by `NotificationProvider` with @cslug/queue: queues one delivery. */
  enqueue?: (delivery: Delivery) => Promise<unknown>
  store?: NotificationStore

  constructor(
    protected readonly app: Application,
    protected readonly config: NotificationConfig,
    protected readonly log: Logger,
  ) {}

  /** Add a channel: an instance, or a class built by the container (`@inject`). */
  extend(name: string, channel: Channel | Class<Channel>): this {
    this.channels.set(name, channel)
    return this
  }

  channel(name: string): Channel {
    const channel = this.channels.get(name)
    if (!channel) throw new CslugError('notification.unknown_channel', `No notification channel "${name}"`)
    return typeof channel === 'function' ? this.app.resolve(channel) : channel
  }

  async send(to: object, notification: Notification): Promise<void> {
    const route = routeOf(to)
    for (const channel of notification.via(route)) {
      const message = await withLocale(route.locale ?? currentLocale(), async () =>
        notification.messageFor(channel, route),
      )
      await this.deliver({
        id: Bun.randomUUIDv7(),
        recipientId: route.id,
        type: notification.type,
        channel,
        to: route,
        message,
      })
    }
  }

  async sendMany(recipients: Iterable<object>, notification: Notification): Promise<void> {
    for (const to of recipients) await this.send(to, notification)
  }

  protected async deliver(delivery: Delivery): Promise<void> {
    const queued = this.config.queued !== false
    if (delivery.channel === 'mail') return this.mail(delivery, queued)
    if (delivery.channel === 'database') {
      if (!this.store) throw new CslugError('notification.no_database', 'The database channel needs @cslug/database')
      await this.store.notify(delivery)
      return this.store.record(delivery, 'sent')
    }
    this.channel(delivery.channel) // fail now on an unknown channel, not in the worker
    await this.store?.record(delivery, 'queued')
    if (queued && this.enqueue) await this.enqueue(delivery)
    else afterCommit(() => this.run(delivery).catch(() => {})) // run() has logged and recorded the failure
  }

  private async mail(delivery: Delivery, queued: boolean): Promise<void> {
    const { Mailable, Mailer } = await import('@cslug/mail').catch(() => {
      throw new CslugError('notification.no_mail', 'The mail channel needs @cslug/mail')
    })
    if (!(delivery.message instanceof Mailable))
      throw new CslugError('notification.no_message', `${delivery.type}.toMail() must return a Mailable`)
    if (!delivery.to.email)
      throw new CslugError('notification.no_route', `${delivery.type}: the recipient has no email`)
    const pending = this.app.resolve(Mailer).to(delivery.to.email).locale(delivery.to.locale)
    await (queued ? pending.queue(delivery.message) : pending.send(delivery.message))
    await this.store?.record({ ...delivery, message: null }, queued ? 'queued' : 'sent') // the mail job reports itself
  }

  /** Deliver on a channel (the job, or after COMMIT without a queue) and record the outcome. */
  async run(delivery: Delivery): Promise<void> {
    try {
      const channel = this.channel(delivery.channel)
      await channel.send(delivery.to, delivery.message, delivery)
      await this.store?.mark(delivery.id, channel.manual ? 'manual' : 'sent')
      this.log.info('notification.sent', { id: delivery.id, channel: delivery.channel, type: delivery.type })
    } catch (error) {
      await this.store?.mark(delivery.id, 'failed', error instanceof Error ? error.message : String(error))
      this.log.error('notification.failed', { id: delivery.id, channel: delivery.channel, error })
      throw error
    }
  }
}
