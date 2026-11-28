# @cslug/database: API

## Columns

| Builder | SQL | TS type |
|---|---|---|
| `id()` | `uuid` primary key | `string`, UUIDv7 generated on insert |
| `uuid()` | `uuid` | `string` |
| `text()` / `varchar(n)` | `text` / `varchar(n)` | `string`; `.oneOf([...])` → union + CHECK |
| `integer()` / `bigint()` | | `number` / `bigint` |
| `numeric(p, s)` | | `string` (exact) |
| `boolean()` | | `boolean` |
| `date()` | `date` | `'YYYY-MM-DD'` |
| `timestamp()` | `timestamptz` | `Date` |
| `jsonb<T>()` / `translated()` | `jsonb` | `T` / `{ fr?, en?, … }` |
| `custom<T>(sqlType)` | any type (`tsvector`, `inet`…) | `T` (default `string`), as the driver returns it |
| `amount()` / `currency()` | `bigint` / `char(3)` | money |
| `shortCode('ALB')` | `text unique` | `ALB-7K2Q9F`, generated |
| `timestamps()` / `softDeletes()` | `created_at`, `updated_at` / `deleted_at` | `Date` / `Date \| null` |

Modifiers: `.nullable()` (columns are NOT NULL otherwise), `.default(v)`, `.defaultSql('now()')`, `.unique()`,
`.references(() => table, { onDelete })`, `.check(sql\`…\`)`, `.generatedAs((c) => sql)` (`generated always as (…)
stored`; `c(key)` quotes a sibling's SQL name; never written by inserts or updates; not in `NewRow`), `.hidden()` (left
out of selects, `RETURNING` and `Row`). Types: `Generated`, `Hidden`.

## Tables

`table(name, columns, { indexes: (t) => [t.index('a', 'b'), t.unique('c'), t.using('gin', 'search'),
t.using('gin', ['name', 'gin_trgm_ops'])] })` → `Table` with: `c.<key>` (column refs for the sql tag), `star`,
`selection` (`star`, or the visible columns when some are hidden), `generatedSql`, `sqlNames`, `primaryKey`,
`softDeletes`, `fromDb(row, extras?)`, `toDb(values)` (generated columns skipped). `IndexDef` has `using` and `ops`
(an operator class per column, `null` for the default). Types: `Row<typeof t>`, `NewRow<typeof t>`. Keys are camelCase in TS, snake_case in SQL.

Reading converts driver values: `date` → `'YYYY-MM-DD'`, `bigint` → bigint, `numeric` → string, `char(n)` trimmed.

## The `sql` tag

| | |
|---|---|
| `` sql`… ${value} …` `` | Values become `$n` parameters; tables and column refs become quoted identifiers; fragments nest |
| `sql.join(items, separator?)` | `in (${sql.join(ids)})` → `in ($1, $2, $3)` (Bun.sql has no array parameters) |
| `sql.ident('name')` | Quoted identifier |
| `sql.raw('desc')` | Trusted constant text |
| `sql.json(value)` | jsonb parameter (`($n::text)::jsonb`; bigint as string) |
| `fragment.compile()` | `{ text, params }` |

## `Database`

| | |
|---|---|
| `new Database({ url, pool?: { max, idleTimeout, connectTimeout }, slowQueryMs? }, logger?)` | `Bun.sql` pool with `bigint: true` |
| `many(q, table?)` / `one(q, table?)` / `maybeOne(q, table?)` | Rows typed by the table, or camelCased; `one` throws `RowCountError` unless exactly one |
| `value(q)` / `exec(q)` | First column of the first row / affected rows |
| `transaction(fn, { isolation?, retry? })` | Ambient: every `db` call inside uses it; nested = savepoint; `retry` on 40001/40P01 |
| `afterCommit` | `tx.afterCommit(fn)`, or core's `afterCommit(fn)`: runs after the outermost commit, never on rollback; hooks of a failed savepoint are dropped |
| `withoutTransaction(fn)` | Run on the pool inside a transaction |
| `advisoryLock(key, fn)` | Cluster-wide mutex (xact lock inside a transaction, session lock on a reserved connection outside) |
| `ping()` / `close()` | |
| `current` | The transaction open in this context |

