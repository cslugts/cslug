import { describe, expect, test } from 'bun:test'
import { Application, Logger, runInContext } from '@cslug/core'
import { testApp } from '@cslug/testing'
import {
  type ArrayTransport,
  BrevoTransport,
  htmlToText,
  inlineCss,
  Mailer,
  PostmarkTransport,
  previewableMailables,
  ResendTransport,
  renderMail,
  sendSmtp,
  toMime,
} from '../src'
import { mailApp, TodoDueMail, WelcomeMail } from './support'

describe('HTML: CSS inlining and the text part', () => {
  test('rules by specificity then order; own style wins; @media and :hover kept', async () => {
    const html = await inlineCss(
      '<html><head><style>p{color:red} .lead{color:blue} #x{color:green} a:hover{color:pink} @media (max-width:600px){p{font-size:12px}}</style></head><body><p class="lead" style="margin:0">A</p><p id="x" class="lead">B</p></body></html>',
    )
    expect(html).toContain('<p class="lead" style="color:red; color:blue; margin:0">')
    expect(html).toContain('style="color:red; color:blue; color:green"')
    expect(html).toContain('<style>@media (max-width:600px){p{font-size:12px}}\na:hover{color:pink}</style></head>')
  })

  test('text: blocks on lines, links with their URL, entities decoded', () => {
    expect(
      htmlToText('<h1>Hi &amp; bye</h1><p>Go <a href="https://x.test">there</a></p><ul><li>a</li><li>b</li></ul>'),
    ).toBe('Hi & bye\n\nGo there (https://x.test)\n\n- a\n- b')
  })
})

describe('MIME', () => {
  test('alternative text + html, mixed with attachments, encoded non-ASCII headers', () => {
    const mime = toMime(
      {
        from: { address: 'hello@starter.test', name: 'Starter Kit' },
        to: [{ address: 'giulia@example.it', name: 'Giulia Bianchi' }],
        cc: [],
        bcc: [{ address: 'audit@starter.test' }],
        subject: 'Réservation confirmée',
        html: '<p>Hi</p>',
        text: 'Hi',
        attachments: [{ name: 'a.csv', content: 'a,b', type: 'text/csv' }],
        tags: [],
        headers: { 'X-Booking': 'b1' },
      },
      { messageId: 'abc@starter.test', date: new Date('2027-05-14T08:00:00Z') },
    )
    expect(mime).toContain('From: "Starter Kit" <hello@starter.test>')
    expect(mime).toContain('Subject: =?UTF-8?B?')
    expect(mime).not.toContain('audit@starter.test') // bcc is in the envelope only
    expect(mime).toContain('multipart/mixed')
    expect(mime).toContain('multipart/alternative')
    expect(mime).toContain('Content-Disposition: attachment; filename="a.csv"')
    expect(mime).toContain(Buffer.from('<p>Hi</p>').toString('base64'))
  })
})

