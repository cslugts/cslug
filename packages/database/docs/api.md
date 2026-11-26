# @cslug/database: API (M2a)

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
| `amount()` / `currency()` | `bigint` / `char(3)` | money |
| `shortCode('ALB')` | `text unique` | `ALB-7K2Q9F`, generated |
| `timestamps()` / `softDeletes()` | `created_at`, `updated_at` / `deleted_at` | `Date` / `Date \| null` |

Modifiers: `.nullable()` (columns are NOT NULL otherwise), `.default(v)`, `.defaultSql('now()')`, `.unique()`,
`.references(() => table, { onDelete })`, `.check(sql\`…\`)`.

## Tables

`table(name, columns, { indexes: (t) => [t.index('a', 'b'), t.unique('c')] })` → `Table` with:
`c.<key>` (column refs for the sql tag), `star`, `sqlNames`, `primaryKey`, `softDeletes`, `fromDb(row)`,
`toDb(values)`. Types: `Row<typeof t>`, `NewRow<typeof t>`. Keys are camelCase in TS, snake_case in SQL.

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
