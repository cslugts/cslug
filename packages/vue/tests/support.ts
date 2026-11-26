import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { Application, Logger } from '@cslug/core'
import { HttpKernel, HttpProvider, type RouteRegistrar, Router } from '@cslug/http'
import { registerVueLoader, VueProvider } from '../src'
import type { BuildOptions, BuildResult } from '../src/build-entry'

export const FIXTURE = `${import.meta.dir}/fixture`
// the fixture is its own package (for `#components/*`): let it import @cslug/vue like an app would
const link = `${FIXTURE}/node_modules/@cslug/vue`
if (!existsSync(link)) {
  mkdirSync(`${FIXTURE}/node_modules/@cslug`, { recursive: true })
  symlinkSync(join(import.meta.dir, '..'), link, 'dir')
}
registerVueLoader(FIXTURE)

/** Import a fixture view or component (after the loader is registered). */
export const load = async (path: string) => (await import(`${FIXTURE}/resources/${path}.vue`)).default

/** The fixture app (Vue + HTTP), with routes, started. */
export async function vueApp(routes: (r: RouteRegistrar) => void = () => {}, configs: Record<string, unknown> = {}) {
  const app = new Application({
    root: FIXTURE,
    configs: {
      app: { env: 'test', key: 'k'.repeat(32), url: 'https://albastr.test' },
      i18n: { locales: ['en', 'fr'], default: 'en' },
      ...configs,
    },
  })
  app.useProviders([VueProvider, HttpProvider])
  app.singleton(Logger, () => Logger.null())
  await app.start()
  app.resolve(Router).load(routes)
  const kernel = app.resolve(HttpKernel)
  kernel.compile()
  const call = (path: string, init?: RequestInit) =>
    kernel.handle(new Request(`https://albastr.test${path}`, init), { ip: '127.0.0.1' })
  return { app, call }
}

/**
 * Run the asset build in a child process. Under `bun test` (1.3.14), a second Bun.build in the same process fails
 * with "Unexpected reading file" on a source the test process has already loaded; `cslug build` and `cslug dev`
 * run under `bun run`, where it works (docs/open-questions.md).
 */
export async function build(options: Omit<BuildOptions, 'root'> = {}): Promise<BuildResult> {
  const script = `import { buildAssets } from ${JSON.stringify(`${import.meta.dir}/../src/build-entry.ts`)}
const r = await buildAssets({ ...${JSON.stringify(options)}, root: ${JSON.stringify(FIXTURE)} })
console.log(JSON.stringify(r))`
  const proc = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0)
    throw new Error(
      err
        .trim()
        .split('\n')
        .find((l) => l.startsWith('error:'))
        ?.slice(7) ?? err,
    )
  return JSON.parse(out.trim().split('\n').at(-1) as string) as BuildResult
}
