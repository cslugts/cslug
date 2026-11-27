/**
 * Check `bun create cslug` end to end: scaffold each preset into a temporary folder, install this repository's
 * packages into its node_modules as npm would (and link the starter kit's vue, sass and compilers), then
 * typecheck it, build its assets (web, full) and run its own tests on a fresh database. A last web app gets the
 * other packages with `cslug add`, which must leave it compiling and passing.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { RedisClient, SQL } from 'bun'
import { type Preset, scaffold } from '../packages/create-cslug/src/scaffold'

const root = realpathSync(join(import.meta.dir, '..'))
const thirdParty = join(root, 'apps/starter-kit/node_modules')

async function databaseUrl(): Promise<string | undefined> {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const file = Bun.file(join(root, '.env.test'))
  return (await file.exists()) ? /^DATABASE_URL=(.+)$/m.exec(await file.text())?.[1]?.trim() : undefined
}
const base = await databaseUrl()
if (!base) {
  console.log('create-cslug: skipped (no DATABASE_URL)')
  process.exit(0)
}
const redisUrl = Object.assign(new URL(process.env.REDIS_URL ?? 'redis://localhost:6379'), {
  pathname: '/13',
}).toString()
const admin = new SQL(Object.assign(new URL(base), { pathname: '/postgres' }).toString(), { max: 1 })
const work = mkdtempSync(join(tmpdir(), 'create-cslug-'))
let failed = false

const link = (app: string, name: string, target: string) => {
  const path = join(app, 'node_modules', name)
  mkdirSync(dirname(path), { recursive: true })
  symlinkSync(realpathSync(target), path, 'dir')
}
/**
 * A @cslug package as npm installs it: copied without its node_modules, so it resolves only what the app installed
 * (a symlink would also see the repository's dev dependencies and hide a missing optional package).
 */
const install = (app: string, name: string, source: string) =>
  cpSync(source, join(app, 'node_modules', name), {
    recursive: true,
    filter: (from) => !/\/(node_modules|tests)(\/|$)/.test(from.slice(source.length)),
  })

const step = async (name: string, label: string, cmd: string[], cwd: string, env: Record<string, string> = {}) => {
  console.log(`create-cslug ${name}: ${label}`)
  const proc = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: 'inherit', stderr: 'inherit' })
  if ((await proc.exited) === 0) return true
  console.error(`create-cslug ${name}: ${label} failed`)
  failed = true
  return false
}

try {
  // the presets, then a web app given the other packages with `cslug add`
  const cases: [label: string, preset: Preset, add?: string][] = [
    ['api', 'api'],
    ['web', 'web'],
    ['full', 'full'],
    ['web+add', 'web', 'queue,mail,storage,notification,webhook'],
  ]
  for (const [label, preset, add] of cases) {
    const app = join(work, `${label.replace('+', '-')}-app`)
    await scaffold({ dir: app, preset })
    const cli = join(app, 'node_modules/@cslug/cli/src/bin.ts') // the app's own, as `bunx cslug` runs it
    const linkAll = async () => {
      const pkg = (await Bun.file(join(app, 'package.json')).json()) as Record<string, Record<string, string>>
      for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
        if (existsSync(join(app, 'node_modules', dep))) continue
        if (dep.startsWith('@cslug/')) install(app, dep, join(root, 'packages', dep.slice(7)))
        else if (existsSync(join(thirdParty, dep))) link(app, dep, join(thirdParty, dep))
      }
    }
    await linkAll()
    if (add) {
      // what `bun add` would do, offline: the dependencies, then their links
      if (!(await step(label, `cslug add ${add}`, [process.execPath, cli, 'add', add, '--no-install'], app))) continue
      const pkgPath = join(app, 'package.json')
      const json = await Bun.file(pkgPath).json()
      for (const name of add.split(',')) json.dependencies[`@cslug/${name}`] = json.dependencies['@cslug/core']
      await Bun.write(pkgPath, JSON.stringify(json, null, 2))
      await linkAll()
    }
    const web = preset !== 'api'
    const typecheck = web
      ? join(app, 'node_modules/vue-tsc/bin/vue-tsc.js')
      : join(app, 'node_modules/typescript/bin/tsc')
    if (!(await step(label, 'typecheck', [process.execPath, typecheck, '-p', '.', '--noEmit'], app))) continue
    if (web && !(await step(label, 'build', [process.execPath, cli, 'build'], app))) continue

    const db = `create_cslug_${label.replace('+', '_')}_test`
    await admin.unsafe(`drop database if exists "${db}" with (force)`)
    await admin.unsafe(`create database "${db}"`)
    const redis = new RedisClient(redisUrl)
    await redis.send('FLUSHDB', [])
    redis.close()
    await step(label, 'tests', [process.execPath, 'test'], app, {
      DATABASE_URL: Object.assign(new URL(base), { pathname: `/${db}` }).toString(),
      REDIS_URL: redisUrl,
    })
    await admin.unsafe(`drop database if exists "${db}" with (force)`)
  }
} finally {
  await admin.close()
  rmSync(work, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