describe('Mailable rendering (guide 14)', () => {
  const t = testApp({ create: () => mailApp(), fakes: ['mail'] })

  test('a Vue view in the recipient locale: subject translated, CSS inlined, text derived', async () => {
    await t.resolve(Mailer).to({ email: 'ada@example.test', name: 'Ada' }).locale('fr').send(TodoDueMail.preview())
    t.mail?.assertQueuedCount(TodoDueMail, 1)
    t.mail?.assertQueued(
      TodoDueMail,
      (m) => m.to === 'ada@example.test' && m.subject === '2 tâches arrivent à échéance' && m.locale === 'fr',
    )
    const [m] = t.mail?.of(TodoDueMail) ?? []
    expect(m?.html).toContain('<div class="card" style="padding: 16px; color: #0f766e">')
    expect(m?.html).toContain('a:hover')
    expect(m?.text).toContain('Bonjour Ada')
    expect(m?.text).toContain('- Pay the deposit')
    expect(m?.text).toContain('Open (https://starter.test/todos)')
  })

  test('HTML mail sent now; attachments; to() takes rows; assertions say what was sent', async () => {
    await t
      .resolve(Mailer)
      .to({ email: 'ada@example.test', name: 'Ada' }, 'bo@example.test')
      .cc('cc@example.test')
      .send(new WelcomeMail('Ada'))
    t.mail?.assertSent(WelcomeMail, (m) => m.recipients.length === 2 && m.cc[0] === 'cc@example.test')
    expect(t.mail?.of(WelcomeMail)[0]?.attachments[0]).toMatchObject({ name: 'data.csv', content: 'a,b\n1,2\n' })
    expect(() => t.mail?.assertQueued(WelcomeMail)).toThrow(
      /Expected WelcomeMail to be queued; mail: WelcomeMail to ada@example.test "Welcome Ada"/,
    )
    expect(() => t.mail?.assertNothingSent()).toThrow()
    t.mail?.assertNotSent(TodoDueMail)
  })

  test('errors: no recipient, a bad address', async () => {
    await expect(t.resolve(Mailer).to().send(new WelcomeMail('x'))).rejects.toThrow(/no recipient/)
    expect(() => t.resolve(Mailer).to('not-an-address')).toThrow(/not an email address/)
  })

  test('mail:preview finds mailables with a static preview()', async () => {
    // the fixture has no app/mail folder: nothing to preview
    expect(await previewableMailables(t.app)).toEqual([])
  })
})

describe('Mailer with a real transport', () => {
  const t = testApp({ create: () => mailApp() })

  test('queued mail without @cslug/queue is sent after the current task (after COMMIT in a transaction)', async () => {
    const transport = t.resolve(Mailer).transport as ArrayTransport
    await t.resolve(Mailer).to('ada@example.test').send(TodoDueMail.preview())
    expect(transport.messages).toHaveLength(0)
    await Bun.sleep(5)
    expect(transport.messages.map((m) => m.subject)).toEqual(['2 todos are due'])
    await t.resolve(Mailer).to('ada@example.test').sendNow(TodoDueMail.preview())
    expect(transport.messages).toHaveLength(2)
  })
})

/** A tiny SMTP server: records commands and the DATA it receives. */
function smtpServer(options: { auth?: 'PLAIN' | 'LOGIN' } = {}) {
  const commands: string[] = []
  let data = ''
  const server = Bun.listen<{ inData: boolean; buf: string }>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(s) {
        s.data = { inData: false, buf: '' }
        s.write('220 test ESMTP\r\n')
      },
      data(s, chunk) {
        s.data.buf += chunk.toString()
        let i = s.data.buf.indexOf('\r\n')
        while (i >= 0) {
          const line = s.data.buf.slice(0, i)
          s.data.buf = s.data.buf.slice(i + 2)
          if (s.data.inData) {
            if (line === '.') {
              s.data.inData = false
              s.write('250 OK queued as 42\r\n')
            } else data += `${line}\n`
          } else {
            commands.push(line)
            const verb = line.split(' ')[0]?.toUpperCase()
            if (verb === 'EHLO')
              s.write(`250-test\r\n${options.auth ? `250-AUTH ${options.auth}\r\n` : ''}250 SIZE 1000000\r\n`)
            else if (verb === 'AUTH' && line.includes('PLAIN')) s.write('235 ok\r\n')
            else if (verb === 'AUTH') s.write('334 VXNlcm5hbWU6\r\n')
            else if (commands.at(-2)?.startsWith('AUTH LOGIN')) s.write('334 UGFzc3dvcmQ6\r\n')
            else if (commands.at(-3)?.startsWith('AUTH LOGIN')) s.write('235 ok\r\n')
            else if (verb === 'DATA') {
              s.data.inData = true
              s.write('354 go\r\n')
            } else if (verb === 'QUIT') s.write('221 bye\r\n')
            else s.write('250 ok\r\n')
          }
          i = s.data.buf.indexOf('\r\n')
        }
      },
    },
  })
  return { port: server.port, commands, data: () => data, stop: () => server.stop(true) }
}

