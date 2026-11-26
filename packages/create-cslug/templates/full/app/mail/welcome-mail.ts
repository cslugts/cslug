import { t } from '@cslug/core'
import { Mailable } from '@cslug/mail'
import Welcome from '#resources/mail/welcome.vue'

/** Sent after registration (queued: rendered now, sent by the worker). */
export class WelcomeMail extends Mailable {
  static queued = true

  constructor(private readonly name: string) {
    super()
  }

  build() {
    return this.subject(t('mail.welcome.subject')).view(Welcome, { name: this.name })
  }

  static preview() {
    return new WelcomeMail('Ada')
  }
}
