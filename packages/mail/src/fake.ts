import { type Application, Logger } from '@cslug/core'
import type { Mailable } from './mailable'
import { Mailer, type Outgoing } from './mailer'
import type { Attachment } from './message'
import { ArrayTransport } from './transports'

/** A mail the fake recorded. `to` is the first recipient's address; `recipients` all of them. */
export type SentMail<M extends Mailable = Mailable> = {
  mailable: M
  to: string
  recipients: string[]
  cc: string[]
  bcc: string[]
  subject: string
  html?: string
  text?: string
  attachments: Attachment[]
  locale: string
  queued: boolean
}

type MailableCtor<M extends Mailable> = abstract new (...args: never[]) => M

/**
 * Mail in tests (`testApp({ fakes: ['mail'] })` → `t.mail`): every mail is rendered (so templates are exercised)
 * and recorded, never sent.
 */
export class MailFake extends Mailer {
  readonly sent: SentMail[] = []

  constructor(app: Application, from = app.config<{ address: string; name?: string } | undefined>('mail.from')) {
    super(app, { from: from ?? { address: 'test@example.test' } }, new ArrayTransport(), Logger.null())
  }

  protected override async deliver({ mailable, message, locale, queued }: Outgoing): Promise<void> {
    this.sent.push({
      mailable,
      to: message.to[0]?.address ?? '',
      recipients: message.to.map((a) => a.address),
      cc: message.cc.map((a) => a.address),
      bcc: message.bcc.map((a) => a.address),
      subject: message.subject,
      html: message.html,
      text: message.text,
      attachments: message.attachments,
      locale,
      queued,
    })
  }

  of<M extends Mailable>(cls: MailableCtor<M>, queued?: boolean): SentMail<M>[] {
    return this.sent.filter(
      (m) => m.mailable instanceof cls && (queued === undefined || m.queued === queued),
    ) as SentMail<M>[]
  }

  private check<M extends Mailable>(
    cls: MailableCtor<M>,
    queued: boolean | undefined,
    predicate?: (m: SentMail<M>) => boolean,
  ) {
    const all = this.of(cls, queued)
    if (!all.some((m) => !predicate || predicate(m))) {
      const seen = this.sent.map(
        (m) => `${m.mailable.constructor.name} to ${m.to} "${m.subject}"${m.queued ? ' (queued)' : ''}`,
      )
      const how = queued === undefined ? 'sent or queued' : queued ? 'queued' : 'sent'
      throw new Error(
        `Expected ${cls.name} to be ${how}${predicate ? ' matching the predicate' : ''}; mail: ${seen.join(', ') || 'none'}`,
      )
    }
  }

  /** Sent now (not queued). */
  assertSent<M extends Mailable>(cls: MailableCtor<M>, predicate?: (m: SentMail<M>) => boolean): void {
    this.check(cls, false, predicate)
  }
  /** Queued (`static queued = true`). */
  assertQueued<M extends Mailable>(cls: MailableCtor<M>, predicate?: (m: SentMail<M>) => boolean): void {
    this.check(cls, true, predicate)
  }
  assertSentCount<M extends Mailable>(cls: MailableCtor<M>, count: number): void {
    const n = this.of(cls, false).length
    if (n !== count) throw new Error(`Expected ${cls.name} to be sent ${count} time(s), got ${n}`)
  }
  assertQueuedCount<M extends Mailable>(cls: MailableCtor<M>, count: number): void {
    const n = this.of(cls, true).length
    if (n !== count) throw new Error(`Expected ${cls.name} to be queued ${count} time(s), got ${n}`)
  }
  /** Neither sent nor queued. */
  assertNotSent<M extends Mailable>(cls: MailableCtor<M>): void {
    const n = this.of(cls).length
    if (n) throw new Error(`Expected ${cls.name} not to be sent, got ${n}`)
  }
  assertNothingSent(): void {
    if (this.sent.length)
      throw new Error(`Expected no mail; got ${this.sent.map((m) => m.mailable.constructor.name).join(', ')}`)
  }
}

/** For `@cslug/testing`: swap the mailer for a fake and return it. */
export function installMailFake(app: Application): MailFake {
  const fake = new MailFake(app)
  app.swap(Mailer, fake)
  return fake
}