describe('SMTP client', () => {
  test('EHLO, AUTH PLAIN, MAIL, RCPT (to, cc, bcc), dot-stuffed DATA, QUIT', async () => {
    const srv = smtpServer({ auth: 'PLAIN' })
    try {
      const reply = await sendSmtp(
        { host: '127.0.0.1', port: srv.port, user: 'u', password: 'p' },
        { from: 'a@x.test', to: ['b@x.test', 'c@x.test'] },
        'Subject: hi\r\n\r\n.leading dot\r\nend\r\n',
      )
      expect(reply).toContain('250 OK queued as 42')
      expect(srv.commands).toEqual([
        'EHLO localhost',
        `AUTH PLAIN ${Buffer.from('\0u\0p').toString('base64')}`,
        'MAIL FROM:<a@x.test>',
        'RCPT TO:<b@x.test>',
        'RCPT TO:<c@x.test>',
        'DATA',
        'QUIT',
      ])
      expect(srv.data()).toBe('Subject: hi\n\n..leading dot\nend\n')
    } finally {
      srv.stop()
    }
  })

  test('AUTH LOGIN when PLAIN is not offered; a refused plain connection; a rejected command', async () => {
    const srv = smtpServer({ auth: 'LOGIN' })
    try {
      await sendSmtp(
        { host: '127.0.0.1', port: srv.port, user: 'u', password: 'p' },
        { from: 'a@x.test', to: ['b@x.test'] },
        'x\r\n',
      )
      expect(srv.commands.slice(1, 4)).toEqual([
        'AUTH LOGIN',
        Buffer.from('u').toString('base64'),
        Buffer.from('p').toString('base64'),
      ])
      await expect(
        sendSmtp(
          { host: '127.0.0.1', port: srv.port, allowPlain: false },
          { from: 'a@x.test', to: ['b@x.test'] },
          'x\r\n',
        ),
      ).rejects.toThrow(/does not offer STARTTLS/)
    } finally {
      srv.stop()
    }
  })
})

describe('HTTP API transports', () => {
  test('Resend, Postmark and Brevo get their own request shape', async () => {
    const calls: { path: string; headers: Headers; body: Record<string, unknown> }[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        calls.push({
          path: new URL(req.url).pathname,
          headers: req.headers,
          body: (await req.json()) as Record<string, unknown>,
        })
        return Response.json({ id: 'r1', MessageID: 'p1', messageId: 'b1' })
      },
    })
    const endpoint = `http://localhost:${server.port}`
    const message = await runInContext({ app: new Application(), scope: new Application() }, () =>
      renderMail(
        new WelcomeMail('Ada'),
        { to: [{ address: 'ada@example.test', name: 'Ada' }] },
        { from: { address: 'hello@starter.test' } },
      ),
    )
    try {
      expect((await new ResendTransport({ apiKey: 'k', endpoint }).send(message)).id).toBe('r1')
      expect((await new PostmarkTransport({ apiKey: 'k', endpoint }).send(message)).id).toBe('p1')
      expect((await new BrevoTransport({ apiKey: 'k', endpoint }).send(message)).id).toBe('b1')
      expect(calls.map((c) => c.path)).toEqual(['/emails', '/email', '/v3/smtp/email'])
      expect(calls[0]?.headers.get('authorization')).toBe('Bearer k')
      expect(calls[0]?.body).toMatchObject({ to: ['Ada <ada@example.test>'], subject: 'Welcome Ada' })
      expect(calls[1]?.headers.get('x-postmark-server-token')).toBe('k')
      expect(calls[1]?.body).toMatchObject({ To: 'Ada <ada@example.test>', Tag: 'welcome' })
      expect(calls[2]?.body).toMatchObject({
        sender: { email: 'hello@starter.test' },
        to: [{ email: 'ada@example.test', name: 'Ada' }],
      })
      expect((calls[2]?.body.attachment as { content: string }[] | undefined)?.[0]?.content).toBe(
        Buffer.from('a,b\n1,2\n').toString('base64'),
      )
    } finally {
      server.stop(true)
    }
  })
})

test('Logger.null keeps the log transport quiet', () => {
  expect(Logger.null()).toBeInstanceOf(Logger)
})
