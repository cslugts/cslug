import { type Application, Logger } from '@cslug/core'
import { type Notification, type Recipient, routeOf } from './notification'
import { type Delivery, Notifier } from './notifier'

/** A delivery the fake recorded: the recipient object, its routes, the notification and the built message. */
export type SentNotification<N extends Notification = Notification> = Delivery & { recipient: object; notification: N }

type NotificationClass<N extends Notification> = abstract new (...args: never[]) => N

const same = (a: Recipient, b: Recipient) => (a.id !== undefined ? a.id === b.id : !!a.email && a.email === b.email)

/**
 * Notifications in tests (`testApp({ fakes: ['notify'] })` → `t.notify`): messages are built for every channel (so
 * `toMail` and friends run) and recorded, never delivered.
 */
export class NotificationFake extends Notifier {
  readonly sent: SentNotification[] = []
  private current?: { recipient: object; notification: Notification }

  constructor(app: Application) {
    super(app, {}, Logger.null())
  }

  override async send(to: object, notification: Notification): Promise<void> {
    this.current = { recipient: to, notification }
    await super.send(to, notification)
  }

  protected override async deliver(delivery: Delivery): Promise<void> {
    if (this.current) this.sent.push({ ...delivery, ...this.current })
  }

  /** What was sent to `to` (same object, same `id`, else same email), optionally of one class or on one channel. */
  sentTo<N extends Notification>(to: object, cls?: NotificationClass<N>, channel?: string): SentNotification<N>[] {
    const route = routeOf(to)
    return this.sent.filter(
      (s) =>
        (s.recipient === to || same(route, s.to)) &&
        (!cls || s.notification instanceof cls) &&
        (!channel || s.channel === channel),
    ) as SentNotification<N>[]
  }

  assertSentTo<N extends Notification>(
    to: object,
    cls: NotificationClass<N>,
    options: { channel?: string; where?: (sent: SentNotification<N>) => boolean } = {},
  ): void {
    const found = this.sentTo(to, cls, options.channel)
    if (!found.some((s) => !options.where || options.where(s)))
      throw new Error(
        `Expected ${cls.name}${options.channel ? ` via ${options.channel}` : ''} to ${JSON.stringify(routeOf(to))}; sent: ${this.describe()}`,
      )
  }

  assertNotSentTo<N extends Notification>(to: object, cls: NotificationClass<N>): void {
    if (this.sentTo(to, cls).length) throw new Error(`Expected no ${cls.name} to ${JSON.stringify(routeOf(to))}`)
  }

  assertNothingSent(): void {
    if (this.sent.length) throw new Error(`Expected no notification; sent: ${this.describe()}`)
  }

  private describe(): string {
    return this.sent.map((s) => `${s.type} via ${s.channel} to ${JSON.stringify(s.to)}`).join(', ') || 'none'
  }
}

export function installNotificationFake(app: Application): NotificationFake {
  const fake = new NotificationFake(app)
  app.swap(Notifier, fake)
  return fake
}