Postgres aggregate types apply: `count(*)` is bigint (cast `::int`), `sum(bigint)` is numeric (cast `::bigint`).

**Implementation note:** `Bun.sql` runs `begin()`/`savepoint()` callbacks outside the caller's async context;
`transaction()` re-enters the context (and sets `tx` in it), so request ids, locale and the transaction itself are
visible inside. Tested with 200 concurrent units.

## Errors

`QueryError` (`sqlState`, `constraint`, original error as `cause`, SQL text but never parameters in the message),
`UniqueViolationError` (23505), `SerializationError` (40001/40P01), `RowCountError`.

## `DatabaseProvider`

Binds `Database` from `config('database')`, pings at boot, closes at shutdown.

## Query builder (one table)

`repo.where({...})` / `repo.query()` → `Query<T, R>` (immutable).

| | |
|---|---|
| `where({ key: value \| null \| op })` | AND of conditions; `null` → IS NULL; `undefined` keys ignored (so `...(cond && {…})` works). Keys and value types are checked against the table |
| operators | `eq ne gt gte lt lte between inList notIn like ilike isNull notNull not(op)`. `inList([])` matches nothing |
| `orWhere({...})` / `whereSql(sql\`…\`)` | OR group / raw condition |
| `orderBySql(sql\`…\`)` | A raw sort term, after the others |
| `selectSql(name, sql<V>\`…\`)` | A computed value on each row: `Query<T, R & { name: V }>` (as the driver returns it) |
| `orderBy(key, 'asc' \| 'desc', { nulls: 'first' \| 'last' })` | Chainable |
| `limit`, `offset`, `select(...keys)` | `select` narrows the row type to `Pick<Row, K>` |
| `lockForUpdate({ skipLocked?, noWait? })` | Must be inside a transaction (clear error otherwise) |
| `withTrashed()` / `onlyTrashed()` | Soft-deleted rows are hidden by default when the table has `deletedAt` |
| `all()`, `first()`, `count()`, `exists()` | |
| `update(values)` / `delete()` / `forceDelete()` | Bulk; return the number of rows; `updatedAt` refreshed; `delete` is soft when possible |
| `paginate(page, perPage)` | `{ data, meta: { page, perPage, total, lastPage } }` |
| `cursor({ after?, limit, orderBy? })` | Keyset pagination → `{ data, next }` |
| `each({ batch? })` | Async iterator over every matching row |
| `toSql()` | The SELECT as a fragment |

## `Repository(table)`

```ts
@inject()
export class BookingRepository extends Repository(bookings) { /* domain queries */ }
```

The base resolves `Database` itself. Methods: `find`, `findOrFail` (`NotFoundError`, code `<singular>.not_found`),
`findBy`, `findByOrFail`, `existsBy`, `count`, `all`, `create` / `createMany` (generated ids, short codes,
timestamps, defaults; `RETURNING *`), `update(id, values)`, `upsert(values, { conflict, update? })`,
`delete` (soft if possible), `forceDelete`, `restore`, `lockForUpdate(id, opts)`, `transition(id, field, machine, to, fn?)` (lock, return unchanged if already `to`, `machine.transition` with its hooks, then `fn(row, from)`; ambient or own transaction), `paginate({ page, perPage, where, orderBy, dir })`,
`where`, `query`, `withTrashed`, `onlyTrashed`, `using(tx)` (explicit transaction), `table`, `db`.

## `preload`

`preload(rows, { operator: belongsTo(operators, 'operatorId'), todos: hasMany(todos, 'operatorId', { orderBy }) })`:
one query per relation, typed results (`Row | null` for belongsTo, `Row[]` for hasMany).

## Migrations

SQL files `database/migrations/YYYYMMDD_HHMMSS_name.sql` with `-- up` / `-- down` sections (several statements
and `$$` bodies are fine). A first line `-- cslug:no-transaction` runs the file outside a transaction (needed for
`create index concurrently`).

