import { type Application, afterCommit, CslugError, currentLocale, type Logger, withLocale } from '@cslug/core'
import { htmlToText, inlineCss } from './html'
import { type Mailable, type MailableClass, PARTS } from './mailable'
import { type Address, type AddressLike, address, type Message } from './message'
import type { Transport } from './transports'

/** `config/mail.ts`. */
export type MailConfig = {
  from?: { address: string; name?: string }
  /** The transport to use (a key of `transports`). */
  transport?: string
  transports?: Record<string, Record<string, unknown>>
  /** The queue for queued mail. Default `'default'`. */
  queue?: string
  /** Queue every mail unless its class says `static queued = false`. Default false. */
  queued?: boolean
}

/** Render a mailable for these recipients, in `locale`: build(), the Vue view, CSS inlined, text part. */
export async function renderMail(
  mailable: Mailable,
  recipients: { to: Address[]; cc?: Address[]; bcc?: Address[] },
  options: { locale?: string; from?: Address } = {},
): Promise<Message> {
  const render = async (): Promise<Message> => {
    await mailable.build()
    const parts = mailable[PARTS]
    let html = parts.html
    if (parts.view) {
      const vue = await import('@cslug/vue').catch(() => {
        throw new CslugError('mail.no_vue', '.view() needs @cslug/vue (VueProvider); use .html() otherwise')
      })
      html = await vue.renderStandalone(parts.view.component as never, parts.view.props)
    }
    if (html !== undefined) html = await inlineCss(html)
    const from = parts.from ?? options.from
    if (!from) throw new CslugError('mail.no_from', 'No sender: set config mail.from or call .from() in build()')
    if (!parts.subject) throw new CslugError('mail.no_subject', `${mailable.constructor.name}.build() sets no subject`)
    return {
      from,
      to: recipients.to,
      cc: recipients.cc ?? [],
      bcc: recipients.bcc ?? [],
      replyTo: parts.replyTo,
      subject: parts.subject,
      html,
      text: parts.text ?? (html !== undefined ? htmlToText(html) : undefined),
      attachments: await Promise.all(parts.attachments.map(async (a) => ({ ...a, content: await a.content }))),
      tags: parts.tags,
      headers: parts.headers,
    }
  }
  return options.locale ? withLocale(options.locale, render) : render()
}

/** What `Mailer` hands over for delivery (the fake records it). */
export type Outgoing = { mailable: Mailable; message: Message; locale: string; queued: boolean }

/**
 * Sends mail: `mailer.to(traveller).locale(traveller.locale).send(new BookingConfirmedMail(booking))`.
 * Queued mail (`static queued = true`, or `mail.queued`) is rendered now and sent by a worker; inside a transaction
 * it waits for COMMIT. Without @cslug/queue it is sent after COMMIT in this process.
 */
export class Mailer {
  /** Set by `MailProvider` when @cslug/queue is installed: puts a rendered message on the queue. */
  enqueue?: (message: Message, queue: string) => Promise<unknown>

  constructor(
    protected readonly app: Application,
    protected readonly config: MailConfig,
    readonly transport: Transport,
    protected readonly log: Logger,
  ) {}

  to(...recipients: (AddressLike | AddressLike[])[]): PendingMail {
    return new PendingMail(this, recipients.flat().map(address))
  }

  /** Render and deliver (used by `PendingMail.send`). */
  async dispatch(
    mailable: Mailable,
    to: Address[],
    options: { cc?: Address[]; bcc?: Address[]; locale?: string; now?: boolean } = {},
  ) {
    if (!to.length)
      throw new CslugError('mail.no_recipient', `${mailable.constructor.name}: no recipient (mailer.to(…))`)
    const locale = options.locale ?? currentLocale()
    const from = this.config.from ? address(this.config.from) : undefined
    const message = await renderMail(mailable, { to, cc: options.cc, bcc: options.bcc }, { locale, from })
    const cls = mailable.constructor as MailableClass
    const queued = !options.now && (cls.queued ?? this.config.queued ?? false)
    await this.deliver({ mailable, message, locale, queued })
  }

  /** Hand a rendered message over: queue it, or send it with the transport. */
  protected async deliver({ message, queued }: Outgoing): Promise<void> {
    if (!queued) {
      await this.send(message)
      return
    }
    if (this.enqueue) await this.enqueue(message, this.config.queue ?? 'default')
    else
      afterCommit(() =>
        this.send(message).catch((error) => this.log.error('mail.failed', { error, subject: message.subject })),
      )
  }

  /** Send a rendered message now. */
  async send(message: Message): Promise<{ id: string }> {
    const result = await this.transport.send(message)
    this.log.info('mail.sent', { id: result.id, to: message.to.map((a) => a.address), subject: message.subject })
    return result
  }
}

/** `mailer.to(…)`: add recipients, a locale, then `send()`. */
export class PendingMail {
  private copies: Address[] = []
  private blind: Address[] = []
  private lang?: string

  constructor(
    private readonly mailer: Mailer,
    private readonly recipients: Address[],
  ) {}

  cc(...addresses: AddressLike[]): this {
    this.copies.push(...addresses.map(address))
    return this
  }
  bcc(...addresses: AddressLike[]): this {
    this.blind.push(...addresses.map(address))
    return this
  }
  /** Render in this locale (default: the current one). */
  locale(locale: string | null | undefined): this {
    if (locale) this.lang = locale
    return this
  }
  /** Send (or queue, for queued mailables). */
  send(mailable: Mailable): Promise<void> {
    return this.mailer.dispatch(mailable, this.recipients, { cc: this.copies, bcc: this.blind, locale: this.lang })
  }
  /** Send now, even if the mailable is queued. */
  sendNow(mailable: Mailable): Promise<void> {
    return this.mailer.dispatch(mailable, this.recipients, {
      cc: this.copies,
      bcc: this.blind,
      locale: this.lang,
      now: true,
    })
  }
}
