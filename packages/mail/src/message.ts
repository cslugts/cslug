import { CslugError } from '@cslug/core'

/** `'ada@example.test'`, `{ email, name }`, `{ address, name }`, or any row with `email` (and `name`). */
export type AddressLike = string | { email: string; name?: string | null } | { address: string; name?: string | null }
export type Address = { address: string; name?: string }

export type Attachment = { name: string; content: string | Uint8Array; type?: string }

/** A rendered email, ready for a transport (and serializable for the queue, attachments aside). */
export type Message = {
  from: Address
  to: Address[]
  cc: Address[]
  bcc: Address[]
  replyTo?: Address
  subject: string
  html?: string
  text?: string
  attachments: Attachment[]
  tags: string[]
  headers: Record<string, string>
}

export function address(value: AddressLike): Address {
  const a =
    typeof value === 'string'
      ? { address: value }
      : 'email' in value
        ? { address: value.email, name: value.name ?? undefined }
        : { address: value.address, name: value.name ?? undefined }
  if (!/^[^\s@<>]+@[^\s@<>]+$/.test(a.address))
    throw new CslugError('mail.bad_address', `"${a.address}" is not an email address`)
  return a.name ? a : { address: a.address }
}

/** RFC 2047 for non-ASCII header text. */
const encodeWord = (text: string) =>
  /^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${Buffer.from(text).toString('base64')}?=`

export const formatAddress = (a: Address) =>
  a.name ? `${/^[\w .-]*$/.test(a.name) ? `"${a.name}"` : encodeWord(a.name)} <${a.address}>` : a.address

const base64Lines = (data: string | Uint8Array) =>
  (
    Buffer.from(data)
      .toString('base64')
      .match(/.{1,76}/g) ?? []
  ).join('\r\n')

/** The full MIME message (headers + body, CRLF): multipart/alternative (text + html), mixed with attachments. */
export function toMime(message: Message, options: { messageId: string; date?: Date }): string {
  const boundary = (kind: string) => `=_cslug_${kind}_${options.messageId.replace(/\W/g, '').slice(0, 16)}`
  const headers = [
    `From: ${formatAddress(message.from)}`,
    `To: ${message.to.map(formatAddress).join(', ')}`,
    ...(message.cc.length ? [`Cc: ${message.cc.map(formatAddress).join(', ')}`] : []),
    ...(message.replyTo ? [`Reply-To: ${formatAddress(message.replyTo)}`] : []),
    `Subject: ${encodeWord(message.subject)}`,
    `Date: ${(options.date ?? new Date()).toUTCString()}`,
    `Message-ID: <${options.messageId}>`,
    'MIME-Version: 1.0',
    ...Object.entries(message.headers).map(([k, v]) => `${k}: ${encodeWord(v)}`),
  ]
  const part = (type: string, body: string | Uint8Array, extra: string[] = []) =>
    [`Content-Type: ${type}`, 'Content-Transfer-Encoding: base64', ...extra, '', base64Lines(body)].join('\r\n')
  const multipart = (kind: string, parts: string[]) => {
    const b = boundary(kind)
    return [
      `Content-Type: multipart/${kind}; boundary="${b}"`,
      '',
      ...parts.map((p) => `--${b}\r\n${p}`),
      `--${b}--`,
    ].join('\r\n')
  }
  const bodies = [
    ...(message.text !== undefined ? [part('text/plain; charset=utf-8', message.text)] : []),
    ...(message.html !== undefined ? [part('text/html; charset=utf-8', message.html)] : []),
  ]
  let body = bodies.length === 1 ? (bodies[0] as string) : multipart('alternative', bodies)
  if (message.attachments.length) {
    body = multipart('mixed', [
      body,
      ...message.attachments.map((a) =>
        part(`${a.type ?? 'application/octet-stream'}; name="${a.name}"`, a.content, [
          `Content-Disposition: attachment; filename="${a.name}"`,
        ]),
      ),
    ])
  }
  return `${headers.join('\r\n')}\r\n${body}\r\n`
}
