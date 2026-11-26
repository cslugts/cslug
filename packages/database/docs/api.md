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

## Query builder (one table)

`repo.where({...})` / `repo.query()` → `Query<T, R>` (immutable).

| | |
|---|---|
| `where({ key: value \| null \| op })` | AND of conditions; `null` → IS NULL; `undefined` keys ignored (so `...(cond && {…})` works). Keys and value types are checked against the table |
| operators | `eq ne gt gte lt lte between inList notIn like ilike isNull notNull not(op)`. `inList([])` matches nothing |
| `orWhere({...})` / `whereSql(sql\`…\`)` | OR group / raw condition |
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
`delete` (soft if possible), `forceDelete`, `restore`, `lockForUpdate(id, opts)`, `paginate({ page, perPage, where, orderBy, dir })`,
`where`, `query`, `withTrashed`, `onlyTrashed`, `using(tx)` (explicit transaction), `table`, `db`.

## `preload`

`preload(rows, { operator: belongsTo(operators, 'operatorId'), todos: hasMany(todos, 'operatorId', { orderBy }) })`:
one query per relation, typed results (`Row | null` for belongsTo, `Row[]` for hasMany).
