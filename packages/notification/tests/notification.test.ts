import { afterAll, describe, expect, test } from 'bun:test'
import { Application, currentLocale, inject, Logger, type ProviderClass } from '@cslug/core'
import { Database, DatabaseProvider, sql } from '@cslug/database'
import { Mailable, MailProvider } from '@cslug/mail'
import { QueueProvider } from '@cslug/queue'
import { RedisProvider } from '@cslug/redis'
import { testApp } from '@cslug/testing'
import { SQL } from 'bun'
import {
  type Channel,
  type Delivery,
  Notification,
  NotificationProvider,
  Notifier,
  type Recipient,
  recipient,
  routeOf,
} from '../src'

type Traveller = { id: string; name: string; email: string; phone?: string; whatsappOptIn?: boolean; locale?: string }
const ada: Traveller = { id: 't1', name: 'Ada', email: 'ada@example.test', phone: '+261340000001', locale: 'fr' }
const bob: Traveller = { id: 't2', name: 'Bob', email: 'bob@example.test' }

class CheckinMail extends Mailable {
  constructor(private readonly ref: string) {
    super()
  }
  build() {
    return this.subject(`Check-in ${this.ref}`).text(`How is ${this.ref} going?`)
  }
}

/** Guide 14's check-in: WhatsApp when there is a number, else mail; always stored. */
class CheckinDueNotification extends Notification {
  constructor(private readonly ref: string) {
    super()
  }
  via(to: Recipient) {
    return to.whatsapp ? ['whatsapp', 'database'] : ['mail', 'database']
  }
  toWhatsapp() {
    return { template: 'checkin_mid_trip', params: [this.ref], locale: currentLocale() }
  }
  toMail() {
    return new CheckinMail(this.ref)
  }
  toDatabase() {
    return { ref: this.ref }
  }
}

class PingNotification extends Notification {
  static notificationName = 'ping'
  constructor(private readonly channel: string) {
    super()
  }
  via() {
    return [this.channel]
  }
  toSms() {
    return { text: 'ping' }
  }
  toFax() {
    return {}
  }
  toSlack(to: Recipient) {
    return { text: `ping ${to.name}` }
  }
}

describe('recipients and messages', () => {
  test('routes are read from the object; whatsapp falls back to phone', () => {
    expect(routeOf(ada)).toEqual({
      id: 't1',
      email: 'ada@example.test',
      whatsapp: '+261340000001',
      phone: '+261340000001',
      locale: 'fr',
      name: 'Ada',
    })
    expect(routeOf({ id: 7 })).toEqual({ id: '7' })
  })

  test('recipient(row, fn) sets routes explicitly', () => {
    const optedOut = recipient(ada, (t: Traveller) => ({ whatsapp: t.whatsappOptIn ? t.phone : undefined }))
    expect(optedOut.name).toBe('Ada')
    expect(routeOf(optedOut).whatsapp).toBeUndefined()
    expect(routeOf(optedOut).email).toBe('ada@example.test')
  })

  test('messageFor finds to<Channel>(); a missing one is explained', () => {
    const n = new PingNotification('sms')
    expect(n.type).toBe('ping')
    expect(new CheckinDueNotification('ALB-1').type).toBe('CheckinDueNotification')
    expect(n.messageFor('slack', { name: 'Ada' })).toEqual({ text: 'ping Ada' })
    expect(() => n.messageFor('whatsapp', {})).toThrow('ping sends via "whatsapp" but has no toWhatsapp()')
  })
})

const lines: string[] = []
const notifyApp = (configs: Record<string, unknown> = {}, providers: ProviderClass[] = []) => {
  const app = new Application({
    root: '/nonexistent-cslug-test-root',
    configs: { app: { env: 'test', locale: 'en' }, mail: { from: { address: 'hello@example.test' } }, ...configs },
  })
  app.useProviders([MailProvider, NotificationProvider, ...providers])
  app.singleton(Logger, () => new Logger({ write: (line) => lines.push(line) }))
  return app
}

describe('the notify fake (guide 14)', () => {
  const t = testApp({ create: () => notifyApp(), fakes: ['notify'] })

  test('assertSentTo per channel; messages built in the recipient locale', async () => {
    await t.resolve(Notifier).send(ada, new CheckinDueNotification('ALB-1'))
    await t.resolve(Notifier).send(bob, new CheckinDueNotification('ALB-2'))
    t.notify.assertSentTo(ada, CheckinDueNotification, { channel: 'whatsapp' })
    t.notify.assertSentTo({ id: 't1' }, CheckinDueNotification, {
      channel: 'whatsapp',
      where: (s) => (s.message as { locale: string }).locale === 'fr',
    })
    t.notify.assertSentTo(bob, CheckinDueNotification, { channel: 'mail' })
    expect(t.notify.sentTo(bob, CheckinDueNotification, 'mail')[0]?.message).toBeInstanceOf(CheckinMail)
    expect(() => t.notify.assertSentTo(bob, CheckinDueNotification, { channel: 'whatsapp' })).toThrow(
      'Expected CheckinDueNotification via whatsapp',
    )
    t.notify.assertNotSentTo({ id: 't3' }, CheckinDueNotification)
  })

  test('sendMany; assertNothingSent', async () => {
    t.notify.assertNothingSent()
    await t.resolve(Notifier).sendMany([ada, bob], new PingNotification('sms'))
    expect(t.notify.sent.map((s) => s.to.id)).toEqual(['t1', 't2'])
  })
})

