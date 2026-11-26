# @cslug/mail

List `MailProvider` in `bootstrap/providers.ts` (after `QueueProvider` if queued mail should go through the queue).
The guide is [guide 14](../../../guides/14-mail-and-notifications.md).

```ts
export class TodoDueMail extends Mailable {
  static queued = true
  constructor(private name: string, private items: DueItem[]) { super() }
  build() {
    return this.subject(t('mail.todo_due.subject', { count: this.items.length })).view(TodoDue, { name: this.name, items: this.items })
  }
}

await mailer.to(user).locale(user.locale).send(new TodoDueMail(user.name, items))
```

## Rendering

`send()` renders at once, in the given locale (`withLocale`): `build()` (so `t()` translates for the recipient),
then the view with `@cslug/vue`'s `renderStandalone` (imported only when `.view()` is used), or `.html()`. Then:

- **CSS inlining**: `<style>` rules go into `style` attributes, in specificity then source order, with the element's
  own `style` last (it wins). `@media` rules and pseudo-selectors (`:hover`) stay in a `<style>` block. Selectors
  are matched by Bun's `HTMLRewriter`, so they are real CSS selectors.
- **The text part** is derived from the HTML unless `.text()` is set: blocks on their own lines, list items as
  `- `, links as `text (url)`.
- **MIME**: multipart/alternative (text + HTML), multipart/mixed with attachments, base64 parts, RFC 2047 for
  non-ASCII headers; `bcc` only in the envelope.

## Sending

- Not queued: the transport sends before `send()` returns.
- Queued (`static queued = true`, or `mail.queued: true` for all): the **rendered** message is dispatched as the
  job `cslug.mail` on `mail.queue` (5 tries, exponential backoff), so inside a transaction it waits for COMMIT.
  Without `@cslug/queue` it is sent after COMMIT in this process. `sendNow()` skips the queue.

Transports (`mail.transport`, configured under `mail.transports.<name>`; `driver` if the name differs):

| | |
|---|---|
| `smtp` | Own client on `Bun.connect`: STARTTLS when offered (`socket.upgradeTLS`), `secure: true` for implicit TLS, AUTH PLAIN or LOGIN, dot-stuffed DATA. Refuses clear text to anything but localhost unless `allowPlain: true` |
| `resend`, `postmark`, `brevo` | `{ apiKey, endpoint? }`, through `fetch` |
| `log` | Writes the subject and text to the log |
| `array` | Keeps messages in `transport.messages` |

## Previews and tests

`cslug mail:preview [--port=3100]` serves every mailable in `app/mail/` that has a `static preview()`, in each
locale of `i18n.locales`, as HTML and as text.

`testApp({ fakes: ['mail'] })` swaps in `MailFake` (`t.mail`): every mail is rendered (templates are exercised) and
recorded. `assertSent(Mail, (m) => …)` (sent now), `assertQueued`, `assertSentCount`, `assertQueuedCount`,
`assertNotSent`, `assertNothingSent`, `of(Mail)`. A record has `to` (the first address), `recipients`, `cc`,
`bcc`, `subject`, `html`, `text`, `attachments`, `locale`, `queued` and the `mailable` itself.
