import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Application, type Command, ConsoleIO, Logger, runInContext } from '@cslug/core'
import {
  boolean,
  type Database,
  DatabaseProvider,
  DbDiffCommand,
  diffSchemas,
  id,
  integer,
  introspect,
  MakeMigrationCommand,
  migrationSql,
  renameCandidates,
  sql,
  type Table,
  table,
  tableSpec,
  text,
  timestamps,
  uuid,
  varchar,
} from '../src'
import { authors, notes } from './fixture/app/tables/note-table'
import { DATABASE_URL, describeDb, testDatabase } from './support'

test('a new schema: tables created referenced-first, dropped in reverse', () => {
  const fresh: Table[] = [notes, authors]
  const changes = diffSchemas(fresh.map(tableSpec), [])
  expect(changes.map((c) => c.label)).toEqual(['+ table   authors', '+ table   notes'])
  const sql = migrationSql(changes)
  expect(sql).toContain(`create table notes (
  id uuid primary key,
  author_id uuid not null references authors (id) on delete cascade,
  status text not null default 'draft' check (status in ('draft', 'published')),
  body text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);
create index notes_status_idx on notes (status);`)
  expect(sql).toContain('-- down\ndrop table notes;\ndrop table authors;\n')
})

/** The fixture's `notes`, edited: what a developer changes between two migrations. */
const notesV2 = table(
  'notes',
  {
    id: id(),
    authorId: uuid().references(() => authors, { onDelete: 'cascade' }),
    status: text().oneOf(['draft', 'published', 'archived']).default('draft'), // check changed
    content: text().nullable(), // body renamed
    title: varchar(120).default('Untitled'), // added
    pinned: boolean().default(false), // added
    ...timestamps(),
  },
  { indexes: (t) => [t.index('status'), t.unique('authorId', 'title')] }, // index added
)
const tags = table('tags', { id: id(), label: text().unique(), uses: integer().default(0) })

describeDb('against PostgreSQL: every generated migration round-trips', () => {
  let t: Awaited<ReturnType<typeof testDatabase>>
  let db: Database
  beforeAll(async () => {
    t = await testDatabase()
    db = t.db
  })
  afterAll(() => t?.drop())

  const apply = async (sql: string, part: 'up' | 'down') => {
    const [up, down] = sql.split('-- down')
    await db.pool.unsafe((part === 'up' ? up : down)?.replace('-- up', '') ?? '')
  }
  const v1: Table[] = [authors, notes]
  const v2: Table[] = [authors, notesV2, tags]
  const drift = async (tables = v1) => diffSchemas(tables.map(tableSpec), await introspect(db))

  test('create: after the up migration there is no drift', async () => {
    const sql = migrationSql(await drift())
    await apply(sql, 'up')
    expect(await drift()).toEqual([])
  })

  test('changes, with a rename: up leaves no drift, down restores the previous schema', async () => {
    const desired = v2.map(tableSpec)
    const candidates = renameCandidates(desired, await introspect(db))
    expect(candidates).toEqual([{ table: 'notes', from: 'body', to: 'content' }])
    const changes = diffSchemas(desired, await introspect(db), candidates)
    expect(changes.map((c) => c.label)).toEqual([
      '+ table   tags',
      '~ column  notes.body → content',
      '+ column  notes.title character varying(120)',
      '+ column  notes.pinned boolean',
      '~ constraint notes_status_check',
      '+ index   notes_author_id_title_key',
    ])
    const migration = migrationSql(changes)
    expect(migration).toContain(
      "alter table notes add column title character varying(120) not null default 'Untitled';",
    )

    await db.exec(sql`insert into authors (id, name) values (${Bun.randomUUIDv7()}, 'Ada')`)
    await apply(migration, 'up')
    expect(await drift(v2)).toEqual([])
    await apply(migration, 'down')
    expect(await drift()).toEqual([])
  })

  test('a dropped column and a table missing from app/tables are dropped, with warnings', async () => {
    const slim = table('authors', { id: id() })
    const changes = diffSchemas([slim].map(tableSpec), await introspect(db))
    expect(changes.map((c) => [c.label, c.warning])).toEqual([
      ['- column  authors.name', 'authors.name is dropped with its data'],
      ['- constraint authors_name_key', undefined],
      ['- table   notes', 'table notes is dropped with its data (not in app/tables/)'],
    ])
  })
})

class Captured extends ConsoleIO {
  out = ''
  override write(text: string) {
    this.out += text
  }
  override error(text: string) {
    this.out += text
  }
}

describe.skipIf(!DATABASE_URL)('make:migration --from-tables and db:diff', () => {
  let t: Awaited<ReturnType<typeof testDatabase>>
  // an app root of its own: app/tables/ in, database/migrations/ out
  const root = mkdtempSync(join(tmpdir(), 'cslug-differ-'))
  mkdirSync(join(root, 'app/tables'), { recursive: true })
  writeFileSync(
    join(root, 'app/tables/claim-table.ts'),
    `import { id, table, text } from '${join(import.meta.dir, '../src')}'
export const claims = table('claims', { id: id(), title: text(), reason: text().nullable() })
`,
  )
  beforeAll(async () => {
    t = await testDatabase()
  })
  afterAll(async () => {
    await t?.drop()
    rmSync(root, { recursive: true, force: true })
  })

  /** Run a command the way the CLI kernel does (it boots unless the command says not to). */
  const run = async (cmd: (new () => Command) & { boot?: boolean }, args: Record<string, unknown>) => {
    const app = new Application({ root, configs: { database: { url: t.url }, app: { env: 'test' } } })
    app.useProviders([DatabaseProvider]).singleton(Logger, () => Logger.null())
    const io = new Captured()
    app.instance(ConsoleIO, io)
    if (cmd.boot !== false) await app.start()
    const code = await runInContext({ app, scope: app.createScope() }, () =>
      (new cmd() as unknown as { handle(a: unknown): unknown }).handle(args),
    )
    await app.shutdown()
    return { code: typeof code === 'number' ? code : 0, out: io.out }
  }

  test('db:diff shows the drift and writes nothing; make:migration writes it; then nothing is left', async () => {
    const diff = await run(DbDiffCommand, { sql: true })
    expect(diff.out).toContain('+ table   claims')
    expect(diff.out).toContain('create table claims (')
    expect(existsSync(join(root, 'database/migrations'))).toBe(false)

    const made = await run(MakeMigrationCommand, { fromTables: true })
    expect(made.code).toBe(0)
    const [file] = readdirSync(join(root, 'database/migrations'))
    expect(file).toMatch(/^\d{8}_\d{6}_create_claims\.sql$/)
    await t.db.pool.unsafe(
      readFileSync(join(root, 'database/migrations', file as string), 'utf8').split('-- down')[0] as string,
    )
    expect((await run(MakeMigrationCommand, { fromTables: true })).out).toContain('Nothing to migrate')
  })

  test('make:migration without a name or --from-tables explains', async () => {
    const { code, out } = await run(MakeMigrationCommand, {})
    expect(code).toBe(2)
    expect(out).toContain('A name, or --from-tables')
  })
})
