/**
 * Check the starter kit as an app: `vue-tsc` over its sources, then its tests (feature tests and the end-to-end
 * run). Its database is derived from DATABASE_URL (same server, database `starter_kit_test`) and created if needed,
 * so it works with the root .env.test locally and with the Postgres service in CI.
 *
 *   bun scripts/starter-kit.ts
 */
import { join } from 'node:path'
import { SQL } from 'bun'

const app = join(import.meta.dir, '../apps/starter-kit')
/** DATABASE_URL from the environment (CI), else from the root .env.test (local; only `bun test` loads it). */
async function databaseUrl(): Promise<string | undefined> {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const file = Bun.file(join(import.meta.dir, '../.env.test'))
  if (!(await file.exists())) return undefined
  return /^DATABASE_URL=(.+)$/m.exec(await file.text())?.[1]?.trim()
}
const base = await databaseUrl()
if (!base) {
  console.log('starter kit: skipped (no DATABASE_URL)')
  process.exit(0)
}
const url = Object.assign(new URL(base), { pathname: '/starter_kit_test' }).toString()
const admin = new SQL(Object.assign(new URL(base), { pathname: '/postgres' }).toString(), { max: 1 })
if (!(await admin`select 1 from pg_database where datname = 'starter_kit_test'`).length)
  await admin.unsafe('create database starter_kit_test')
await admin.close()

const step = async (label: string, cmd: string[]) => {
  console.log(`starter kit: ${label}`)
  const proc = Bun.spawn(cmd, {
    cwd: app,
    env: { ...process.env, DATABASE_URL: url },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if ((await proc.exited) !== 0) {
    console.error(`starter kit: ${label} failed`)
    process.exit(1)
  }
}
await step('typecheck (vue-tsc)', [join(app, 'node_modules/.bin/vue-tsc'), '-p', '.', '--noEmit'])
await step('tests', [process.execPath, 'test'])
