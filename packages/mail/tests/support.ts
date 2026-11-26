import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { Application, Logger, t } from '@cslug/core'
import { registerVueLoader, VueProvider } from '@cslug/vue'
import { Mailable, MailProvider } from '../src'

export const FIXTURE = `${import.meta.dir}/fixture`
// the fixture imports @cslug/vue like an app would
const link = `${FIXTURE}/node_modules/@cslug/vue`
if (!existsSync(link)) {
  mkdirSync(`${FIXTURE}/node_modules/@cslug`, { recursive: true })
  symlinkSync(join(import.meta.dir, '../../vue'), link, 'dir')
}
registerVueLoader(FIXTURE)
export const Due = (await import(`${FIXTURE}/resources/mail/due.vue`)).default

export type Item = { title: string }

/** The starter kit's reminder, on a Vue template with a <style> block. */
export class TodoDueMail extends Mailable {
  static queued = true
  constructor(
    private name: string,
    private items: Item[],
  ) {
    super()
  }
  build() {
    return this.subject(t('mail.due.subject', { count: this.items.length })).view(Due, {
      name: this.name,
      items: this.items,
    })
  }
  static preview() {
    return new TodoDueMail('Ada', [{ title: 'Pay the deposit' }, { title: 'Book the 4x4' }])
  }
}

/** Plain HTML, sent now. */
export class WelcomeMail extends Mailable {
  constructor(private name: string) {
    super()
  }
  build() {
    return this.subject(`Welcome ${this.name}`)
      .html(`<style>p { margin: 0 }</style><p>Hi ${this.name}, <a href="https://starter.test">start here</a>.</p>`)
      .attach('a,b\n1,2\n', { name: 'data.csv', type: 'text/csv' })
      .tag('welcome')
  }
}

export function mailApp(configs: Record<string, unknown> = {}, providers: unknown[] = []) {
  const app = new Application({
    root: FIXTURE,
    configs: {
      app: { env: 'test', url: 'https://starter.test' },
      i18n: { locales: ['en', 'fr'], default: 'en' },
      mail: {
        from: { address: 'hello@starter.test', name: 'Starter Kit' },
        transport: 'array',
        transports: { array: {} },
      },
      ...configs,
    },
  }).useProviders([VueProvider, ...(providers as never[]), MailProvider])
  app.singleton(Logger, () => Logger.null())
  return app
}
