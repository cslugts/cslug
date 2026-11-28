import { join } from 'node:path'
import { defineGenerator } from '@cslug/core'

const STUBS = join(import.meta.dir, '../stubs')

/** `cslug make:mail BookingConfirmed` → `app/mail/booking-confirmed-mail.ts` and `resources/mail/booking-confirmed.vue`. */
export const MakeMailCommand = defineGenerator({
  kind: 'mail',
  description: 'Create a mailable and its Vue template',
  stubs: STUBS,
  files: (n) => [
    { stub: 'mail.stub', target: `app/mail/${n.file}.ts` },
    { stub: 'mail.view.stub', target: `resources/mail/${n.dir ? `${n.dir}/` : ''}${n.kebab}.vue` },
  ],
})
