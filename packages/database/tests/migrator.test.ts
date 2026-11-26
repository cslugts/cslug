import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
// packageMigrations: [] everywhere: other test files in this process may have called addMigrations() (AuthProvider)
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { CslugError } from '@cslug/core'
import { Migrator, parseMigration, sql } from '../src'
import { describeDb, testDatabase } from './support'

describe('migration files', () => {
  test('-- up / -- down sections and the no-transaction marker', () => {
    const m = parseMigration(
      '/x/20261126_101500_create_bookings.sql',
      '-- up\ncreate table a (id int);\n\n-- down\ndrop table a;\n',
    )
    expect(m).toMatchObject({
      name: '20261126_101500_create_bookings',
      up: 'create table a (id int);',
      down: 'drop table a;',
      transaction: true,
    })
    expect(
      parseMigration(
        '/x/20261126_101500_i.sql',
        '-- cslug:no-transaction\n-- up\ncreate index concurrently i on a (id);',
      ).transaction,
    ).toBe(false)
    expect(() => parseMigration('/x/20261126_101500_bad.sql', 'create table a ();')).toThrow(/missing "-- up"/)
  })

  test('Migrator.create writes a timestamped, empty migration', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cslug-mig-'))
    const path = Migrator.create(dir, 'Add claims index', new Date('2026-11-26T14:30:00Z'))
    expect(basename(path)).toBe('20261126_143000_add_claims_index.sql')
    expect(readFileSync(path, 'utf8')).toBe('-- up\n\n\n-- down\n\n')
    rmSync(dir, { recursive: true })
  })
})

let t: Awaited<ReturnType<typeof testDatabase>>
let dir: string
const write = (name: string, text: string) => writeFileSync(join(dir, `${name}.sql`), text)
const tables = async () =>
  (
    await t.db.many(
      sql<{
        tableName: string
      }>`select table_name from information_schema.tables where table_schema = 'public' order by 1`,
    )
  ).map((r) => r.tableName)

describeDb('Migrator (real PostgreSQL)', () => {
  beforeAll(async () => {
    t = await testDatabase()
    dir = mkdtempSync(join(tmpdir(), 'cslug-mig-'))
    write(
      '20261126_120000_create_users',
      '-- up\ncreate table users (id uuid primary key, email text not null unique);\n-- down\ndrop table users;',
    )
    write(
      '20261126_120100_create_todos',
      `-- up
create table todos (id uuid primary key, user_id uuid not null references users (id), title text not null);
create function todos_count() returns bigint language sql as $$ select count(*) from todos; $$;
-- down
drop function todos_count();
drop table todos;`,
    )
  })
  afterAll(async () => {
    await t?.drop()
    rmSync(dir, { recursive: true, force: true })
  })

  test('acceptance: two concurrent migrate runs execute each migration once', async () => {
    const [a, b] = await Promise.all([
      new Migrator(t.db, { paths: [dir], packageMigrations: [] }).migrate(),
      new Migrator(t.db, { paths: [dir], packageMigrations: [] }).migrate(),
    ])
    const all = [...a, ...b].sort()
    expect(all).toEqual([
      '00000000_000000_cslug_idempotency',
      '20261126_120000_create_users',
      '20261126_120100_create_todos',
    ])
    expect(a.length === 0 || b.length === 0).toBe(true) // one did everything, the other found nothing pending
    expect(await tables()).toEqual(['cslug_idempotency', 'cslug_migrations', 'todos', 'users'])
  })

  test('status, and a second run with nothing pending', async () => {
    const m = new Migrator(t.db, { paths: [dir], packageMigrations: [] })
    expect(await m.migrate()).toEqual([])
    const status = await m.status()
    expect(status.map((s) => [s.name, s.ran, s.batch])).toEqual([
      ['00000000_000000_cslug_idempotency', true, 1],
      ['20261126_120000_create_users', true, 1],
      ['20261126_120100_create_todos', true, 1],
    ])
  })

  test('a new batch, a non-transactional migration, rollback by batch', async () => {
    write(
      '20261127_090000_index_todos',
      '-- cslug:no-transaction\n-- up\ncreate index concurrently todos_title_idx on todos (title);\n-- down\ndrop index concurrently todos_title_idx;',
    )
    const m = new Migrator(t.db, { paths: [dir], packageMigrations: [] })
    expect(await m.migrate()).toEqual(['20261127_090000_index_todos'])
    expect((await m.status()).at(-1)).toMatchObject({ ran: true, batch: 2 })
    expect(await m.rollback()).toEqual(['20261127_090000_index_todos'])
    expect(await m.rollback()).toEqual([
      '20261126_120100_create_todos',
      '20261126_120000_create_users',
      '00000000_000000_cslug_idempotency',
    ])
    expect(await tables()).toEqual(['cslug_migrations'])
    expect(await m.migrate()).toHaveLength(4)
  })

  test('a failing migration rolls back entirely and says which file', async () => {
    write(
      '20261128_000000_broken',
      '-- up\ncreate table half (id int);\ncreate table half (id int);\n-- down\ndrop table half;',
    )
    const m = new Migrator(t.db, { paths: [dir], packageMigrations: [] })
    const error = (await m.migrate().then(
      () => undefined,
      (e: unknown) => e,
    )) as CslugError
    expect(error).toBeInstanceOf(CslugError)
    expect(error.message).toMatch(/^Migration 20261128_000000_broken failed: /)
    expect(await tables()).not.toContain('half') // the first statement was rolled back too
    expect((await m.status()).find((s) => s.name === '20261128_000000_broken')?.ran).toBe(false)
    rmSync(join(dir, '20261128_000000_broken.sql'))
  })

  test('fresh is refused in production; works elsewhere', async () => {
    await expect(
      new Migrator(t.db, { paths: [dir], packageMigrations: [], env: 'production' }).fresh(),
    ).rejects.toThrow(/refused when APP_ENV=production/)
    expect(await new Migrator(t.db, { paths: [dir], packageMigrations: [], env: 'test' }).fresh()).toHaveLength(4)
  })
})
