import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { cli } from './support'

/** The files `cslug add` edits, as `bun create cslug --web` writes them. */
const APP = {
  'bootstrap/providers.ts': `import { DatabaseProvider } from '@cslug/database'
import { HttpProvider } from '@cslug/http'
import { AppServiceProvider } from '#app/providers/app-service-provider'

export const providers = [
  DatabaseProvider,
  HttpProvider,
  AppServiceProvider,
]
`,
  'config/index.ts': `import type { Typed } from '@cslug/core'
import app from './app'
import http from './http'

export const configs = { app, http }
`,
  'cslug.config.ts': `export default defineCslugConfig({
  assets: { entries: { client: 'resources/client.ts' }, scss: true, tailwind: false },
  processes: {
    web: { instances: 1 },
  },
})
`,
  'resources/client.ts': `import { mountIslands } from '@cslug/vue'
import './styles/app.scss'

mountIslands()
`,
}

function newApp(files: Record<string, string> = APP) {
  const root = mkdtempSync(join(tmpdir(), 'cslug-add-'))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}
const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})
const read = (root: string, path: string) => readFileSync(join(root, path), 'utf8')

describe('cslug add (guide 20)', () => {
  test('queue,mail: providers before the app provider, config files listed, worker and scheduler', async () => {
    const root = newApp()
    roots.push(root)
    const { code, out } = await cli(['add', 'queue,mail', '--no-install'], { root })
    expect(code).toBe(0)
    expect(out).toContain('queue added')
    expect(read(root, 'bootstrap/providers.ts')).toBe(`import { DatabaseProvider } from '@cslug/database'
import { HttpProvider } from '@cslug/http'
import { AppServiceProvider } from '#app/providers/app-service-provider'
import { QueueProvider, ScheduleProvider } from '@cslug/queue'
import { MailProvider } from '@cslug/mail'

export const providers = [
  DatabaseProvider,
  HttpProvider,
  QueueProvider,
  ScheduleProvider,
  MailProvider,
  AppServiceProvider,
]
`)
    expect(read(root, 'config/index.ts')).toContain(
      "import http from './http'\nimport queue from './queue'\nimport mail from './mail'\n",
    )
    expect(read(root, 'config/index.ts')).toContain('export const configs = { app, http, queue, mail }')
    expect(read(root, 'config/queue.ts')).toContain('defineConfig')
    expect(read(root, 'routes/schedule.ts')).toContain('defineSchedule')
    expect(read(root, 'cslug.config.ts')).toContain(
      "    web: { instances: 1 },\n    worker: [{ queues: ['default'], concurrency: 5 }],\n    scheduler: true,\n",
    )
  })

  test('running it twice changes nothing', async () => {
    const root = newApp()
    roots.push(root)
    await cli(['add', 'storage', '--no-install'], { root })
    const before = ['bootstrap/providers.ts', 'config/index.ts', 'config/storage.ts'].map((p) => read(root, p))
    expect((await cli(['add', 'storage', '--no-install'], { root })).code).toBe(0)
    expect(['bootstrap/providers.ts', 'config/index.ts', 'config/storage.ts'].map((p) => read(root, p))).toEqual(before)
  })

  test('tailwind: the stylesheet, its import and the plugin flag', async () => {
    const root = newApp()
    roots.push(root)
    expect((await cli(['add', 'tailwind', '--no-install'], { root })).code).toBe(0)
    expect(read(root, 'resources/styles/tailwind.css')).toBe('@import "tailwindcss";\n')
    expect(read(root, 'resources/client.ts')).toContain("import './styles/app.scss'\nimport './styles/tailwind.css'\n")
    expect(read(root, 'cslug.config.ts')).toContain('tailwind: true')
  })

  test('an unknown name is refused; a file it cannot edit is explained', async () => {
    const root = newApp({ 'bootstrap/providers.ts': 'export const providers = makeProviders()\n' })
    roots.push(root)
    const unknown = await cli(['add', 'queue,payments', '--no-install'], { root })
    expect(unknown.code).toBe(1)
    expect(unknown.out).toContain(
      'Unknown: payments. Available: queue, mail, storage, notification, webhook, search, ai, tailwind',
    )
    const { code, out } = await cli(['add', 'webhook', '--no-install'], { root })
    expect(code).toBe(0)
    expect(out).toContain('could not edit bootstrap/providers.ts')
    expect(out).toContain("import { WebhookProvider } from '@cslug/webhook'")
  })
})
