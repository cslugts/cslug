import { join } from 'node:path'
import { defineGenerator } from '@cslug/core'

const STUBS = join(import.meta.dir, '../stubs')

/** `cslug make:notification CheckinDue` → `app/notifications/checkin-due-notification.ts`. */
export const MakeNotificationCommand = defineGenerator({
  kind: 'notification',
  description: 'Create a notification',
  stubs: STUBS,
  files: (n) => [{ stub: 'notification.stub', target: `app/notifications/${n.file}.ts` }],
})
