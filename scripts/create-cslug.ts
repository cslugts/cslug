/**
 * Check `bun create cslug` end to end: scaffold each preset into a temporary folder, link its node_modules to this
 * repository's packages (and the starter kit's vue, sass and compilers, so one copy of each is loaded), then
 * typecheck it, build its assets (web, full) and run its own tests on a fresh database.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
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

const step = async (preset: string, label: string, cmd: string[], cwd: string, env: Record<string, string> = {}) => {
  console.log(`create-cslug ${preset}: ${label}`)
  const proc = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: 'inherit', stderr: 'inherit' })
  if ((await proc.exited) === 0) return true
  console.error(`create-cslug ${preset}: ${label} failed`)
  failed = true
  return false
}

try {
  for (const preset of ['api', 'web', 'full'] as Preset[]) {
    const app = join(work, `${preset}-app`)
    await scaffold({ dir: app, preset })
    const pkg = (await Bun.file(join(app, 'package.json')).json()) as Record<string, Record<string, string>>
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
      if (dep.startsWith('@cslug/')) link(app, dep, join(root, 'packages', dep.slice(7)))
      else if (existsSync(join(thirdParty, dep))) link(app, dep, join(thirdParty, dep))
    }
    const web = preset !== 'api'
    const typecheck = web
      ? join(app, 'node_modules/vue-tsc/bin/vue-tsc.js')
      : join(app, 'node_modules/typescript/bin/tsc')
    if (!(await step(preset, 'typecheck', [process.execPath, typecheck, '-p', '.', '--noEmit'], app))) continue
    if (web && !(await step(preset, 'build', [process.execPath, join(root, 'packages/cli/src/bin.ts'), 'build'], app)))
      continue

    const db = `create_cslug_${preset}_test`
    await admin.unsafe(`drop database if exists "${db}" with (force)`)
    await admin.unsafe(`create database "${db}"`)
    const redis = new RedisClient(redisUrl)
    await redis.send('FLUSHDB', [])
    redis.close()
    await step(preset, 'tests', [process.execPath, 'test'], app, {
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
