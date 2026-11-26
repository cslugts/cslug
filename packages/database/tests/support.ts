import { describe } from 'bun:test'
import { Logger } from '@cslug/core'
import { SQL } from 'bun'
import { Database } from '../src'

/** Integration tests need DATABASE_URL (.env.test locally, the Postgres service in CI); they skip without it. */
export const DATABASE_URL = process.env.DATABASE_URL
export const describeDb = DATABASE_URL ? describe : describe.skip

/** A throwaway database for one test file: created empty, dropped afterwards. Never touches existing data. */
export async function testDatabase(log: Logger = Logger.null()) {
  if (!DATABASE_URL) throw new Error('DATABASE_URL is not set')
  const name = `cslug_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`
  const base = new URL(DATABASE_URL)
  const adminUrl = new URL(base)
  adminUrl.pathname = '/postgres'
  const admin = new SQL(adminUrl.toString(), { max: 1 })
  await admin.unsafe(`create database "${name}"`)
  const url = new URL(base)
  url.pathname = `/${name}`
  const db = new Database({ url: url.toString(), pool: { max: 8 }, slowQueryMs: 10_000 }, log)
  return {
    db,
    url: url.toString(),
    async drop() {
      await db.close()
      await admin.unsafe(`drop database if exists "${name}" with (force)`)
      await admin.close()
    },
  }
}
