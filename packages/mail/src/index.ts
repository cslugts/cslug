/**
 * @cslug/mail: mailables rendered from Vue views (CSS inlined, text part derived), a `Mailer` that sends now or
 * queues, and transports: SMTP (own client), Resend, Postmark, Brevo, log, array.
 */
export { installMailFake, MailFake, type SentMail } from './fake'
export { MakeMailCommand } from './generators'
export { htmlToText, inlineCss } from './html'
export { Mailable, type MailableClass, type MailParts, PARTS } from './mailable'
export { type MailConfig, Mailer, type Outgoing, PendingMail, renderMail } from './mailer'
export {
  type Address,
  type AddressLike,
  type Attachment,
  address,
  formatAddress,
  type Message,
  toMime,
} from './message'
export { MailPreviewCommand, MailProvider, previewableMailables } from './provider'
export { type SmtpConfig, SmtpError, sendSmtp } from './smtp'
export {
  ArrayTransport,
  BrevoTransport,
  createTransport,
  LogTransport,
  PostmarkTransport,
  ResendTransport,
  SmtpTransport,
  type Transport,
  type TransportConfig,
} from './transports'