describe('channels without a queue or a database', () => {
  test('whatsapp and sms log by default; custom channels; unknown channel and missing tables explained', async () => {
    const sent: Delivery[] = []
    @inject(Logger)
    class SlackChannel implements Channel {
      constructor(readonly log: Logger) {}
      async send(_to: Recipient, _message: unknown, delivery: Delivery) {
        sent.push(delivery)
      }
    }
    const app = await notifyApp().start()
    const notifier = app.resolve(Notifier).extend('slack', SlackChannel)
    await notifier.send(ada, new PingNotification('slack'))
    await notifier.send(ada, new PingNotification('sms'))
    await Bun.sleep(5) // delivered after COMMIT (here: right after)
    expect(sent.map((d) => [d.type, d.channel, d.message])).toEqual([['ping', 'slack', { text: 'ping Ada' }]])
    expect(lines.some((l) => l.includes('notification.logged') && l.includes('"channel":"sms"'))).toBe(true)

    expect(notifier.send(ada, new PingNotification('fax'))).rejects.toThrow('No notification channel "fax"')
    expect(notifier.send(ada, new CheckinDueNotification('ALB-1'))).rejects.toThrow(
      'The database channel needs @cslug/database',
    )
  })
})

describe('mail through the Mailer', () => {
  const t = testApp({ create: () => notifyApp(), fakes: ['mail'] })
  test('queued to the recipient email, in the recipient locale', async () => {
    await t.resolve(Notifier).send({ ...bob, locale: 'fr' }, new PingMail())
    t.mail.assertQueued(CheckinMail, (m) => m.to === 'bob@example.test' && m.locale === 'fr')
  })
})

class PingMail extends Notification {
  via() {
    return ['mail']
  }
  toMail() {
    return new CheckinMail('ALB-9')
  }
}

const DATABASE_URL = process.env.DATABASE_URL
const REDIS_URL = process.env.REDIS_URL

describe.skipIf(!DATABASE_URL || !REDIS_URL)('with @cslug/database and @cslug/queue', () => {
  const name = `cslug_notification_${process.pid}`
  const admin = DATABASE_URL
    ? new SQL(Object.assign(new URL(DATABASE_URL), { pathname: '/postgres' }).toString(), { max: 1 })
    : undefined
  afterAll(async () => {
    await admin?.unsafe(`drop database if exists "${name}" with (force)`)
    await admin?.close()
  })
  const t = testApp({
    async create() {
      await admin?.unsafe(`drop database if exists "${name}" with (force)`)
      await admin?.unsafe(`create database "${name}"`)
      return notifyApp(
        {
          database: { url: Object.assign(new URL(DATABASE_URL as string), { pathname: `/${name}` }).toString() },
          redis: { connections: { default: { url: REDIS_URL } }, prefix: `cslug-notiftest:${process.pid}:` },
          notification: { queue: 'notifications', sms: { driver: 'manual' } },
        },
        [DatabaseProvider, RedisProvider, QueueProvider],
      )
    },
    fakes: ['queue', 'mail'],
  })
  const deliveries = () =>
    t
      .resolve(Database)
      .many<{ channel: string; status: string; error: string | null }>(
        sql`select channel, status, error from cslug_notification_deliveries order by channel`,
      )

  test('database rows and delivery records; whatsapp is one job on notification.queue', async () => {
    await t.resolve(Notifier).send(ada, new CheckinDueNotification('ALB-1'))
    await t.assertDatabaseHas('cslug_notifications', { recipientId: 't1', type: 'CheckinDueNotification' })
    expect(await deliveries()).toEqual([
      { channel: 'database', status: 'sent', error: null },
      { channel: 'whatsapp', status: 'queued', error: null },
    ])
    const [job] = t.queue.pushed
    expect([job?.job.jobName, job?.queue]).toEqual(['cslug.notification', 'notifications'])
    await t.queue.drain()
    expect((await deliveries())[1]?.status).toBe('sent')
  })

  test('mail goes through the Mailer (its own job); the manual driver leaves sms for staff', async () => {
    await t.resolve(Notifier).send(bob, new CheckinDueNotification('ALB-2'))
    t.mail.assertQueued(CheckinMail)
    await t.resolve(Notifier).send(bob, new PingNotification('sms'))
    await t.queue.drain()
    expect(await deliveries()).toContainEqual({ channel: 'sms', status: 'manual', error: null })
  })

  test('a failing channel is recorded as failed, with the error', async () => {
    t.resolve(Notifier).extend('slack', {
      async send() {
        throw new Error('slack is down')
      },
    })
    await t.resolve(Notifier).send(ada, new PingNotification('slack'))
    await t.queue.drain().catch(() => {})
    expect(await deliveries()).toEqual([{ channel: 'slack', status: 'failed', error: 'slack is down' }])
  })
})
