import { join } from 'node:path'
import { defineGenerator } from '@cslug/core'

const STUBS = join(import.meta.dir, '../stubs')

/** `cslug make:view bookings/show` → `resources/views/bookings/show.vue` (a page, with typed props). */
export const MakeViewCommand = defineGenerator({
  kind: 'view',
  description: 'Create a page view (resources/views/…)',
  stubs: STUBS,
  suffix: '',
  files: (n) => [{ stub: 'view.stub', target: `resources/views/${n.file}.vue` }],
})

/** `cslug make:component day-map` → `resources/components/day-map.vue` (an island where used with `hydrate`). */
export const MakeComponentCommand = defineGenerator({
  kind: 'component',
  description: 'Create a component (resources/components/…)',
  stubs: STUBS,
  suffix: '',
  files: (n) => [{ stub: 'component.stub', target: `resources/components/${n.file}.vue` }],
})
