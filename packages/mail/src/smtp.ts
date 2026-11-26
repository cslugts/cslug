import { CslugError } from '@cslug/core'
import type { Socket } from 'bun'

export type SmtpConfig = {
  host: string
  port?: number
  user?: string
  password?: string
  /** `true`: TLS from the start (port 465). Otherwise STARTTLS is used when the server offers it. */
  secure?: boolean
  /** `false`: refuse to send when STARTTLS is not offered (default: send in clear only to localhost). */
  allowPlain?: boolean
  /** Name sent in EHLO. Default: `localhost`. */
  helo?: string
  timeout?: number
}

export class SmtpError extends CslugError {
  constructor(
    message: string,
    readonly reply?: string,
  ) {
    super('mail.smtp', message)
  }
}

type Reply = { code: number; text: string }

/**
 * A minimal SMTP client on `Bun.connect`: EHLO, STARTTLS (`socket.upgradeTLS`) or implicit TLS, AUTH PLAIN /
 * LOGIN, MAIL FROM, RCPT TO, DATA (dot-stuffed), QUIT. One connection per message.
 */
export async function sendSmtp(
  config: SmtpConfig,
  envelope: { from: string; to: string[] },
  mime: string,
): Promise<string> {
  let buffer = ''
  let waiting: ((r: Reply) => void) | undefined
  let failed: ((e: Error) => void) | undefined
  const replies: Reply[] = []
  const onData = (_s: Socket, data: Buffer) => {
    buffer += data.toString('utf8')
    // a complete reply ends with a line "NNN text" (not "NNN-text")
    const m = /(?:^|\r\n)(\d{3}) [^\r\n]*\r\n$/.exec(buffer)
    if (!m) return
    const reply = { code: Number(m[1]), text: buffer.trim() }
    buffer = ''
    if (waiting) {
      const w = waiting
      waiting = undefined
      w(reply)
    } else replies.push(reply)
  }
  const handlers = {
    data: onData,
    error: (_s: Socket, e: Error) => failed?.(e),
    close: () => failed?.(new SmtpError('The SMTP server closed the connection')),
  }
  let socket: Socket = await Bun.connect({
    hostname: config.host,
    port: config.port ?? (config.secure ? 465 : 587),
    tls: config.secure ? { serverName: config.host } : undefined,
    socket: handlers,
  })
  const timeout = config.timeout ?? 30_000
  const read = () =>
    new Promise<Reply>((resolve, reject) => {
      const queued = replies.shift()
      if (queued) return resolve(queued)
      const timer = setTimeout(() => reject(new SmtpError('The SMTP server did not answer in time')), timeout)
      waiting = (r) => {
        clearTimeout(timer)
        resolve(r)
      }
      failed = (e) => {
        clearTimeout(timer)
        reject(e)
      }
    })
  const command = async (line: string, expect: number[], shown = line) => {
    socket.write(`${line}\r\n`)
    const reply = await read()
    if (!expect.includes(reply.code))
      throw new SmtpError(`SMTP ${shown.split(' ')[0]} failed: ${reply.text}`, reply.text)
    return reply
  }

  try {
    const greeting = await read()
    if (greeting.code !== 220) throw new SmtpError(`SMTP greeting: ${greeting.text}`, greeting.text)
    const helo = config.helo ?? 'localhost'
    let ehlo = await command(`EHLO ${helo}`, [250])
    if (!config.secure) {
      if (/STARTTLS/i.test(ehlo.text)) {
        await command('STARTTLS', [220])
        const [, tls] = socket.upgradeTLS({ tls: { serverName: config.host }, socket: handlers })
        socket = tls
        ehlo = await command(`EHLO ${helo}`, [250])
      } else if (config.allowPlain === false || (config.allowPlain === undefined && !isLocal(config.host))) {
        throw new SmtpError(`${config.host} does not offer STARTTLS; set allowPlain: true to send in clear`)
      }
    }
    if (config.user) {
      if (/AUTH[^\r\n]*\bPLAIN\b/i.test(ehlo.text)) {
        const token = Buffer.from(`\0${config.user}\0${config.password ?? ''}`).toString('base64')
        await command(`AUTH PLAIN ${token}`, [235], 'AUTH PLAIN')
      } else {
        await command('AUTH LOGIN', [334])
        await command(Buffer.from(config.user).toString('base64'), [334], 'AUTH user')
        await command(Buffer.from(config.password ?? '').toString('base64'), [235], 'AUTH password')
      }
    }
    await command(`MAIL FROM:<${envelope.from}>`, [250])
    for (const to of envelope.to) await command(`RCPT TO:<${to}>`, [250, 251])
    await command('DATA', [354])
    const body = mime.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..')
    const done = await command(`${body.replace(/\r\n$/, '')}\r\n.`, [250], 'DATA body')
    await command('QUIT', [221]).catch(() => undefined)
    return done.text
  } finally {
    failed = undefined
    socket.end()
  }
}

const isLocal = (host: string) => ['localhost', '127.0.0.1', '::1'].includes(host) || host.endsWith('.local')
