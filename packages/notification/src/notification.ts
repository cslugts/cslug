import { CslugError } from '@cslug/core'

/**
 * Where a notification goes. Read from the recipient object (`email`, `whatsapp` or else `phone`, `phone`,
 * `locale`, `name`, `id`); `recipient(row, fn)` sets them explicitly.
 */
export type Recipient = {
  id?: string
  email?: string
  whatsapp?: string
  phone?: string
  locale?: string
  name?: string
}

const ROUTES = Symbol('cslug.notification.routes')
type Routed = { [ROUTES]: Recipient }

/** `notifier.send(recipient(traveller, (t) => ({ whatsapp: t.whatsappOptIn ? t.phone : undefined })), n)` */
export function recipient<T extends object>(value: T, routes: (value: T) => Partial<Recipient>): T & Routed {
  return { ...value, [ROUTES]: { ...routeOf(value), ...routes(value) } }
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)

/** The routes of any recipient object. */
export function routeOf(value: object): Recipient {
  if (ROUTES in value) return (value as Routed)[ROUTES]
  const v = value as Record<string, unknown>
  const id = v.id === undefined || v.id === null ? undefined : String(v.id)
  const route: Recipient = {
    id,
    email: str(v.email),
    whatsapp: str(v.whatsapp) ?? str(v.phone),
    phone: str(v.phone),
    locale: str(v.locale),
    name: str(v.name),
  }
  return Object.fromEntries(Object.entries(route).filter(([, x]) => x !== undefined)) as Recipient
}

/**
 * A notification: `via(to)` lists channels; `to<Channel>(to)` builds each message (`toMail` a Mailable,
 * `toDatabase` / `toWhatsapp` / `toSms` / custom channels a JSON value). Messages are built when it is sent, in the
 * recipient's locale; channels then deliver them, each as its own job.
 */
export abstract class Notification {
  abstract via(to: Recipient): string[]

  /** The type stored with deliveries (`static notificationName`, else the class name). */
  get type(): string {
    const cls = this.constructor as { notificationName?: string; name: string }
    return cls.notificationName ?? cls.name
  }

  /** The message for one channel (`toWhatsapp` for `whatsapp`). */
  messageFor(channel: string, to: Recipient): unknown {
    const method = `to${channel[0]?.toUpperCase()}${channel.slice(1)}`
    const build: unknown = Reflect.get(this, method)
    if (typeof build !== 'function')
      throw new CslugError('notification.no_message', `${this.type} sends via "${channel}" but has no ${method}()`)
    return build.call(this, to)
  }
}
