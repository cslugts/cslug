import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Application } from '@cslug/core'
import { isJobClass, registerJob } from './job'

/** Folders a worker loads so it can run any job or queued listener (docs/directory-structure.md § Rules). */
export const DISCOVERED = ['app/jobs', 'app/listeners']

/** Import every module under `app/jobs/` and `app/listeners/` (subfolders included); register the job classes. */
export async function discoverJobs(app: Application): Promise<number> {
  let found = 0
  for (const folder of DISCOVERED) {
    const dir = join(app.rootDir, folder)
    if (!existsSync(dir)) continue
    const files = (readdirSync(dir, { recursive: true }) as string[])
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'))
      .sort()
    for (const file of files) {
      const mod = (await import(join(dir, file))) as Record<string, unknown>
      for (const value of Object.values(mod)) {
        if (!isJobClass(value)) continue
        registerJob(value)
        found++
      }
    }
  }
  return found
}