| `Migrator(db, { paths?, env?, log?, packageMigrations? })` | `packageMigrations` defaults to the folders added with `addMigrations()` |
|---|---|
| `migrate()` | Pending migrations, each in its own transaction, recorded in `cslug_migrations` with a batch number. The whole run holds an advisory lock: concurrent runs execute each migration **once** |
| `rollback({ steps? })` | Undo the last `steps` batches (default 1), newest first; fails clearly without a `-- down` |
| `status()` | `{ name, ran, batch?, ranAt? }[]` |
| `fresh()` | Drop the public schema and migrate; **refused when `env` is `production`** |
| `Migrator.create(dir, name)` | Writes an empty, timestamped file |
| `FRAMEWORK_MIGRATIONS` | cslug's own (e.g. `cslug_idempotency`), always run first |

A failing migration is rolled back entirely and the error names the file.

`cslug db:shell` opens `psql` on `config database.url` (`-c` / `--command` runs one statement). The password is
passed through `PGPASSWORD`, not on the command line.

### The table differ

`cslug make:migration --from-tables` compares `app/tables/` with the database and writes the SQL; `cslug db:diff`
prints the same changes (and the SQL with `--sql`) without writing a file.

| | |
|---|---|
| `loadTables(rootDir)` | The tables `app/tables/` exports |
| `tableSpec(table)` / `introspect(db)` | Both sides in one shape (`TableSpec`): columns (type as `format_type()` reports it, nullability, default, generated expression + hash), unique, check (`oneOf`) and foreign-key constraints, indexes (columns, method, operator classes). `introspect` reads the `public` schema and skips `cslug_*` tables (packages migrate those) |
| `renameCandidates(desired, actual)` | A column in the database only and one in the tables only, same table and type: maybe a rename (the command asks; without a terminal it assumes a rename, which keeps the data) |
| `diffSchemas(desired, actual, renames?)` | `Change[]` (`{ table, label, up, down, warning? }`): new tables (referenced ones first), added / dropped / renamed columns, type, nullability and default changes, generated expressions (`set expression`, from the hash in the column comment; a column that becomes or stops being generated is dropped and added again, with its indexes), constraints and indexes compared by name and definition (method and operator classes included), dropped tables |
| `migrationSql(changes)` | `-- up` in order, `-- down` in reverse |

Constraint names follow PostgreSQL's defaults (`t_col_key`, `t_col_fkey`, `t_col_check`), so a table created by a
generated migration diffs clean; a rename also renames the column's constraints and indexes. Changes that can lose
data or fail on existing rows (a dropped column or table, a type change, `not null` without a default) are listed as
`-- review:` comments at the top of the file. Anything else (views, triggers, data migrations, custom `check()`) is
hand-written SQL.

## Factories and seeders

```ts
export const TodoFactory = factory(todos, ({ seq, fake, clock }) => ({
  userId: () => UserFactory.create().then((u) => u.id),   // lazy, may be async
  title: `Todo ${seq}`,
})).state('done', ({ clock }) => ({ completedAt: clock.now() }))

await TodoFactory.for({ userId: me.id }).state('done').createMany(3)
await TodoFactory.make()                                   // attributes only
await TodoFactory.on(db).create()                          // a specific database
```

`fake` (`Fake`, seeded, deterministic): `name firstName lastName company email word words sentence int bool pick
digits phone(country) date(from, to) passwordHash(plain)`. `seeder(async () => …)` marks a seeder for `cslug db:seed`.

## `db.idempotent(key, fn, { scope? })`

Runs `fn` once per key under an advisory lock; the result is stored as JSON and every call, the first one
included, returns it as `Json<T>` (bigint and Date as strings). Inside a transaction the record commits or rolls
back with your changes.

## Encrypted columns

`text().encrypted()`: AES-256-GCM, key derived from `APP_KEY` (set by `DatabaseProvider` from `config('app.key')`,
or `setEncryptionKey()`), random IV per value, stored as `v1.<iv>.<tag>.<ciphertext>`. Decrypted on read; using
the column in `where` throws (random IVs make it unsearchable). A wrong key fails loudly (`db.decrypt_failed`).
