import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cli, tempDatabase } from './support'

let db: Awaited<ReturnType<typeof tempDatabase>>
beforeAll(async () => {
  db = await tempDatabase()
})
afterAll(async () => {
  await db?.drop()
})

describe.skipIf(!process.env.DATABASE_URL)('database commands (guide 09)', () => {
  const run = (argv: string[], env = 'test') => cli(argv, { databaseUrl: db?.url, env })

  test('migrate, status, seed, rollback, fresh; production guards', async () => {
    const first = await run(['migrate'])
    expect(first.code, first.out).toBe(0)
    expect(first.out).toContain('20261126_120000_create_notes')
    expect((await run(['migrate'])).out).toContain('Nothing to migrate')

    const status = JSON.parse((await run(['migrate:status', '--json'])).out) as { name: string; ran: boolean }[]
    expect(status.find((s) => s.name === '20261126_120000_create_notes')?.ran).toBe(true)

    expect((await run(['db:seed'])).out).toContain('seeded database-seeder')
    expect((await run(['db:seed'], 'production')).code).toBe(1) // needs --force
    expect((await run(['db:seed', '--force'], 'production')).code).toBe(0)

    const fresh = await run(['migrate:fresh'], 'production')
    expect([fresh.code, fresh.out]).toEqual([1, expect.stringContaining('refused in production')])

    expect((await run(['migrate:rollback'])).out).toContain('rolled back 20261126_120000_create_notes')
    const again = await run(['migrate', '--seed'])
    expect(again.out).toContain('seeded database-seeder')
    expect((await run(['migrate:fresh', '--seed'])).code).toBe(0)
  })
})
