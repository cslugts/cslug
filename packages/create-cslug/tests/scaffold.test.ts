import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { names, packageJson, scaffold, VERSION } from '../src'

const work = mkdtempSync(join(tmpdir(), 'create-cslug-test-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))
const read = (dir: string, path: string) => Bun.file(join(dir, path)).text()

test('names: package, title and database names from the folder', () => {
  expect(names('/tmp/demo')).toEqual({ name: 'demo', title: 'Demo', db: 'demo' })
  expect(names('./My_trip-Planner')).toEqual({
    name: 'my-trip-planner',
    title: 'My Trip Planner',
    db: 'my_trip_planner',
  })
  expect(() => names('/tmp/42-app')).toThrow('not a usable app name')
})

test('packageJson: exact @cslug versions per preset, scripts and import aliases', () => {
  const api = packageJson('a', 'api', false, '1.2.3')
  expect(Object.keys(api.dependencies)).toEqual([
    '@cslug/core',
    '@cslug/validation',
    '@cslug/http',
    '@cslug/database',
    '@cslug/redis',
    '@cslug/cli',
  ])
  expect(api.dependencies['@cslug/core']).toBe('1.2.3')
  expect(api.scripts.typecheck).toBe('tsc --noEmit')
  expect(api.imports).not.toHaveProperty('#views/*')

  const full = packageJson('a', 'full', true, '1.2.3')
  expect(full.dependencies).toMatchObject({ '@cslug/vue': '1.2.3', '@cslug/storage': '1.2.3', vue: '^3.5.0' })
  expect(full.devDependencies).toMatchObject({ '@cslug/testing': '1.2.3', tailwindcss: '^4.0.0' })
  expect(full.scripts.typecheck).toBe('cslug typecheck')
})

describe.each(['api', 'web', 'full'] as const)('scaffold --%s', (preset) => {
  const dir = join(work, `${preset}-app`)
  let files: string[] = []

  test('writes the layers, dotfiles from _names, every placeholder filled', async () => {
    files = await scaffold({ dir, preset })
    expect(files).toContain('package.json')
    expect(files).toContain('.gitignore')
    expect(files).toContain('.env')
    expect(files).toContain('.env.test')
    expect(files.some((f) => f.split('/').some((s) => s.startsWith('_')))).toBe(false)
    for (const f of files) expect(await read(dir, f), f).not.toMatch(/\{\{\w+\}\}/)
    expect((await Bun.file(join(dir, 'package.json')).json()).dependencies['@cslug/core']).toBe(VERSION)
  })

  test('.env has its own APP_KEY; .env.test another', async () => {
    const key = /^APP_KEY=(base64:\S{44})$/m
    const env = key.exec(await read(dir, '.env'))?.[1]
    const testKey = key.exec(await read(dir, '.env.test'))?.[1]
    expect(env).toBeTruthy()
    expect(testKey).toBeTruthy()
    expect(env).not.toBe(testKey)
    expect(await read(dir, '.env')).toContain(`/${preset}_app`)
  })

  test('what the preset includes', () => {
    expect(files.includes('routes/web.ts')).toBe(preset !== 'api')
    expect(files.includes('resources/views/home.vue')).toBe(preset !== 'api')
    expect(files.includes('config/mail.ts')).toBe(preset === 'full')
    expect(files.includes('routes/schedule.ts')).toBe(preset === 'full')
  })
})

test('--tailwind: the stylesheet, its import, the plugin flag and the packages', async () => {
  const dir = join(work, 'tw-app')
  const files = await scaffold({ dir, preset: 'web', tailwind: true })
  expect(files).toContain('resources/styles/tailwind.css')
  expect(await read(dir, 'resources/client.ts')).toContain("import './styles/tailwind.css'")
  expect(await read(dir, 'cslug.config.ts')).toContain('tailwind: true')
  expect((await Bun.file(join(dir, 'package.json')).json()).devDependencies).toHaveProperty('bun-plugin-tailwind')
  expect(scaffold({ dir: join(work, 'tw-api'), preset: 'api', tailwind: true })).rejects.toThrow(
    '--tailwind needs pages',
  )
})

test('refuses a folder that is not empty', async () => {
  const dir = join(work, 'busy')
  mkdirSync(dir)
  writeFileSync(join(dir, 'notes.txt'), 'mine')
  expect(scaffold({ dir })).rejects.toThrow('exists and is not empty')
})

test('the bin: usage, then a scaffold without install or git', async () => {
  const bin = join(import.meta.dir, '../src/bin.ts')
  const usage = Bun.spawnSync([process.execPath, bin])
  expect(usage.exitCode).toBe(1)
  expect(usage.stdout.toString()).toContain('Usage: bun create cslug <dir>')
  const run = Bun.spawnSync([process.execPath, bin, 'cli-app', '--api', '--no-install', '--no-git'], { cwd: work })
  expect(run.exitCode).toBe(0)
  expect(run.stdout.toString()).toContain('✔ cli-app:')
  expect(await Bun.file(join(work, 'cli-app/routes/api.ts')).exists()).toBe(true)
})
