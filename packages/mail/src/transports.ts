import { CslugError, type Logger } from '@cslug/core'
import { type Message, toMime } from './message'
import { type SmtpConfig, sendSmtp } from './smtp'

/** Sends a rendered message. */
export interface Transport {
  send(message: Message): Promise<{ id: string }>
}

const messageId = (from: string) => `${Bun.randomUUIDv7()}@${from.split('@')[1] ?? 'localhost'}`
const recipients = (m: Message) => [...m.to, ...m.cc, ...m.bcc].map((a) => a.address)

export class SmtpTransport implements Transport {
  constructor(private readonly config: SmtpConfig) {}
  async send(message: Message) {
    const id = messageId(message.from.address)
    await sendSmtp(
      this.config,
      { from: message.from.address, to: recipients(message) },
      toMime(message, { messageId: id }),
    )
    return { id }
  }
}

/** Writes each message to the log (development). */
export class LogTransport implements Transport {
  constructor(private readonly log: Logger) {}
  async send(message: Message) {
    const id = messageId(message.from.address)
    this.log.info('mail.sent', { id, to: recipients(message), subject: message.subject, text: message.text })
    return { id }
  }
}

/** Keeps messages in memory (`transport.messages`). */
export class ArrayTransport implements Transport {
  readonly messages: Message[] = []
  async send(message: Message) {
    this.messages.push(message)
    return { id: messageId(message.from.address) }
  }
}

type ApiConfig = { apiKey: string; endpoint?: string }
const b64 = (content: string | Uint8Array) => Buffer.from(content).toString('base64')
const named = (a: { address: string; name?: string }) => (a.name ? `${a.name} <${a.address}>` : a.address)

async function post(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  pick: (r: Record<string, unknown>) => unknown,
) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok)
    throw new CslugError('mail.transport', `${new URL(url).host} answered ${res.status}: ${text.slice(0, 300)}`)
  const id = text ? pick(JSON.parse(text) as Record<string, unknown>) : undefined
  return { id: String(id ?? '') }
}

/** Resend (`POST /emails`). */
export class ResendTransport implements Transport {
  constructor(private readonly config: ApiConfig) {}
  send(m: Message) {
    return post(
      `${this.config.endpoint ?? 'https://api.resend.com'}/emails`,
      { authorization: `Bearer ${this.config.apiKey}` },
      {
        from: named(m.from),
        to: m.to.map(named),
        cc: m.cc.map(named),
        bcc: m.bcc.map(named),
        reply_to: m.replyTo ? named(m.replyTo) : undefined,
        subject: m.subject,
        html: m.html,
        text: m.text,
        headers: m.headers,
        tags: m.tags.map((t) => ({ name: 'tag', value: t })),
        attachments: m.attachments.map((a) => ({ filename: a.name, content: b64(a.content) })),
      },
      (r) => r.id,
    )
  }
}

/** Postmark (`POST /email`). */
export class PostmarkTransport implements Transport {
  constructor(private readonly config: ApiConfig) {}
  send(m: Message) {
    return post(
      `${this.config.endpoint ?? 'https://api.postmarkapp.com'}/email`,
      { 'x-postmark-server-token': this.config.apiKey, accept: 'application/json' },
      {
        From: named(m.from),
        To: m.to.map(named).join(','),
        Cc: m.cc.map(named).join(',') || undefined,
        Bcc: m.bcc.map(named).join(',') || undefined,
        ReplyTo: m.replyTo ? named(m.replyTo) : undefined,
        Subject: m.subject,
        HtmlBody: m.html,
        TextBody: m.text,
        Tag: m.tags[0],
        Headers: Object.entries(m.headers).map(([Name, Value]) => ({ Name, Value })),
        Attachments: m.attachments.map((a) => ({
          Name: a.name,
          Content: b64(a.content),
          ContentType: a.type ?? 'application/octet-stream',
        })),
      },
      (r) => r.MessageID,
    )
  }
}

/** Brevo (`POST /v3/smtp/email`). */
export class BrevoTransport implements Transport {
  constructor(private readonly config: ApiConfig) {}
  send(m: Message) {
    const person = (a: { address: string; name?: string }) => ({
      email: a.address,
      ...(a.name ? { name: a.name } : {}),
    })
    return post(
      `${this.config.endpoint ?? 'https://api.brevo.com'}/v3/smtp/email`,
      { 'api-key': this.config.apiKey, accept: 'application/json' },
      {
        sender: person(m.from),
        to: m.to.map(person),
        cc: m.cc.length ? m.cc.map(person) : undefined,
        bcc: m.bcc.length ? m.bcc.map(person) : undefined,
        replyTo: m.replyTo ? person(m.replyTo) : undefined,
        subject: m.subject,
        htmlContent: m.html,
        textContent: m.text,
        headers: Object.keys(m.headers).length ? m.headers : undefined,
        tags: m.tags.length ? m.tags : undefined,
        attachment: m.attachments.length
          ? m.attachments.map((a) => ({ name: a.name, content: b64(a.content) }))
          : undefined,
      },
      (r) => r.messageId,
    )
  }
}

/** `config/mail.ts` → `transports.<name>`: the driver is the name unless `driver` says otherwise. */
export type TransportConfig = { driver?: string } & Record<string, unknown>

export function createTransport(name: string, config: TransportConfig, log: Logger): Transport {
  switch (config.driver ?? name) {
    case 'smtp':
      return new SmtpTransport(config as unknown as SmtpConfig)
    case 'resend':
      return new ResendTransport(config as unknown as ApiConfig)
    case 'postmark':
      return new PostmarkTransport(config as unknown as ApiConfig)
    case 'brevo':
      return new BrevoTransport(config as unknown as ApiConfig)
    case 'log':
      return new LogTransport(log)
    case 'array':
      return new ArrayTransport()
    default:
      throw new CslugError(
        'mail.unknown_transport',
        `Unknown mail transport "${config.driver ?? name}" (smtp, resend, postmark, brevo, log, array)`,
      )
  }
}
