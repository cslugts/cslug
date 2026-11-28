import { join } from 'node:path'
import { defineGenerator } from '@cslug/core'

const STUBS = join(import.meta.dir, '../stubs')

/** `cslug make:policy Booking` → `app/policies/booking-policy.ts`. */
export const MakePolicyCommand = defineGenerator({
  kind: 'policy',
  description: 'Create a policy',
  stubs: STUBS,
  files: (n) => [{ stub: 'policy.stub', target: `app/policies/${n.file}.ts` }],
})
