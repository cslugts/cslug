# @cslug/mail: API

| | |
|---|---|
| `Mailable` | `build()`; in it: `subject`, `view(Component, props)`, `html`, `text`, `attach(content \| promise, { name, type })`, `tag`, `from`, `replyTo`, `header`. Optional statics: `queued`, `preview()` |
| `Mailer` | `to(...addresses)` → `PendingMail`; `send(message)` (a rendered `Message`, now); `transport`; `enqueue` (set by the provider with the queue) |
| `PendingMail` | `cc(...)`, `bcc(...)`, `locale(l)`, `send(mailable)`, `sendNow(mailable)` |
| `renderMail(mailable, { to, cc?, bcc? }, { locale?, from? })` | → `Message` |
| `Message` | `{ from, to, cc, bcc, replyTo?, subject, html?, text?, attachments, tags, headers }` |
| `address(x)`, `formatAddress(a)`, `toMime(message, { messageId, date? })` | Addresses (`string`, `{ email, name }`, `{ address, name }`) and MIME |
| `inlineCss(html)`, `htmlToText(html)` | The HTML steps |
| `sendSmtp(config, { from, to }, mime)`, `SmtpConfig`, `SmtpError` | The SMTP client |
| `SmtpTransport`, `ResendTransport`, `PostmarkTransport`, `BrevoTransport`, `LogTransport`, `ArrayTransport`, `createTransport(name, config, log)` | Transports (`Transport.send(message)` → `{ id }`) |
| `MailFake`, `installMailFake(app)`, `SentMail` | The fake (`fakes: ['mail']`) |
| `MailProvider` | Config `mail.{from, transport, transports, queue, queued}`; the job `cslug.mail` when @cslug/queue is installed |
| `MailPreviewCommand`, `previewableMailables(app)` | `cslug mail:preview` |
