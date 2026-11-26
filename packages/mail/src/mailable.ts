import { type Address, type AddressLike, type Attachment, address } from './message'

/** The key under which a mailable keeps what build() collected (a string, like Standard Schema's '~standard'). */
export const PARTS = '~mail'

/** What `build()` collected. */
export type MailParts = {
  subject?: string
  view?: { component: unknown; props: Record<string, unknown> }
  html?: string
  text?: string
  attachments: (Omit<Attachment, 'content'> & { content: string | Uint8Array | PromiseLike<string | Uint8Array> })[]
  tags: string[]
  from?: Address
  replyTo?: Address
  headers: Record<string, string>
}

/**
 * One email: a class whose `build()` sets the subject and the content (a Vue view, or HTML/text).
 *
 * ```ts
 * export class TodoDueMail extends Mailable {
 *   static queued = true                         // optional: sent by the worker
 *   constructor(private name: string, private items: DueItem[]) { super() }
 *   build() { return this.subject(t('mail.todo_due.subject')).view(TodoDue, { name: this.name, items: this.items }) }
 * }
 * ```
 *
 * `static queued` and `static preview()` are not declared here, so `noImplicitOverride` apps need no `override`.
 */
export abstract class Mailable {
  readonly '~mail': MailParts = { attachments: [], tags: [], headers: {} }

  /** Set the subject and content; runs in the recipient's locale (`t()` translates for them). */
  abstract build(): this | Promise<this>

  subject(subject: string): this {
    this[PARTS].subject = subject
    return this
  }
  /** A Vue SFC rendered to HTML (needs @cslug/vue); its `<style>` is inlined. */
  view(component: unknown, props: Record<string, unknown> = {}): this {
    this[PARTS].view = { component, props }
    return this
  }
  html(html: string): this {
    this[PARTS].html = html
    return this
  }
  /** The plain-text part (default: derived from the HTML). */
  text(text: string): this {
    this[PARTS].text = text
    return this
  }
  attach(
    content: string | Uint8Array | PromiseLike<string | Uint8Array>,
    options: { name: string; type?: string },
  ): this {
    this[PARTS].attachments.push({ content, ...options })
    return this
  }
  tag(tag: string): this {
    this[PARTS].tags.push(tag)
    return this
  }
  from(from: AddressLike): this {
    this[PARTS].from = address(from)
    return this
  }
  replyTo(to: AddressLike): this {
    this[PARTS].replyTo = address(to)
    return this
  }
  header(name: string, value: string): this {
    this[PARTS].headers[name] = value
    return this
  }
}

/** A mailable class, with its optional statics. */
export type MailableClass = (abstract new (
  ...args: never[]
) => Mailable) & {
  readonly queued?: boolean
  /** An example instance for `cslug mail:preview`. */
  preview?(): Mailable | Promise<Mailable>
}
