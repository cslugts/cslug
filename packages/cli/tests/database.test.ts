import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { BIN, cli, FIXTURE, tempDatabase } from './support'

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

describe('db:shell', () => {
  test('psql gets the URL without the password; the password goes through PGPASSWORD', async () => {
    const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const bin = mkdtempSync(join(tmpdir(), 'fake-psql-'))
    writeFileSync(join(bin, 'psql'), '#!/bin/sh\necho "args: $*"\necho "PGPASSWORD=$PGPASSWORD"\n')
    chmodSync(join(bin, 'psql'), 0o755)
    const proc = Bun.spawn([process.execPath, BIN, 'db:shell', '-c', 'select 1'], {
      cwd: FIXTURE,
      stdout: 'pipe',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        FIXTURE_DATABASE_URL: 'postgres://ada:s%40cret@db.test:5432/app',
      },
    })
    const out = await new Response(proc.stdout).text()
    rmSync(bin, { recursive: true, force: true })
    expect(await proc.exited).toBe(0)
    expect(out).toContain('args: postgres://ada@db.test:5432/app -c select 1')
    expect(out).toContain('PGPASSWORD=s@cret')
  })

  test.skipIf(!process.env.DATABASE_URL || !Bun.which('psql'))('runs a statement on the database', async () => {
    const proc = Bun.spawn([process.execPath, BIN, 'db:shell', '--command', 'select 41 + 1 as answer'], {
      cwd: FIXTURE,
      stdout: 'pipe',
      env: { ...process.env, FIXTURE_DATABASE_URL: db?.url },
    })
    const out = await new Response(proc.stdout).text()
    expect(await proc.exited).toBe(0)
    expect(out).toMatch(/answer\s*\n-+\s*\n\s*42/)
  })
})
