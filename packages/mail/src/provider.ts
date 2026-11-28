import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { type Application, Command, flag, Logger, resolve, ServiceProvider } from '@cslug/core'
import { MakeMailCommand } from './generators'
import { Mailable, type MailableClass } from './mailable'
import { type MailConfig, Mailer, renderMail } from './mailer'
import { address, type Message } from './message'
import { createTransport } from './transports'

/** A message as queued: attachments as base64 (the queue payload is JSON). */
type QueuedMessage = Omit<Message, 'attachments'> & { attachments: { name: string; type?: string; base64: string }[] }

const toQueued = (m: Message): QueuedMessage => ({
  ...m,
  attachments: m.attachments.map((a) => ({
    name: a.name,
    type: a.type,
    base64: Buffer.from(a.content).toString('base64'),
  })),
})
const fromQueued = (m: QueuedMessage): Message => ({
  ...m,
  attachments: m.attachments.map((a) => ({
    name: a.name,
    type: a.type,
    content: new Uint8Array(Buffer.from(a.base64, 'base64')),
  })),
})

type QueueModule = typeof import('@cslug/queue')
let mailJob: { cls: unknown } | undefined

/** The job (`cslug.mail`) that sends a queued, already rendered message; defined once, when the queue is installed. */
function sendMailJob(q: QueueModule) {
  if (!mailJob) {
    class SendMailJob extends q.Job<QueuedMessage> {
      static jobName = 'cslug.mail'
      static tries = 5
      static backoff = q.Job.exponential('30s', { max: '30m', jitter: true })
      async handle(message: QueuedMessage) {
        await resolve(Mailer).send(fromQueued(message))
      }
    }
    q.registerJob(SendMailJob)
    mailJob = { cls: SendMailJob }
  }
  return mailJob.cls as Parameters<InstanceType<QueueModule['Queue']>['dispatch']>[0]
}

/**
 * Binds `Mailer` with the transport `mail.transport` (`smtp`, `resend`, `postmark`, `brevo`, `log`, `array`).
 * With @cslug/queue installed, queued mail goes through the job `cslug.mail` on `mail.queue`.
 */
export class MailProvider extends ServiceProvider {
  register() {
    this.commands([MailPreviewCommand, MakeMailCommand])
    this.app.singleton(Mailer, (c) => {
      const config = this.app.config<MailConfig | undefined>('mail') ?? {}
      const name = config.transport ?? 'log'
      const transport = createTransport(name, config.transports?.[name] ?? {}, c.resolve(Logger))
      return new Mailer(this.app, config, transport, c.resolve(Logger))
    })
  }

  async boot() {
    try {
      const q = await import('@cslug/queue')
      if (!this.app.has(q.Queue)) return
      const job = sendMailJob(q)
      this.app.resolve(Mailer).enqueue = async (message, queue) => {
        await this.app
          .resolve(q.Queue)
          .dispatch(job, toQueued(message) as never)
          .onQueue(queue)
      }
    } catch {
      // no @cslug/queue: queued mail is sent after COMMIT in this process
    }
  }
}

/** Mailables in `app/mail/` with a `static preview()`. */
export async function previewableMailables(app: Application): Promise<MailableClass[]> {
  const dir = join(app.rootDir, 'app/mail')
  if (!existsSync(dir)) return []
  const found: MailableClass[] = []
  for (const file of (readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts')).sort()) {
    for (const value of Object.values(await import(join(dir, file)))) {
      const cls = value as MailableClass
      if (typeof cls === 'function' && cls.prototype instanceof Mailable && typeof cls.preview === 'function')
        found.push(cls)
    }
  }
  return found
}

/** `cslug mail:preview`: every mailable with a `static preview()`, in each locale, in the browser. */
export class MailPreviewCommand extends Command {
  static signature = 'mail:preview'
  static description = 'Preview mailables (static preview()) in the browser, in each locale'
  static longRunning = true
  static args = { port: flag.number().default(3100) }

  async handle({ port }: Command.Args<typeof MailPreviewCommand>) {
    const app = this.app
    const mailables = await previewableMailables(app)
    const locales = app.config<string[] | undefined>('i18n.locales') ?? ['en']
    const from = address(app.config<{ address: string }>('mail.from') ?? 'preview@example.test')
    const page = (body: string) =>
      new Response(`<!doctype html><meta charset="utf-8">${body}`, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    const server = Bun.serve({
      port,
      fetch: async (req) => {
        const url = new URL(req.url)
        const [, name, locale, part] = url.pathname.split('/')
        const cls = mailables.find((m) => m.name === name)
        if (!cls || !locale) {
          const links = mailables.flatMap((m) =>
            locales.map(
              (l) =>
                `<li><a href="/${m.name}/${l}">${m.name} (${l})</a> · <a href="/${m.name}/${l}/text">text</a></li>`,
            ),
          )
          return page(
            `<h1>Mail previews</h1><ul>${links.join('') || '<li>No mailable in app/mail/ has a static preview()</li>'}</ul>`,
          )
        }
        const message = await renderMail(
          await (cls.preview as () => Promise<Mailable>)(),
          { to: [address('preview@example.test')] },
          { locale, from },
        )
        if (part === 'text')
          return new Response(message.text ?? '', { headers: { 'content-type': 'text/plain; charset=utf-8' } })
        return page(`<p><b>${message.subject}</b></p>${message.html ?? `<pre>${message.text ?? ''}</pre>`}`)
      },
    })
    this.info(`Mail previews: http://localhost:${server.port}/ (${mailables.length} mailables, ${locales.join(', ')})`)
  }
}
